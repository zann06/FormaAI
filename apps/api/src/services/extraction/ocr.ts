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
 * The image format the OCR backends receive.
 *
 * Tesseract infers the format from the file itself, but the HTTP backend needs
 * an explicit content type, so callers must say what they are handing over.
 * Users upload whatever their phone or scanner produced (`.webp` screenshots,
 * `.tif` scans, `.bmp`, `.gif`), so this is wider than "png or jpeg".
 */
export type OcrImageFormat = 'png' | 'jpeg' | 'webp' | 'tiff' | 'bmp' | 'gif';

/** Content type sent to an HTTP OCR endpoint for each accepted format. */
const CONTENT_TYPE_BY_FORMAT: Record<OcrImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

/** File extension used when we hand the bytes to a CLI OCR binary. */
const EXTENSION_BY_FORMAT: Record<OcrImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  tiff: 'tiff',
  bmp: 'bmp',
  gif: 'gif',
};

export async function runOcr(
  image: Uint8Array,
  nameHint = 'image',
  format: OcrImageFormat = 'png',
): Promise<string | null> {
  const tesseractBin = process.env.TESSERACT_BIN;
  const endpoint = process.env.OCR_ENDPOINT;
  if (!tesseractBin && !endpoint) return null;

  // Decode and re-encode as PNG first. This makes one code path serve every
  // input format, and it rescues what Tesseract/Leptonica alone cannot read:
  // animated or palette-heavy WEBP/GIF, CMYK or 16-bit TIFF from scanners, and
  // BMP variants. If the bytes cannot be decoded at all the caller gets an
  // explicit error instead of an empty result that looks like "no text".
  const normalized = await normalizeImageForOcr(image);
  const payload = normalized ?? image;
  const effectiveFormat: OcrImageFormat = normalized ? 'png' : format;

  if (tesseractBin) return runTesseract(tesseractBin, payload, nameHint, effectiveFormat);
  return runHttpOcr(endpoint as string, payload, nameHint, effectiveFormat);
}

/**
 * Re-encodes any supported bitmap as a plain 8-bit PNG using `@napi-rs/canvas`.
 * Returns null when the module is unavailable or the bytes are not decodable.
 */
export async function normalizeImageForOcr(image: Uint8Array): Promise<Uint8Array | null> {
  try {
    const canvasModule = (await import(/* @vite-ignore */ '@napi-rs/canvas').catch(() => null)) as {
      loadImage: (data: Uint8Array) => Promise<{
        width: number;
        height: number;
      }>;
      createCanvas: (
        w: number,
        h: number,
      ) => { getContext: (t: string) => unknown; toBuffer: (t: string) => Buffer };
    } | null;
    if (!canvasModule) return null;

    const decoded = await canvasModule.loadImage(image);
    const width = Math.max(1, Math.round(decoded.width));
    const height = Math.max(1, Math.round(decoded.height));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext('2d') as {
      fillStyle: string;
      fillRect: (x: number, y: number, w: number, h: number) => void;
      drawImage: (img: unknown, x: number, y: number) => void;
    };
    // Composite onto white so transparent PNG/WEBP/GIF do not OCR as black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded, 0, 0);
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    return null;
  }
}

async function runTesseract(
  bin: string,
  image: Uint8Array,
  nameHint: string,
  format: OcrImageFormat,
): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'formaai-ocr-'));
  const extension = EXTENSION_BY_FORMAT[format];
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
    'content-type': CONTENT_TYPE_BY_FORMAT[format],
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

