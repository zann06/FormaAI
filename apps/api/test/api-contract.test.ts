import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { DOCX_MIME, reportTemplateDocx, sourceTxt } from './fixtures.js';

/**
 * Contract checks for the response shapes documented in
 * `docs/API_DOCUMENTATION.md`.
 *
 * These are deliberately shallow: they assert the fields the documentation
 * promises exist and have the documented types. If a route's shape drifts from
 * the docs, one of these fails, which keeps the documentation honest.
 */
let context: TestApp;
let user: TestUser;
let projectId: string;

beforeAll(async () => {
  context = await createTestApp();
  user = await signUpUser(context.app, 'contract');
  projectId = (await user.client.post('/api/projects', { title: 'Contract Report' })).body.project.id;

  await user.client.upload(
    `/api/projects/${projectId}/documents`,
    { name: 'template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
    'template',
  );
  await context.drainQueue();

  await user.client.upload(
    `/api/projects/${projectId}/documents`,
    { name: 'source.txt', type: 'text/plain', bytes: sourceTxt() },
    'source',
  );
  await context.drainQueue();

  await user.client.post(`/api/projects/${projectId}/mapping`, {});
  await context.drainQueue();
});

afterAll(async () => {
  await context.close();
});

describe('documented API contracts', () => {
  it('GET /api/auth/session returns the documented user fields', async () => {
    const res = await user.client.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: expect.any(String),
      email: expect.any(String),
      role: expect.any(String),
    });
    expect(res.body).toHaveProperty('fallbackCredentialId');
    expect(typeof res.body.registrationEnabled).toBe('boolean');
  });

  it('GET /api/auth/signup-availability returns registrationEnabled', async () => {
    const res = await user.client.get('/api/auth/signup-availability');
    expect(res.status).toBe(200);
    expect(typeof res.body.registrationEnabled).toBe('boolean');
  });

  it('GET /api/projects returns the documented summary fields', async () => {
    const res = await user.client.get('/api/projects');
    expect(res.status).toBe(200);
    const project = res.body.projects.find((p: { id: string }) => p.id === projectId);
    expect(project).toMatchObject({
      title: 'Contract Report',
      templateReady: expect.any(Boolean),
      mappingReady: expect.any(Boolean),
      documentCount: expect.any(Number),
      sourceCount: expect.any(Number),
    });
  });

  it('GET /api/projects/:id/documents returns the documented document fields', async () => {
    const res = await user.client.get(`/api/projects/${projectId}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.documents[0]).toMatchObject({
      id: expect.any(String),
      kind: expect.any(String),
      originalName: expect.any(String),
      mimeType: expect.any(String),
      sizeBytes: expect.any(Number),
      status: expect.any(String),
    });
  });

  it('GET /api/projects/:id/mapping returns mappings, gaps and facts', async () => {
    const res = await user.client.get(`/api/projects/${projectId}/mapping`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mappings');
    expect(res.body).toHaveProperty('gaps');
    expect(res.body).toHaveProperty('facts');
    expect(res.body.mappings[0]).toMatchObject({
      sectionId: expect.any(String),
      heading: expect.any(String),
      requirements: expect.any(Array),
      evidence: expect.any(Array),
      gaps: expect.any(Array),
      conflicts: expect.any(Array),
      contentPlan: expect.any(Array),
      coverage: expect.stringMatching(/^(strong|partial|none)$/),
      producedBy: expect.stringMatching(/^(heuristic|ai)$/),
    });
  });

  it('PATCH mapping accepts the documented correction fields', async () => {
    const mappings = (await user.client.get(`/api/projects/${projectId}/mapping`)).body.mappings;
    const res = await user.client.patch(`/api/projects/${projectId}/mapping/${mappings[0].sectionId}`, {
      purpose: 'Corrected purpose.',
      requirements: ['State the period covered.'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/projects/:id/report returns outline, sections and versions', async () => {
    const res = await user.client.get(`/api/projects/${projectId}/report`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.outline)).toBe(true);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(typeof res.body.sections).toBe('object');
  });

  it('GET /api/projects/:id/template returns template, structure, sections, latestJob', async () => {
    const res = await user.client.get(`/api/projects/${projectId}/template`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('template');
    expect(res.body).toHaveProperty('structure');
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body).toHaveProperty('latestJob');
  });

  it('GET /api/provider-credentials never exposes the stored key', async () => {
    await user.client.post('/api/provider-credentials', {
      displayName: 'Contract',
      providerType: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'sk-contract-secret-value',
    });
    const res = await user.client.get('/api/provider-credentials');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('supportedTypes');
    expect(typeof res.body.devProviderEnabled).toBe('boolean');
    expect(JSON.stringify(res.body)).not.toContain('sk-contract-secret-value');
    expect(res.body.credentials[0]).toMatchObject({ keyLast4: expect.any(String), model: 'test-model' });
  });

  it('GET /api/usage returns windowDays, totals and byModel', async () => {
    const res = await user.client.get('/api/usage');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.summary).toMatchObject({
      windowDays: expect.any(Number),
      totals: expect.any(Object),
      byModel: expect.any(Array),
    });
  });

  it('GET /api/projects/:id/exports reports pdfAvailable and retentionDays', async () => {
    const res = await user.client.get(`/api/projects/${projectId}/exports`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.exports)).toBe(true);
    expect(typeof res.body.pdfAvailable).toBe('boolean');
    expect(typeof res.body.retentionDays).toBe('number');
  });

  it('GET /api/health exposes the documented feature flags', async () => {
    const res = await context.app.inject({ method: 'GET', url: '/api/health' });
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.features).toMatchObject({
      pdfConversion: expect.any(Boolean),
      ocr: expect.any(Boolean),
      devProvider: expect.any(Boolean),
      registration: expect.any(Boolean),
    });
  });
});
