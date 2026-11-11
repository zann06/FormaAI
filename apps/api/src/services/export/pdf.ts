import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../lib/errors.js';

export interface ConversionResult {
  bytes: Uint8Array;
  engine: 'libreoffice-local' | 'remote-converter';
  durationMs: number;
}

export function isPdfConverterConfigured(config: Pick<AppConfig, 'LIBREOFFICE_BIN' | 'CONVERTER_URL'>): boolean {
  return Boolean(config.LIBREOFFICE_BIN || config.CONVERTER_URL);
}

/**
 * Converts a DOCX buffer to PDF with a real conversion engine.
 *
 * - `LIBREOFFICE_BIN`: spawns soffice headless with an isolated user profile.
 * - `CONVERTER_URL`: posts the file to an external converter service.
 *
 * If neither is configured the call fails loudly; we never generate a fake PDF.
 */
export async function convertDocxToPdf(
  docx: Uint8Array,
  config: Pick<AppConfig, 'LIBREOFFICE_BIN' | 'CONVERTER_URL' | 'CONVERTER_TOKEN' | 'PDF_CONVERSION_TIMEOUT_MS'>,
): Promise<ConversionResult> {
  const started = Date.now();
  if (config.CONVERTER_URL) {
    const bytes = await convertRemote(docx, config.CONVERTER_URL, config.CONVERTER_TOKEN, config.PDF_CONVERSION_TIMEOUT_MS);
    return { bytes, engine: 'remote-converter', durationMs: Date.now() - started };
  }
  if (config.LIBREOFFICE_BIN) {
    const bytes = await convertLocal(docx, config.LIBREOFFICE_BIN, config.PDF_CONVERSION_TIMEOUT_MS);
    return { bytes, engine: 'libreoffice-local', durationMs: Date.now() - started };
  }
  throw new AppError(
    'PDF_CONVERTER_NOT_CONFIGURED',
    'PDF export requires a converter. Set LIBREOFFICE_BIN (path to soffice) or CONVERTER_URL, then retry. DOCX export works without it.',
  );
}

async function convertRemote(docx: Uint8Array, url: string, token: string | undefined, timeoutMs: number): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    accept: 'application/pdf',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: docx as unknown as BodyInit,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new AppError('PROVIDER_ERROR', `The PDF converter returned HTTP ${response.status}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  assertPdf(buffer);
  return buffer;
}

async function convertLocal(docx: Uint8Array, binary: string, timeoutMs: number): Promise<Uint8Array> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'formaai-pdf-'));
  const profileDir = path.join(dir, 'profile');
  const inputPath = path.join(dir, 'input.docx');
  const outputDir = path.join(dir, 'out');
  try {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(inputPath, docx);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          '--nodefault',
          '--nofirststartwizard',
          `-env:UserInstallation=file://${profileDir.replace(/\\/g, '/')}`,
          '--convert-to',
          'pdf:writer_pdf_Export',
          '--outdir',
          outputDir,
          inputPath,
        ],
        { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000);
      });
      child.on('error', (error) => reject(new Error(`Could not start the converter: ${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice failed with exit code ${code}: ${stderr}`));
      });
    });
    const files = await fs.readdir(outputDir);
    const pdfName = files.find((file) => file.toLowerCase().endsWith('.pdf'));
    if (!pdfName) throw new Error('The converter produced no PDF file');
    const bytes = new Uint8Array(await fs.readFile(path.join(outputDir, pdfName)));
    assertPdf(bytes);
    return bytes;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assertPdf(bytes: Uint8Array): void {
  if (bytes.byteLength < 128) throw new Error('The generated PDF is empty');
  const magic = new TextDecoder().decode(bytes.subarray(0, 5));
  if (magic !== '%PDF-') throw new Error('The generated file is not a valid PDF');
}

/** Reopens a PDF and extracts page count + a text sample to validate the output. */
export async function validatePdf(bytes: Uint8Array): Promise<{ pageCount: number; textChars: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of the buffer it is given (it may transfer/detach it).
  // Pass a copy so the caller's bytes stay usable for storage and download.
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  let textChars = 0;
  const pagesToCheck = Math.min(doc.numPages, 5);
  for (let pageNumber = 1; pageNumber <= pagesToCheck; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    textChars += content.items.reduce((sum, item) => sum + (typeof (item as { str?: string }).str === 'string' ? (item as { str: string }).str.length : 0), 0);
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pageCount, textChars };
}

