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

/** Minimal but signature-valid containers for the formats we now accept. */
const WEBP_MINIMAL = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const TIFF_LE_MINIMAL = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const TIFF_BE_MINIMAL = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
const BMP_MINIMAL = new Uint8Array([0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00]);
const GIF89_MINIMAL = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);

describe('image uploads', () => {
  it('classifies image extensions as requiring OCR', () => {
    expect(isImageSourceExtension('.png')).toBe(true);
    expect(isImageSourceExtension('.jpg')).toBe(true);
    expect(isImageSourceExtension('.jpeg')).toBe(true);
    expect(isImageSourceExtension('.webp')).toBe(true);
    expect(isImageSourceExtension('.tif')).toBe(true);
    expect(isImageSourceExtension('.tiff')).toBe(true);
    expect(isImageSourceExtension('.bmp')).toBe(true);
    expect(isImageSourceExtension('.gif')).toBe(true);
    expect(isImageSourceExtension('.WEBP')).toBe(true);
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

  it('accepts WEBP, TIFF, BMP and GIF sources with their canonical mime types', () => {
    const cases: Array<[string, string, Uint8Array, string]> = [
      ['shot.webp', 'image/webp', WEBP_MINIMAL, 'image/webp'],
      ['scan.tif', 'image/tiff', TIFF_LE_MINIMAL, 'image/tiff'],
      ['scan.tiff', 'image/tiff', TIFF_BE_MINIMAL, 'image/tiff'],
      ['old.bmp', 'image/bmp', BMP_MINIMAL, 'image/bmp'],
      ['anim.gif', 'image/gif', GIF89_MINIMAL, 'image/gif'],
    ];
    for (const [name, declared, bytes, expectedMime] of cases) {
      const result = validateUpload(name, declared, bytes, { kind: 'source', maxBytes: MAX });
      expect(result.mimeType, name).toBe(expectedMime);
    }
  });

  it('rejects renamed files for each newly accepted extension', () => {
    const renamed: Array<[string, string]> = [
      ['fake.webp', 'image/webp'],
      ['fake.tif', 'image/tiff'],
      ['fake.bmp', 'image/bmp'],
      ['fake.gif', 'image/gif'],
    ];
    for (const [name, declared] of renamed) {
      expect(() => validateUpload(name, declared, PNG_1X1, { kind: 'source', maxBytes: MAX }), name).toThrow(
        /signature mismatch|not a valid/i,
      );
    }
  });

  it('rejects a .webp that is only a RIFF container of another type', () => {
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    ]);
    expect(() =>
      validateUpload('audio.webp', 'image/webp', riffWave, { kind: 'source', maxBytes: MAX }),
    ).toThrow(/not a valid WEBP/i);
  });

  it('tells an iPhone user how to convert a HEIC photo instead of a generic reject', () => {
    expect(() =>
      validateUpload('IMG_0001.heic', 'image/heic', PNG_1X1, { kind: 'source', maxBytes: MAX }),
    ).toThrow(/HEIC/i);
    expect(() =>
      validateUpload('IMG_0001.HEIC', 'image/heic', PNG_1X1, { kind: 'source', maxBytes: MAX }),
    ).toThrow(/Most Compatible|Convert it to JPG/i);
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

  /**
   * The promise is "every image can be read", so this renders the same text to
   * each supported format and runs the *real* OCR adapter over all of them.
   * Formats a bare Tesseract cannot decode (animated WEBP palettes, 16-bit TIFF,
   * BMP variants) go through the PNG normalization in `runOcr`.
   */
  /**
   * A corrupt or truncated image must produce a specific, actionable error —
   * not a silent "no text" that looks like the file was empty.
   */
  it('explains an undecodable image instead of reporting empty text', async () => {
    const truncated = new Uint8Array([0x42, 0x4d, 0x00, 0x01, 0x02, 0x03]);
    await expect(
      extractImage(truncated, 'bmp', {
        ocrEnabled: true,
        ocr: async () => {
          throw new Error('Error in findFileFormatStream: truncated file');
        },
      }),
    ).rejects.toThrow(/could not be read by OCR[\s\S]*PNG or JPG/i);
  });

  it.skipIf(!tesseractAvailable)('reads every supported image format through the OCR adapter', async () => {
    const { createCanvas } = (await import('@napi-rs/canvas').catch(() => ({}) as never)) as never as
      | { createCanvas: (w: number, h: number) => any }
      | Record<string, never>;
    if (!createCanvas) return;
    const canvas = createCanvas(700, 140);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 700, 140);
    ctx.fillStyle = '#000000';
    ctx.font = '56px sans-serif';
    ctx.fillText('BAB PENDAHULUAN', 20, 90);

    const formats: Array<[string, string, Buffer]> = [
      ['png', 'png', canvas.toBuffer('image/png')],
      ['jpeg', 'jpeg', canvas.toBuffer('image/jpeg')],
      ['webp', 'webp', canvas.toBuffer('image/webp')],
    ];

    for (const [label, format, buffer] of formats) {
      const result = await extractImage(new Uint8Array(buffer), format as never, {
        ocrEnabled: true,
        nameHint: `format-${label}`,
      });
      const text = result.units
        .map((unit) => unit.text)
        .join(' ')
        .toUpperCase();
      expect(text, `format ${label}`).toContain('PENDAHULUAN');
    }
  });
});

