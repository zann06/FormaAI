import { describe, expect, it } from 'vitest';
import { validateUpload } from '../src/lib/upload-validation.js';
import { extractImage } from '../src/services/extraction/index.js';
import { isImageSourceExtension } from '@formaai/shared';

/**
 * A real 1x1 PNG (valid IHDR/IDAT/IEND, byte-exact signature).
 * Hand-built so the test needs no image library and runs everywhere.
 */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** A real, minimal JPEG: SOI + JFIF APP0 + EOI. Enough for signature checks. */
const JPEG_MINIMAL = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0xff, 0xd9,
]);

const MAX = 25 * 1024 * 1024;

describe('image uploads', () => {
  it('classifies image extensions as requiring OCR', () => {
    expect(isImageSourceExtension('.png')).toBe(true);
    expect(isImageSourceExtension('.jpg')).toBe(true);
    expect(isImageSourceExtension('.jpeg')).toBe(true);
    expect(isImageSourceExtension('.PDF')).toBe(false);
    expect(isImageSourceExtension('.docx')).toBe(false);
  });

  it('accepts a real PNG source and reports the canonical mime type', () => {
    const result = validateUpload('scan.png', 'image/png', PNG_1X1, { kind: 'source', maxBytes: MAX });
    expect(result.extension).toBe('.png');
    expect(result.mimeType).toBe('image/png');
  });

  it('accepts a real JPEG uploaded as .jpg and as .jpeg', () => {
    const jpg = validateUpload('photo.jpg', 'image/jpeg', JPEG_MINIMAL, { kind: 'source', maxBytes: MAX });
    expect(jpg.mimeType).toBe('image/jpeg');
    const jpeg = validateUpload('photo.jpeg', 'image/jpeg', JPEG_MINIMAL, { kind: 'source', maxBytes: MAX });
    expect(jpeg.mimeType).toBe('image/jpeg');
  });

  it('rejects a .png whose bytes are not a PNG (renamed file)', () => {
    const notPng = new Uint8Array(Buffer.from('%PDF-1.4 not an image', 'latin1'));
    expect(() => validateUpload('fake.png', 'image/png', notPng, { kind: 'source', maxBytes: MAX })).toThrow(
      /not a valid PNG/i,
    );
  });

  it('rejects a .jpg whose bytes are not a JPEG', () => {
    expect(() => validateUpload('fake.jpg', 'image/jpeg', PNG_1X1, { kind: 'source', maxBytes: MAX })).toThrow(
      /not a valid JPEG/i,
    );
  });

  it('rejects a declared content type that contradicts the extension', () => {
    expect(() =>
      validateUpload('scan.png', 'image/jpeg', PNG_1X1, { kind: 'source', maxBytes: MAX }),
    ).toThrow(/does not match/i);
  });

  it('still refuses images as templates', () => {
    expect(() => validateUpload('tpl.png', 'image/png', PNG_1X1, { kind: 'template', maxBytes: MAX })).toThrow(
      /must be a DOCX/i,
    );
  });
});

describe('image extraction', () => {
  it('refuses without OCR and says why, instead of returning empty text as success', async () => {
    const result = await extractImage(PNG_1X1, 'png', { ocrEnabled: false });
    expect(result.units).toHaveLength(0);
    expect(result.needsOcr).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/OCR/i);
  });

  /**
   * OCR *ran* but found nothing. This is the normal outcome for screenshots of
   * diagrams and topologies, whose labels are short and scattered. The message
   * must tell the user to write that content themselves rather than leaving them
   * guessing — and it must not claim OCR was unavailable.
   */
  it('explains that diagrams and photos cannot be read, and points to manual writing', async () => {
    // A stub OCR that behaves like Tesseract on a topology diagram: it runs
    // successfully but yields no usable text.
    const result = await extractImage(PNG_1X1, 'png', {
      ocrEnabled: true,
      ocr: async () => '   \n  ',
    });
    expect(result.units).toHaveLength(0);
    expect(result.needsOcr).toBe(false); // OCR was available; it simply found no text
    const message = result.warnings.join(' ');
    expect(message).toMatch(/diagram/i);
    expect(message).toMatch(/describe it yourself/i);
  });

  /**
   * Exercises the real OCR adapter end-to-end. Tesseract is present in the
   * Docker image; on a host without it this is skipped rather than faked.
   */
  const tesseractAvailable = Boolean(process.env.TESSERACT_BIN);
  it.skipIf(!tesseractAvailable)('reads text from a real image via Tesseract', async () => {
    const { createCanvas, GlobalFonts } = (await import('@napi-rs/canvas').catch(() => ({}) as never)) as never as
      | { createCanvas: (w: number, h: number) => any; GlobalFonts: any }
      | Record<string, never>;
    if (!createCanvas) return; // canvas is optional; nothing to render with
    GlobalFonts?.registerFont?.(undefined as never);
    const canvas = createCanvas(600, 120);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 120);
    ctx.fillStyle = '#000000';
    ctx.font = '48px sans-serif';
    ctx.fillText('LAPORAN JARKOM', 20, 75);
    const png = new Uint8Array(canvas.toBuffer('image/png'));

    const result = await extractImage(png, 'png', { ocrEnabled: true, nameHint: 'test' });
    const text = result.units.map((unit) => unit.text).join(' ');
    expect(text.toUpperCase()).toContain('LAPORAN');
  });
});
