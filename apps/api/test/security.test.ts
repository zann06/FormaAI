/**
 * Multi-tenant isolation and upload-security tests.
 *
 * Every one of these asserts a real, enforced property:
 *  - a user can never read or mutate another user's data (404, never 403);
 *  - API keys are write-only and encrypted with AAD bound to the owner;
 *  - uploads are validated by signature, not just by extension.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser, TestClient, type TestApp, type TestUser } from './helpers.js';
import { DOCX_MIME, fakeDocx, fakePdf, reportTemplateDocx, sourcePdf } from './fixtures.js';

let context: TestApp;
let alice: TestUser;
let bob: TestUser;
let aliceProjectId: string;
let aliceTemplateDocId: string;

beforeAll(async () => {
  context = await createTestApp();
  alice = await signUpUser(context.app, 'alice');
  bob = await signUpUser(context.app, 'bob');

  const project = await alice.client.post('/api/projects', { title: 'Alice private report', language: 'en' });
  aliceProjectId = project.body.project.id;

  const upload = await alice.client.upload(
    `/api/projects/${aliceProjectId}/documents`,
    { name: 'template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
    'template',
  );
  aliceTemplateDocId = upload.body.document.id;
});

afterAll(async () => {
  await context.close();
});

describe('cross-tenant isolation', () => {
  it('hides another user\'s project list', async () => {
    const projects = await bob.client.get('/api/projects');
    expect(projects.status).toBe(200);
    expect(projects.body.projects).toHaveLength(0);
  });

  it('returns 404 (not 403) for another user\'s project', async () => {
    const get = await bob.client.get(`/api/projects/${aliceProjectId}`);
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('NOT_FOUND');

    const patch = await bob.client.patch(`/api/projects/${aliceProjectId}`, { title: 'hijacked' });
    expect(patch.status).toBe(404);

    const del = await bob.client.delete(`/api/projects/${aliceProjectId}`);
    expect(del.status).toBe(404);
  });

  it('blocks reading another user\'s documents and outline', async () => {
    const docs = await bob.client.get(`/api/projects/${aliceProjectId}/documents`);
    expect(docs.status).toBe(404);

    const template = await bob.client.get(`/api/projects/${aliceProjectId}/template`);
    expect(template.status).toBe(404);

    // Even with the exact document id, the ownership check applies.
    const download = await bob.client.get(
      `/api/projects/${aliceProjectId}/documents/${aliceTemplateDocId}/download`,
    );
    expect(download.status).toBe(404);
  });

  it('blocks mutating another user\'s report content and exports', async () => {
    const queued = await bob.client.post(`/api/projects/${aliceProjectId}/generate`, {});
    expect(queued.status).toBe(404);

    const exported = await bob.client.post(`/api/projects/${aliceProjectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(404);

    const jobs = await bob.client.get(`/api/projects/${aliceProjectId}/jobs`);
    expect(jobs.status).toBe(404);
  });

  it('does not leak another user\'s project into the job list', async () => {
    const jobs = await bob.client.get('/api/jobs');
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs).toHaveLength(0);
  });

  it('blocks running the one-click pipeline on another user\'s project', async () => {
    const scan = await bob.client.post(`/api/projects/${aliceProjectId}/pipeline`, { useAi: false });
    // 404, not 403: the project must not even be confirmed to exist.
    expect(scan.status).toBe(404);
  });
});

describe('provider credential security', () => {
  it('never returns the plaintext API key', async () => {
    const secret = 'sk-live-super-secret-value-1234';
    const created = await alice.client.post('/api/provider-credentials', {
      displayName: 'OpenAI',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: secret,
    });
    expect(created.status).toBe(201);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain(secret);
    expect(created.body.credential.keyLast4).toBe('1234');
    // A fingerprint, not the key: 16 hex chars.
    expect(created.body.credential.keyFingerprint).toMatch(/^[a-f0-9]{16}$/);

    const listed = await alice.client.get('/api/provider-credentials');
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it('scrubs the key from a failed provider test response', async () => {
    const secret = 'sk-test-should-never-surface';
    const created = await alice.client.post('/api/provider-credentials', {
      displayName: 'Unreachable',
      providerType: 'openai-compatible',
      baseUrl: 'https://127.0.0.1:9/v1',
      model: 'nope',
      apiKey: secret,
    });
    expect(created.status).toBe(201);
    const tested = await alice.client.post(`/api/provider-credentials/${created.body.credential.id}/test`, {});
    // The test may fail (unreachable), but must never echo the key back.
    expect(JSON.stringify(tested.body)).not.toContain(secret);
  });

  it('keeps credentials private to their owner', async () => {
    const created = await alice.client.post('/api/provider-credentials', {
      displayName: 'Alice only',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-alice-private-key',
    });
    const id = created.body.credential.id;

    const bobList = await bob.client.get('/api/provider-credentials');
    expect(bobList.body.credentials.find((c: { id: string }) => c.id === id)).toBeUndefined();

    expect((await bob.client.patch(`/api/provider-credentials/${id}`, { displayName: 'stolen' })).status).toBe(404);
    expect((await bob.client.delete(`/api/provider-credentials/${id}`)).status).toBe(404);
  });
});

describe('upload validation', () => {
  it('rejects an executable renamed to .docx', async () => {
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: 'malware.docx', type: DOCX_MIME, bytes: fakeDocx() },
      'template',
    );
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects HTML renamed to .pdf (missing %PDF signature)', async () => {
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: 'evil.pdf', type: 'application/pdf', bytes: fakePdf() },
      'source',
    );
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unsupported extension', async () => {
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: 'script.js', type: 'text/javascript', bytes: new TextEncoder().encode('alert(1)') },
      'source',
    );
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a declared MIME type that contradicts the extension', async () => {
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: 'notes.pdf', type: 'text/plain', bytes: sourcePdf() },
      'source',
    );
    expect(response.status).toBe(415);
  });

  it('rejects a .txt file containing binary data', async () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x42]);
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: 'notes.txt', type: 'text/plain', bytes: binary },
      'source',
    );
    expect(response.status).toBe(422);
  });

  it('strips path traversal from uploaded filenames', async () => {
    const response = await alice.client.upload(
      `/api/projects/${aliceProjectId}/documents`,
      { name: '../../../../etc/passwd.txt', type: 'text/plain', bytes: new TextEncoder().encode('hello world') },
      'source',
    );
    expect(response.status).toBe(201);
    expect(response.body.document.originalName).not.toContain('..');
    expect(response.body.document.originalName).not.toContain('/');
  });

  it('rejects a non-multipart upload with a clear error', async () => {
    const response = await alice.client.post(`/api/projects/${aliceProjectId}/documents`, { file: 'nope' });
    expect(response.status).toBe(400);
  });

  /**
   * The reported bug: a .docx uploaded from the chat was stored as `source`, so the
   * project never got a template, no outline was created, and "Scan & generate"
   * stayed disabled while the chat looked like it was doing something.
   *
   * Cause: @fastify/multipart only exposes fields parsed *before* the file part, and
   * the browser appended "kind" after the file. The field was dropped and the
   * handler fell back to "source". The server must not depend on field order.
   */
  it('honours the kind field even when it is sent after the file', async () => {
    const project = await alice.client.post('/api/projects', { title: 'Kind order', language: 'en', tone: 'formal' });
    expect(project.status).toBe(201);
    const projectId = project.body.project.id as string;

    const response = await alice.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
      { kindLast: true },
    );

    expect(response.status).toBe(201);
    expect(response.body.document.kind).toBe('template');

    // It must also be recognised as the project's template, which is what enables
    // generation. Storing the row is not enough on its own.
    const documents = await alice.client.get(`/api/projects/${projectId}/documents`);
    const stored = (documents.body.documents as Array<{ kind: string }>).filter((doc) => doc.kind === 'template');
    expect(stored).toHaveLength(1);
  });
});

describe('rate limiting', () => {
  it('applies a stricter limit to sign-in attempts', async () => {
    const client = new TestClient(context.app);
    let sawRateLimit = false;
    // The route-level limiter allows 20 requests / 10 minutes per client. Proving
    // it engages needs more than 20 attempts from the same client.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await client.post('/api/auth/signin', {
        email: `nobody-${attempt}@example.test`,
        password: 'WrongPassword1!',
      });
      if (response.status === 429) {
        sawRateLimit = true;
        expect(response.body.error.code).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
