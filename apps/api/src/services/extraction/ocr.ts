/**
 * Optional OCR support.
 *
 * Two backends, both opt-in through configuration:
 *  - `TESSERACT_BIN`: a local tesseract executable (spawned with a temp file);
 *  - `OCR_ENDPOINT`: an HTTP service that accepts `POST` with `image/png` and
 *    returns `{ "text": "..." }` (e.g. a small wrapper around Tesseract or a
 *    cloud OCR function).
 *
 * When neither is configured, `isOcrConfigured()` is false and scanned PDFs are
 * reported as needing OCR instead of silently producing empty text.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export function isOcrConfigured(): boolean {
  return Boolean(process.env.TESSERACT_BIN || process.env.OCR_ENDPOINT);
}

/**
 * The image format the OCR backends receive. Tesseract infers the format from
 * the file, but the HTTP backend needs an explicit content type, so callers must
 * tell us what they are handing over.
 */
export type OcrImageFormat = 'png' | 'jpeg';

export async function runOcr(
  image: Uint8Array,
  nameHint = 'image',
  format: OcrImageFormat = 'png',
): Promise<string | null> {
  const tesseractBin = process.env.TESSERACT_BIN;
  const endpoint = process.env.OCR_ENDPOINT;
  if (tesseractBin) return runTesseract(tesseractBin, image, nameHint, format);
  if (endpoint) return runHttpOcr(endpoint, image, nameHint, format);
  return null;
}

async function runTesseract(
  bin: string,
  image: Uint8Array,
  nameHint: string,
  format: OcrImageFormat,
): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'formaai-ocr-'));
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const file = path.join(dir, `${nameHint.replace(/[^a-z0-9-]/gi, '_')}.${extension}`);
  try {
    await fs.writeFile(file, image);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, [file, 'stdout', '-l', process.env.OCR_LANG ?? 'eng+ind'], {
        timeout: 60_000,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`tesseract exited with ${code}: ${stderr.slice(0, 200)}`));
      });
    });
    return output;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runHttpOcr(
  endpoint: string,
  image: Uint8Array,
  nameHint: string,
  format: OcrImageFormat,
): Promise<string | null> {
  const headers: Record<string, string> = {
    'content-type': format === 'jpeg' ? 'image/jpeg' : 'image/png',
    'x-image-name': nameHint,
  };
  if (process.env.OCR_TOKEN) headers.authorization = `Bearer ${process.env.OCR_TOKEN}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: image as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  const json = (await response.json().catch(() => null)) as { text?: string } | null;
  return json?.text ?? null;
}

/**
 * Renders a pdfjs page to PNG. Uses the browser canvas API when available
 * (`@napi-rs/canvas` is optional); otherwise returns null and the caller falls
 * back to reporting "OCR unavailable for this page".
 */
export async function renderPageToPng(page: {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> };
}): Promise<Uint8Array | null> {
  try {
    const canvasModule = (await import(/* @vite-ignore */ '@napi-rs/canvas').catch(() => null)) as
      | { createCanvas: (w: number, h: number) => { getContext: (t: string) => unknown; toBuffer: (t: string) => Buffer } }
      | null;
    if (!canvasModule) return null;
    const viewport = page.getViewport({ scale: 2 });
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    return null;
  }
}

