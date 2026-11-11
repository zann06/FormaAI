import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';

/**
 * Image sources rely on OCR. These tests pin the two behaviours that matter:
 *
 *  1. With OCR available, a real PNG is indexed as text.
 *  2. With OCR unavailable, the upload FAILS with an explanation — it must never
 *     be reported as "extracted" with zero chunks, because that would let the
 *     generator produce a report citing a picture it never read.
 *
 * The OCR-available case needs a real Tesseract binary, so it is skipped on
 * hosts without one (CI and Docker images ship it).
 */
const samplePng = new Uint8Array(
  readFileSync(path.join(process.cwd(), '..', '..', 'fixtures', 'ocr-sample.png')),
);

const ocrAvailable = Boolean(process.env.TESSERACT_BIN);

describe('image sources', () => {
  let context: TestApp;
  let user: TestUser;
  let projectId: string;

  beforeAll(async () => {
    // Force OCR *off* regardless of ambient configuration, so the failure path
    // is tested deterministically.
    context = await createTestApp({ TESSERACT_BIN: '', OCR_ENDPOINT: '' });
    user = await signUpUser(context.app, 'ocr');
    const project = await user.client.post('/api/projects', { title: 'OCR project' });
    projectId = project.body.project.id;
  });

  afterAll(async () => {
    await context.close();
  });

  it('accepts a real PNG upload', async () => {
    const upload = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'scan.png', type: 'image/png', bytes: samplePng },
      'source',
    );
    expect(upload.status).toBe(201);
    expect(upload.body.document.mimeType).toBe('image/png');
  });

  it('marks the image failed with an OCR explanation instead of inventing text', async () => {
    await context.drainQueue();
    const documents = await user.client.get(`/api/projects/${projectId}/documents`);
    const doc = documents.body.documents.find((d: { originalName: string }) => d.originalName === 'scan.png');
    expect(doc.status).toBe('failed');
    expect(doc.chunkCount).toBe(0);
    expect(doc.extractionError).toMatch(/OCR/i);
  });

  it('rejects a file that claims to be a PNG but is not', async () => {
    const upload = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'fake.png', type: 'image/png', bytes: new TextEncoder().encode('%PDF-1.4 not an image') },
      'source',
    );
    expect(upload.status).toBe(422);
  });

  it('rejects an image used as a template', async () => {
    const upload = await user.client.upload(
      `/api/projects/${projectId}/documents`,
      { name: 'tpl.png', type: 'image/png', bytes: samplePng },
      'template',
    );
    expect(upload.status).toBe(415);
  });

  it.skipIf(!ocrAvailable)('indexes text from the image when OCR is configured', async () => {
    const withOcr = await createTestApp();
    try {
      const ocrUser = await signUpUser(withOcr.app, 'ocr-on');
      const project = await ocrUser.client.post('/api/projects', { title: 'OCR enabled' });
      expect(project.status).toBe(201);
      const projectId = project.body.project.id as string;
      const upload = await ocrUser.client.upload(
        `/api/projects/${projectId}/documents`,
        { name: 'scan.png', type: 'image/png', bytes: samplePng },
        'source',
      );
      expect(upload.status).toBe(201);
      await withOcr.drainQueue();
      const documents = await ocrUser.client.get(`/api/projects/${projectId}/documents`);
      const doc = documents.body.documents.find((d: { originalName: string }) => d.originalName === 'scan.png');
      expect(doc.status).toBe('extracted');
      expect(doc.wordCount).toBeGreaterThan(0);
      expect(doc.extractionMethod).toBe('ocr-http');
    } finally {
      await withOcr.close();
    }
  });
});
