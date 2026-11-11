/**
 * End-to-end pipeline over the real HTTP surface:
 *   template upload → outline → source extraction → evidence mapping →
 *   section generation (dev-offline provider) → DOCX export → fidelity checks.
 *
 * The `dev-offline` provider is a deterministic, non-network adapter that is
 * explicitly gated behind ENABLE_DEV_PROVIDER, so nothing here fakes a vendor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDocxPackage, xmlToString } from '@formaai/docx-engine';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { DOCX_MIME, reportTemplateDocx, sourcePdf, sourceTxt } from './fixtures.js';

let context: TestApp;
let user: TestUser;

beforeAll(async () => {
  context = await createTestApp();
  user = await signUpUser(context.app, 'pipeline');
});

afterAll(async () => {
  await context.close();
});

async function waitForJob(projectId: string, jobId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await context.drainQueue();
    const result = await user.client.get(`/api/projects/${projectId}/jobs/${jobId}`);
    if (result.status !== 200) throw new Error(`job lookup failed: ${result.status}`);
    const status = result.body.job.status;
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return result.body.job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('job did not finish');
}

describe('report pipeline', () => {
  let projectId: string;

  it('creates a project', async () => {
    const created = await user.client.post('/api/projects', {
      title: 'Q1 2025 Quarterly Activity Report',
      reportType: 'quarterly_report',
      language: 'en',
      targetLength: 'medium',
    });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
    expect(created.body.project.title).toBe('Q1 2025 Quarterly Activity Report');
  });

  it('uploads and analyses a DOCX template into outline sections', async () => {
    const upload = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'quarterly-template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    expect(upload.status).toBe(201);
    expect(upload.body.document.status).toBe('uploaded');

    const job = await waitForJob(projectId, upload.body.jobId);
    expect(job.status).toBe('succeeded');
    expect(job.result.sections).toBeGreaterThan(0);

    const outline = await user.client.get(`/api/projects/${projectId}/template`);
    expect(outline.status).toBe(200);
    const headings = outline.body.sections.map((s: { heading: string }) => s.heading);
    expect(headings).toContain('1. Introduction');
    expect(headings).toContain('2.1 Participant Breakdown');
    // Header/footer were detected in the template structure.
    expect(outline.body.structure.hasHeaders).toBe(true);
    expect(outline.body.structure.hasFooters).toBe(true);
  });

  it('uploads source documents and extracts searchable text', async () => {
    const pdf = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'source-notes.pdf', type: 'application/pdf', bytes: sourcePdf() },
      'source',
    );
    expect(pdf.status).toBe(201);
    const pdfJob = await waitForJob(projectId, pdf.body.jobId);
    expect(pdfJob.status).toBe('succeeded');
    expect(pdfJob.result.chunks).toBeGreaterThan(0);

    const txt = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'conclusion.txt', type: 'text/plain', bytes: sourceTxt() },
      'source',
    );
    expect(txt.status).toBe(201);
    expect((await waitForJob(projectId, txt.body.jobId)).status).toBe('succeeded');

    const documents = await user.client.get(`/api/projects/${projectId}/documents`);
    const sourceDocs = documents.body.documents.filter((d: { kind: string }) => d.kind === 'source');
    expect(sourceDocs).toHaveLength(2);
    expect(sourceDocs.every((d: { status: string }) => d.status === 'extracted')).toBe(true);
  });

  it('maps evidence to sections without inventing citations', async () => {
    const queued = await user.client.post(`/api/projects/${projectId}/mapping`, { useAi: false });
    expect(queued.status).toBe(202);
    const job = await waitForJob(projectId, queued.body.jobId);
    expect(job.status).toBe('succeeded');

    const mapping = await user.client.get(`/api/projects/${projectId}/mapping`);
    expect(mapping.status).toBe(200);
    expect(mapping.body.mappings.length).toBeGreaterThan(0);
    for (const section of mapping.body.mappings) {
      expect(section.evidence).toBeInstanceOf(Array);
      expect(section.coverage).toMatch(/^(strong|partial|none)$/);
      // Every evidence excerpt must come from an uploaded source document.
      for (const item of section.evidence) {
        expect(['source-notes.pdf', 'conclusion.txt']).toContain(item.documentName);
      }
    }
  });

  it('generates report sections from the mapped evidence', async () => {
    const created = await user.client.post('/api/provider-credentials', {
      displayName: 'Local dev provider',
      providerType: 'dev-offline',
      model: 'dev-offline-model',
      apiKey: 'dev-key-not-a-real-secret',
      isDefault: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.credential.keyLast4).toBeTruthy();
    // The plaintext key must never be echoed back.
    expect(JSON.stringify(created.body)).not.toContain('dev-key-not-a-real-secret');

    const queued = await user.client.post(`/api/projects/${projectId}/generate`, { regenerateExisting: true });
    expect(queued.status).toBe(202);
    const job = await waitForJob(projectId, queued.body.jobId);

    const report = await user.client.get(`/api/projects/${projectId}/report`);
    expect(report.status).toBe(200);
    const withContent = report.body.sections.filter((s: { content: string }) => s.content.trim().length > 0);
    if (job.status === 'failed') {
      throw new Error(`generation failed: ${job.errorMessage}`);
    }
    expect(withContent.length).toBeGreaterThan(0);
  });

  it('refuses to export PDF when no converter is configured', async () => {
    const response = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'pdf' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PDF_CONVERTER_NOT_CONFIGURED');
  });

  it('produces a fidelity-preserving DOCX from a copy of the template', async () => {
    const requested = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(requested.status).toBe(202);
    const job = await waitForJob(projectId, requested.body.jobId);
    expect(job.status).toBe('succeeded');

    const download = await user.client.bytes(
      'GET',
      `/api/projects/${projectId}/exports/${requested.body.exportId}/download`,
    );
    expect(download.status).toBe(200);
    expect(String(download.headers['content-type'])).toContain('wordprocessingml');
    expect(download.body.byteLength).toBeGreaterThan(1000);

    const templatePkg = readDocxPackage(reportTemplateDocx());
    const exportedPkg = readDocxPackage(new Uint8Array(download.body));

    // 1. Every non-document part must be byte-identical to the template.
    for (const name of Object.keys(templatePkg.files)) {
      if (name === 'word/document.xml') continue;
      const original = Buffer.from(templatePkg.files[name]!);
      const produced = Buffer.from(exportedPkg.files[name]!);
      expect(produced.equals(original), `part ${name} changed`).toBe(true);
    }

    // 2. The document part keeps its structure and contains generated text.
    const exportedXml = xmlToString(exportedPkg.files['word/document.xml']!);
    expect(exportedXml).toContain('1. Introduction');
    expect(exportedXml).toContain('2.1 Participant Breakdown');
    // Placeholders are replaced, not left behind.
    expect(exportedXml).not.toContain('{{content_introduction}}');

    const listed = await user.client.get(`/api/projects/${projectId}/exports`);
    const ready = listed.body.exports.find((e: { status: string }) => e.status === 'ready');
    expect(ready).toBeTruthy();
    expect(listed.body.pdfAvailable).toBe(false);
  });
});
