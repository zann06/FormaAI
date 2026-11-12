import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { DOCX_MIME, reportTemplateDocx } from './fixtures.js';

/**
 * The Preview tab renders the report to real page images so the user can see the
 * exported document instead of trusting a textarea. These tests cover the happy
 * path, the "no renderer configured" answer, and that one user cannot preview
 * another user's report.
 */
let context: TestApp;
let user: TestUser;

beforeAll(async () => {
  context = await createTestApp();
  user = await signUpUser(context.app, 'preview');
});

afterAll(async () => {
  await context.close();
});

/**
 * Jobs only advance when the test harness drains the queue, so polling without
 * draining would wait forever. Mirrors the helper used by the pipeline tests.
 */
async function waitForJob(projectId: string, jobId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await context.drainQueue();
    const response = await user.client.get(`/api/projects/${projectId}/jobs/${jobId}`);
    if (response.status !== 200) throw new Error(`job lookup failed: ${response.status}`);
    const job = response.body.job;
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job did not finish in time');
}

describe('page preview', () => {
  /**
   * The test host has no LibreOffice, so these assert the contract that holds in
   * every environment: a preview is either rendered or refused with a reason the
   * user can act on — never a 500, and never a leak about someone else's project.
   * The actual rendering is exercised against the real container stack.
   */
  it('answers with a renderable contract or an actionable refusal', async () => {
    const project = await user.client.post('/api/projects', { title: 'Preview report', language: 'en' });
    const projectId = project.body.project.id;

    const template = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'preview-template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    expect((await waitForJob(projectId, template.body.jobId)).status).toBe('succeeded');

    const preview = await user.client.get(`/api/projects/${projectId}/preview`);
    expect([200, 501, 409]).toContain(preview.status);

    if (preview.status === 501) {
      expect(preview.body.error.code).toBe('PREVIEW_UNAVAILABLE');
      expect(preview.body.error.message).toMatch(/LibreOffice/i);
    } else if (preview.status === 200) {
      expect(preview.body.pageCount).toBeGreaterThan(0);
      expect(preview.body.totalPages).toBeGreaterThanOrEqual(preview.body.pageCount);
      const [firstPage] = preview.body.pages;
      expect(firstPage.page).toBe(1);
      expect(firstPage.image.startsWith('data:image/png;base64,')).toBe(true);
      const bytes = Buffer.from(firstPage.image.split(',')[1], 'base64');
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.byteLength).toBeGreaterThan(3000);
    }
  });

  it('does not ask pdf.js for browser-only font handling', async () => {
    // Regression guard: asking pdf.js to draw text through CSS @font-face, or to
    // fall back to platform fonts, are browser-only options. Under Node every
    // glyph rendered as a notdef box (□) even with fonts embedded in the PDF,
    // which made the whole preview unreadable. Asserting the source keeps those
    // options from being reintroduced on a machine where the tests cannot run
    // LibreOffice to catch it visually.
    const source = await readFile(new URL('../src/services/export/preview.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/disableFontFace\s*:\s*false/);
    expect(source).not.toMatch(/useSystemFonts\s*:\s*true/);
  });

  it('refuses to preview another user\'s project before checking the renderer', async () => {
    const owner = await signUpUser(context.app, 'preview-owner');
    const project = await owner.client.post('/api/projects', { title: 'Private preview', language: 'en' });
    const projectId = project.body.project.id;

    const intruder = await signUpUser(context.app, 'preview-intruder');
    const preview = await intruder.client.get(`/api/projects/${projectId}/preview`);
    // 404, not 403 and not 501: the project's existence is never confirmed, even
    // on a server with no converter configured.
    expect(preview.status).toBe(404);
  });

  it('refuses an unknown project without revealing whether a renderer exists', async () => {
    const preview = await user.client.get('/api/projects/11111111-1111-4111-8111-111111111111/preview');
    expect(preview.status).toBe(404);
  });

  it('explains when there is no template to preview', async () => {
    const project = await user.client.post('/api/projects', { title: 'No template preview', language: 'en' });
    const preview = await user.client.get(`/api/projects/${project.body.project.id}/preview`);
    // Either "no renderer" (501) or "no template" (409) — both are actionable.
    expect([409, 501]).toContain(preview.status);
    expect(preview.body.error.message).toMatch(/template|LibreOffice/i);
  });
});
