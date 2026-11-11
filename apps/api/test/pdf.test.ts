import { describe, expect, it } from 'vitest';
import { assertPdf, validatePdf } from '../src/services/export/pdf.js';

/**
 * A real, minimal single-page PDF containing the text "FormaAI".
 *
 * Hand-written rather than generated so this test needs no converter and runs
 * everywhere (CI included).
 */
function minimalPdf(text: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // content stream, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('PDF conversion helpers', () => {
  it('accepts a real PDF and rejects non-PDF bytes', () => {
    expect(() => assertPdf(minimalPdf('FormaAI'))).not.toThrow();
    expect(() => assertPdf(new Uint8Array(Buffer.from('not a pdf at all, just text padding'.padEnd(200, '.')))))
      .toThrow(/not a valid PDF/);
    expect(() => assertPdf(new Uint8Array(10))).toThrow(/empty/);
  });

  it('validates a PDF without detaching the caller\u2019s buffer', async () => {
    // Regression test: pdf.js transfers (detaches) the ArrayBuffer it is handed.
    // validatePdf used to pass the caller's bytes directly, so the very next use
    // of those bytes (writing the PDF to storage) threw
    // "Cannot perform Construct on a detached ArrayBuffer".
    const bytes = minimalPdf('FormaAI');
    const before = bytes.byteLength;

    const result = await validatePdf(bytes);

    expect(result.pageCount).toBe(1);
    expect(result.textChars).toBeGreaterThan(0);
    // The buffer must still be usable after validation.
    expect(bytes.byteLength).toBe(before);
    expect(assertPdf(bytes)).toBeUndefined();
    // ...and copyable / storable as a normal Buffer.
    expect(Buffer.from(bytes).length).toBe(before);
  });
});
