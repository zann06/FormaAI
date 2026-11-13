/**
 * Source diagrams must reach the exported DOCX as real pictures.
 *
 * A network topology is evidence prose cannot reproduce, and OCR reads its labels
 * imperfectly ("Gig0/0" comes back as "Gi90/0"). Embedding the original image is
 * what makes those OCR errors harmless instead of misleading, so these tests
 * assert the whole chain: the figure row is stored, the bytes are resolved from
 * storage for the right owner, and the produced package carries a media part that
 * Word will actually open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readDocxPackage, xmlToString } from '@formaai/docx-engine';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { DOCX_MIME, reportTemplateDocx, sourceTxt, tinyPng } from './fixtures.js';
import { documents, reportSections, templateSections } from '../src/db/schema.js';

let context: TestApp;
let user: TestUser;

beforeAll(async () => {
  context = await createTestApp();
  user = await signUpUser(context.app, 'figures');
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

/**
 * Uploads a template and a source, then drafts every section with the offline
 * dev provider so the export has real content to assemble.
 */
async function prepareProject(title: string, templateName: string): Promise<string> {
  const project = await user.client.post('/api/projects', { title, language: 'en' });
  expect(project.status).toBe(201);
  const projectId = project.body.project.id;

  const template = await user.client.upload(
    `/api/projects/${projectId}/documents`,
    { name: templateName, type: DOCX_MIME, bytes: reportTemplateDocx() },
    'template',
  );
  expect((await waitForJob(projectId, template.body.jobId)).status).toBe('succeeded');

  const source = await user.client.upload(
    `/api/projects/${projectId}/documents`,
    { name: 'notes.txt', type: 'text/plain', bytes: sourceTxt() },
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

  const scan = await user.client.post(`/api/projects/${projectId}/pipeline`, { useAi: false });
  expect((await waitForJob(projectId, scan.body.jobId)).status).toBe('succeeded');
  return projectId;
}

describe('source figures in the export', () => {
  it('embeds a section\'s image as a media part Word can open', async () => {
    const projectId = await prepareProject('Figure report', 'figure-template.docx');

    // Attach the diagram the way generation does: a figure row pointing at an
    // image document. Stored directly because there is no HTTP endpoint for it.
    const pngBytes = tinyPng();
    const storageKey = `${user.id}/${projectId}/diagram-1.png`;
    await context.storage.put(storageKey, pngBytes, 'image/png');
    const [imageDoc] = await context.db
      .insert(documents)
      .values({
        userId: user.id,
        projectId,
        kind: 'source',
        originalName: '1.png',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
        storageKey,
        checksum: 'probe-checksum-1',
      })
      .returning({ id: documents.id });

    const sections = await context.db
      .select({ id: templateSections.id, heading: templateSections.heading })
      .from(templateSections)
      .where(eq(templateSections.projectId, projectId));
    const target = sections[sections.length - 1]!;

    await context.db
      .update(reportSections)
      .set({ figures: [{ documentId: imageDoc!.id, caption: 'Sumber: 1.png' }] })
      .where(eq(reportSections.templateSectionId, target.id));

    const exported = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(202);
    expect((await waitForJob(projectId, exported.body.jobId)).status).toBe('succeeded');

    const download = await user.client.bytes(
      'GET',
      `/api/projects/${projectId}/exports/${exported.body.exportId}/download`,
    );
    expect(download.status).toBe(200);

    const pkg = readDocxPackage(new Uint8Array(download.body));
    const media = Object.keys(pkg.files).filter((name) => name.startsWith('word/media/'));
    const templateMedia = Object.keys(readDocxPackage(reportTemplateDocx()).files).filter((name) =>
      name.startsWith('word/media/'),
    );
    expect(media.length).toBe(templateMedia.length + 1);

    // The drawing, its relationship and its content type must all agree, or Word
    // reports the file as corrupt.
    const docXml = xmlToString(pkg.files['word/document.xml']!);
    const embed = /r:embed="(rIdFig[^"]+)"/.exec(docXml);
    expect(embed).not.toBeNull();
    const rels = xmlToString(pkg.files['word/_rels/document.xml.rels']!);
    expect(rels).toContain(`Id="${embed![1]}"`);
    const contentTypes = xmlToString(pkg.files['[Content_Types].xml']!);
    expect(contentTypes).toMatch(/Extension="png"[^>]*ContentType="image\/png"/);

    // The bytes must be the original picture, not a re-encode.
    const embedded = media
      .map((name) => pkg.files[name]!)
      .find((part) => part.byteLength === pngBytes.byteLength);
    expect(embedded).toBeDefined();
    expect(Array.from(embedded!)).toEqual(Array.from(pngBytes));
  });

  it('leaves the document valid when a figure points at a missing image', async () => {
    const projectId = await prepareProject('Broken figure', 'broken-template.docx');

    const sections = await context.db
      .select({ id: templateSections.id })
      .from(templateSections)
      .where(eq(templateSections.projectId, projectId));
    const target = sections[sections.length - 1]!;

    // A document row whose object never made it to storage: the export must still
    // succeed, just without that picture.
    const [ghost] = await context.db
      .insert(documents)
      .values({
        userId: user.id,
        projectId,
        kind: 'source',
        originalName: 'gone.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        storageKey: `${user.id}/${projectId}/does-not-exist.png`,
        checksum: 'probe-checksum-2',
      })
      .returning({ id: documents.id });
    await context.db
      .update(reportSections)
      .set({ figures: [{ documentId: ghost!.id }] })
      .where(eq(reportSections.templateSectionId, target.id));

    const exported = await user.client.post(`/api/projects/${projectId}/exports`, { format: 'docx' });
    expect(exported.status).toBe(202);
    expect((await waitForJob(projectId, exported.body.jobId)).status).toBe('succeeded');

    const download = await user.client.bytes(
      'GET',
      `/api/projects/${projectId}/exports/${exported.body.exportId}/download`,
    );
    expect(download.status).toBe(200);
    const docXml = xmlToString(readDocxPackage(new Uint8Array(download.body)).files['word/document.xml']!);
    expect(docXml).not.toContain('rIdFig');
  });
});
