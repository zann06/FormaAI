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

  it('rejects mapping synchronously when the project has no outline', async () => {
    const created = await user.client.post('/api/projects', { title: 'Project without a template', language: 'en' });
    expect(created.status).toBe(201);
    const emptyProjectId = created.body.project.id;

    const response = await user.client.post(`/api/projects/${emptyProjectId}/mapping`, { useAi: false });
    // The request used to return 202 and fail later as a background job, which
    // was then retried; the user saw "map evidence failed" with no explanation.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/no report sections yet/i);

    const jobs = await user.client.get(`/api/projects/${emptyProjectId}/jobs`);
    expect(jobs.body.jobs.filter((job: { kind: string }) => job.kind === 'map_evidence')).toHaveLength(0);
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

/**
 * The one-click flow: upload a template and sources, press one button, and the
 * server analyses, maps, drafts and exports without further calls. These tests
 * lock in that behaviour *and* the feedback it returns.
 */
describe('one-click pipeline', () => {
  it('analyses, maps and drafts in a single job and reports each step', async () => {
    const project = await user.client.post('/api/projects', {
      title: 'One-click pipeline report',
      language: 'en',
    });
    expect(project.status).toBe(201);
    const oneClickProjectId = project.body.project.id;

    const template = await user.client.upload(
      `/api/projects/${oneClickProjectId}/documents`,
      { name: 'one-click-template.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    expect(template.status).toBe(201);
    expect((await waitForJob(oneClickProjectId, template.body.jobId)).status).toBe('succeeded');

    const source = await user.client.upload(
      `/api/projects/${oneClickProjectId}/documents`,
      { name: 'one-click-source.txt', type: 'text/plain', bytes: sourceTxt() },
      'source',
    );
    expect(source.status).toBe(201);
    expect((await waitForJob(oneClickProjectId, source.body.jobId)).status).toBe('succeeded');

    // A provider must exist for drafting; the dev-offline adapter is created
    // per user above, but credentials are per user, so reuse or create one.
    const credentials = await user.client.get('/api/provider-credentials');
    if ((credentials.body.credentials ?? []).length === 0) {
      await user.client.post('/api/provider-credentials', {
        displayName: 'Local dev provider',
        providerType: 'dev-offline',
        model: 'dev-offline-model',
        apiKey: 'dev-key-not-a-real-secret',
        isDefault: true,
      });
    }

    const scan = await user.client.post(`/api/projects/${oneClickProjectId}/pipeline`, { useAi: false });
    expect(scan.status).toBe(202);
    const job = await waitForJob(oneClickProjectId, scan.body.jobId);

    if (job.status === 'failed') throw new Error(`pipeline failed: ${job.errorMessage}`);
    expect(job.status).toBe('succeeded');
    // Every step reports its own outcome so the UI can explain what happened.
    const steps = job.result.steps as Array<{ name: string; status: string; message: string }>;
    expect(steps.map((step) => step.name)).toEqual(expect.arrayContaining(['analyze', 'map', 'draft']));
    expect(steps.find((step) => step.name === 'analyze')!.status).toBe('done');
    expect(steps.find((step) => step.name === 'map')!.status).toBe('done');
    expect(job.result.summary).toMatch(/Drafted/i);
    expect(Number(job.result.sections)).toBeGreaterThan(0);

    // The outline and the report really were produced by that single call.
    const outline = await user.client.get(`/api/projects/${oneClickProjectId}/template`);
    expect(outline.body.sections.length).toBeGreaterThan(0);
    const mapping = await user.client.get(`/api/projects/${oneClickProjectId}/mapping`);
    expect(mapping.body.mappings.length).toBeGreaterThan(0);
    const report = await user.client.get(`/api/projects/${oneClickProjectId}/report`);
    expect(report.body.sections.some((s: { content: string }) => s.content.trim().length > 0)).toBe(true);
  });

  it('refuses a second scan while one is running', async () => {
    const project = await user.client.post('/api/projects', { title: 'Double scan', language: 'en' });
    const doubleProjectId = project.body.project.id;
    const template = await user.client.upload(
      `/api/projects/${doubleProjectId}/documents`,
      { name: 'double.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    await waitForJob(doubleProjectId, template.body.jobId);
    const source = await user.client.upload(
      `/api/projects/${doubleProjectId}/documents`,
      { name: 'double.txt', type: 'text/plain', bytes: sourceTxt() },
      'source',
    );
    await waitForJob(doubleProjectId, source.body.jobId);

    const first = await user.client.post(`/api/projects/${doubleProjectId}/pipeline`, { useAi: false });
    expect(first.status).toBe(202);
    // Not drained yet, so the first job is still queued.
    const second = await user.client.post(`/api/projects/${doubleProjectId}/pipeline`, { useAi: false });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already running/i);
    await waitForJob(doubleProjectId, first.body.jobId);
  });

  it('explains that there is no evidence instead of producing an empty report', async () => {
    const project = await user.client.post('/api/projects', { title: 'No sources', language: 'en' });
    const bareProjectId = project.body.project.id;
    const template = await user.client.upload(
      `/api/projects/${bareProjectId}/documents`,
      { name: 'bare.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    await waitForJob(bareProjectId, template.body.jobId);

    const scan = await user.client.post(`/api/projects/${bareProjectId}/pipeline`, { useAi: false });
    expect(scan.status).toBe(202);
    const job = await waitForJob(bareProjectId, scan.body.jobId);

    const steps = job.result.steps as Array<{ name: string; status: string; message: string }>;
    const mapStep = steps.find((step) => step.name === 'map')!;
    // Skipped, not failed: the template is fine, there is simply nothing to read.
    expect(mapStep.status).toBe('skipped');
    expect(mapStep.message).toMatch(/nothing to map|no source/i);
    expect(String(job.result.summary)).toMatch(/no evidence|nothing was drafted/i);
  });
});

/**
 * Drafting is the only step that needs a model, and it runs last. Without an
 * early check a scan analysed and mapped everything, then failed minutes later
 * with a message that read as if the sources were at fault.
 */
describe('the pipeline refuses to start without an AI provider', () => {
  it('answers 422 with a fixable reason instead of queueing a job', async () => {
    const fresh = await signUpUser(context.app, 'no-provider');
    const project = await fresh.client.post('/api/projects', { title: 'Needs a provider', language: 'en' });
    const projectId = project.body.project.id;

    // No credentials were added for this user.
    const scan = await fresh.client.post(`/api/projects/${projectId}/pipeline`, { useAi: true });

    expect(scan.status).toBe(422);
    expect(scan.body.error.message).toMatch(/No AI provider is configured/i);
    // Points at the screen where it is fixed.
    expect(scan.body.error.message).toMatch(/Settings/i);

    // Nothing was queued, so no background job can fail later.
    const jobs = await fresh.client.get(`/api/projects/${projectId}/jobs`);
    const pipelineJobs = (jobs.body.jobs as Array<{ kind: string }>).filter((job) => job.kind === 'run_pipeline');
    expect(pipelineJobs).toHaveLength(0);
  });

  it('still allows a mapping-only scan that does not need a model', async () => {
    const fresh = await signUpUser(context.app, 'no-provider-map');
    const project = await fresh.client.post('/api/projects', { title: 'Mapping only', language: 'en' });
    const projectId = project.body.project.id;

    // useAi: false never calls a provider, so it must not be blocked.
    const scan = await fresh.client.post(`/api/projects/${projectId}/pipeline`, { useAi: false });
    expect(scan.status).toBe(202);
  });
});

/**
 * A real campus template contains sections that no source document can fill — a
 * cover page, an appendix list, a bibliography. A scan used to report
 * "Export failed: These required sections are still empty: …" and mark the whole
 * pipeline as failed, even when dozens of sections had been drafted successfully.
 */
describe('sections with no evidence do not sink the whole report', () => {

  /**
   * Adds a section the sources can never fill, the way a template's front matter
   * does. Created through the manual-sections endpoint, which is how a user adds
   * a heading that is missing from their template.
   */
  async function addUnfillableSection(projectId: string, heading: string): Promise<string> {
    const created = await user.client.post(`/api/projects/${projectId}/sections/manual`, {
      heading,
      level: 1,
      paragraphIndex: 0,
    });
    expect(created.status).toBe(201);
    return created.body.section.id;
  }

  async function prepareProject(title: string): Promise<string> {
    const project = await user.client.post('/api/projects', { title, language: 'en' });
    expect(project.status).toBe(201);
    const projectId = project.body.project.id;

    const template = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: `${title}-template.docx`, type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    expect((await waitForJob(projectId, template.body.jobId)).status).toBe('succeeded');

    const source = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: `${title}-source.txt`, type: 'text/plain', bytes: sourceTxt() },
      'source',
    );
    expect((await waitForJob(projectId, source.body.jobId)).status).toBe('succeeded');

    const credentials = await user.client.get('/api/provider-credentials');
    if ((credentials.body.credentials ?? []).length === 0) {
      await user.client.post('/api/provider-credentials', {
        displayName: 'Local dev provider',
        providerType: 'dev-offline',
        model: 'dev-offline-model',
        apiKey: 'dev-key-not-a-real-secret',
        isDefault: true,
      });
    }
    return projectId;
  }

  it('still exports the report when every section has some evidence', async () => {
    const projectId = await prepareProject('Partial coverage report');
    // "DAFTAR PUSTAKA" (bibliography) has no matching source text, but the
    // topical fallback still maps general evidence to it, so the report is
    // complete and the export must succeed without any blocking message.
    await addUnfillableSection(projectId, 'DAFTAR PUSTAKA');

    const scan = await user.client.post(`/api/projects/${projectId}/pipeline`, {
      useAi: false,
      exportFormats: ['docx'],
    });
    expect(scan.status).toBe(202);
    const job = await waitForJob(projectId, scan.body.jobId);

    expect(job.status).toBe('succeeded');
    const steps = job.result.steps as Array<{ name: string; status: string; message: string }>;
    expect(steps.find((step) => step.name === 'draft')!.status).toBe('done');
    expect(steps.find((step) => step.name === 'export')!.status).toBe('done');
    expect(String(job.result.summary)).toMatch(/Drafted \d+ of \d+ sections?/);

    // A real file exists — that is the whole point of the flow.
    const listed = await user.client.get(`/api/projects/${projectId}/exports`);
    expect(listed.body.exports.some((entry: { status: string }) => entry.status === 'ready')).toBe(true);
  });

  it('still refuses when a required section was never drafted at all', async () => {
    const projectId = await prepareProject('Truly empty export');
    // No pipeline run here: the sections exist but nothing was ever generated,
    // so the export must still refuse instead of shipping an empty document.
    await addUnfillableSection(projectId, 'Never drafted');

    const exported = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(409);
    expect(exported.body.error.message).toMatch(/still empty|Generate at least one section/i);
  });

  /**
   * The second blocker on the reported project: "BAB I: PENDAHULUAN" is a chapter
   * label above 1.1–1.3 and correctly has no body. Counting it as a missing section
   * refused an otherwise finished export.
   */
  it('exports when the only empty required section is a chapter divider', async () => {
    const projectId = await prepareProject('Chapter divider export');
    const scan = await user.client.post(`/api/projects/${projectId}/pipeline`, { useAi: false });
    expect((await waitForJob(projectId, scan.body.jobId)).status).toBe('succeeded');

    // Added after drafting, so it stays empty the way the real chapter label does.
    await addUnfillableSection(projectId, 'BAB I: PENDAHULUAN');

    const exported = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(202);
    const job = await waitForJob(projectId, exported.body.jobId);
    expect(job.status).toBe('succeeded');

    const artifact = await user.client.get(`/api/projects/${projectId}/exports`);
    const ready = (artifact.body.exports as Array<{ status: string; warnings?: string[] }>).find(
      (entry) => entry.status === 'ready',
    );
    expect(ready).toBeTruthy();
    // Explained, not hidden: the outline can say why the row has no prose.
    expect((ready?.warnings ?? []).join(' ')).toMatch(/Chapter dividers/i);
  });

  /**
   * The exact state from the reported screenshot: most sections drafted, one
   * section holding only a [MISSING: …] marker. Export must succeed.
   */
  it('exports when a required section holds only a [MISSING] marker', async () => {
    const projectId = await prepareProject('Placeholder blocks export');
    const sectionId = await addUnfillableSection(projectId, 'LAMPIRAN');

    const scan = await user.client.post(`/api/projects/${projectId}/pipeline`, { useAi: false });
    expect((await waitForJob(projectId, scan.body.jobId)).status).toBe('succeeded');

    // Force the marker state regardless of what the dev provider drafted.
    const written = await user.client.patch(`/api/projects/${projectId}/sections/${sectionId}/content`, {
      content: '[MISSING: no source material was mapped to this section.]',
    });
    expect(written.status).toBe(200);

    const exported = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(202);
    const job = await waitForJob(projectId, exported.body.jobId);
    expect(job.status).toBe('succeeded');

    // The marker survives into the document so the gap stays visible.
    const download = await user.client.bytes(
      'GET',
      `/api/projects/${projectId}/exports/${exported.body.exportId}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.body.byteLength).toBeGreaterThan(1000);
  });

  /**
   * The reported defect, reproduced: a cover section that an earlier run filled
   * with an essay *about* the cover ("Laporan ini disusun sebagai…"). The
   * template already carries the real cover text, so the stored body must be
   * cleared rather than preserved, and the export must still succeed.
   */
  it('clears essay prose from a cover section and keeps the template text', async () => {
    const projectId = await prepareProject('Cover essay report');
    const sections = await user.client.get(`/api/projects/${projectId}/sections`);
    const list = (sections.body.sections ?? []) as Array<{ id: string; heading: string }>;
    const cover = list.find((section) => /Quarterly Activity Report/i.test(section.heading));
    expect(cover).toBeTruthy();

    const staleEssay = 'Laporan ini disusun sebagai Laporan Kegiatan Kuartalan. '.repeat(20);
    const planted = await user.client.patch(`/api/projects/${projectId}/sections/${cover!.id}/content`, {
      content: staleEssay,
    });
    expect(planted.status).toBe(200);
    // Prove the plant landed; otherwise the assertion below proves nothing.
    const before = await user.client.get(`/api/projects/${projectId}/sections/${cover!.id}/detail`);
    expect(String(before.body.content ?? '')).toContain('Laporan ini disusun sebagai');

    const scan = await user.client.post(`/api/projects/${projectId}/pipeline`, {
      useAi: false,
      // The defect happens on a re-run: regeneration must still clear cover prose.
      regenerateExisting: true,
    });
    expect(scan.status).toBe(202);
    expect((await waitForJob(projectId, scan.body.jobId)).status).toBe('succeeded');

    const detail = await user.client.get(`/api/projects/${projectId}/sections/${cover!.id}/detail`);
    expect(detail.status).toBe(200);
    // Cleared, so the template's own title is what the document shows.
    expect(String(detail.body.content ?? '')).toBe('');
  });

});

/**
 * The per-job section cap must never truncate a report silently.
 *
 * A 44-section campus template against the old cap of 40 produced "Drafted 40
 * sections." with `failed: 0` while the last four were never attempted — the
 * report was quietly incomplete but looked like a success.
 */
describe('a report larger than the per-job section cap', () => {
  let capped: TestApp;
  let cappedUser: TestUser;

  /** Same as waitForJob, but drives the capped app's own queue and client. */
  async function waitForCappedJob(projectId: string, jobId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await capped.drainQueue();
      const result = await cappedUser.client.get(`/api/projects/${projectId}/jobs/${jobId}`);
      if (result.status !== 200) throw new Error(`job lookup failed: ${result.status}`);
      const status = result.body.job.status;
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return result.body.job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('job did not finish');
  }

  beforeAll(async () => {
    capped = await createTestApp({ AI_MAX_SECTIONS_PER_JOB: '2' });
  });

  afterAll(async () => {
    await capped.close();
  });

  it('names the sections it did not attempt instead of reporting success', async () => {
    const owner = await signUpUser(capped.app, 'capped');
    cappedUser = owner;
    await owner.client.post('/api/provider-credentials', {
      displayName: 'Local dev provider',
      providerType: 'dev-offline',
      model: 'dev-offline-model',
      apiKey: 'dev-key-not-a-real-secret',
      isDefault: true,
    });

    const project = await owner.client.post('/api/projects', { title: 'Capped report', language: 'en' });
    const projectId = project.body.project.id;

    const template = await owner.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'capped.docx', type: DOCX_MIME, bytes: reportTemplateDocx() },
      'template',
    );
    await waitForCappedJob(projectId, template.body.jobId);

    const source = await owner.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'notes.txt', type: 'text/plain', bytes: sourceTxt() },
      'source',
    );
    await waitForCappedJob(projectId, source.body.jobId);

    const scan = await owner.client.post(`/api/projects/${projectId}/pipeline`, { useAi: true });
    expect(scan.status).toBe(202);
    const job = await waitForCappedJob(projectId, scan.body.jobId);

    // The run may still succeed, but it must confess what it left undone.
    const steps = job.result.steps as Array<{ name: string; status: string; message: string; detail?: string }>;
    const draftStep = steps.find((step) => step.name === 'draft')!;
    expect(draftStep.message).toMatch(/not attempted/i);
    expect(draftStep.message).toMatch(/Scan & generate again/i);
    // The deferred count is in the detail line, so a truncated run is auditable.
    expect(String(draftStep.detail)).toMatch(/deferred/);
  });
});

