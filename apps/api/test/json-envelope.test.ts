import { describe, expect, it } from 'vitest';
import {
  looksLikeSerialisedSection,
  normaliseEscapes,
  unwrapJsonBody,
} from '../src/services/generation/schemas.js';

/**
 * Regression cover for the bug that put raw JSON into an exported report.
 *
 * The plain-prose retry asked the model to stop emitting JSON, accepted whatever
 * came back on a length check, and stored it. When the model replied with the full
 * section envelope anyway, `{"section": ..., "body": ..., "warnings": [...]}`
 * became the section body and was rendered into the finished PDF — three sections
 * of a real assignment shipped as a JSON dump with visible `\n` escapes.
 */
describe('unwrapJsonBody', () => {
  it('extracts the body from the envelope the model actually returned', () => {
    const reply = JSON.stringify({
      section: '1.2 Tujuan Tugas Mandiri',
      body: 'Tugas mandiri ini bertujuan untuk memverifikasi konfigurasi pengalamatan IPv4.',
      table: null,
      warnings: ['Evidence for the DHCP pool was thin.'],
    });

    const result = unwrapJsonBody(reply);
    expect(result.unwrapped).toBe(true);
    expect(result.body).toBe('Tugas mandiri ini bertujuan untuk memverifikasi konfigurasi pengalamatan IPv4.');
    // The envelope itself must not survive anywhere in the body.
    expect(result.body).not.toContain('"section"');
    expect(result.body).not.toContain('{');
  });

  it('converts escaped newlines so paragraph breaks survive export', () => {
    // Double-encoded replies leave the two characters `\` and `n` behind, which
    // PDF export prints literally in the middle of a sentence.
    const reply = '{"body": "Paragraf pertama.\\n\\nParagraf kedua."}';
    const result = unwrapJsonBody(reply);
    expect(result.unwrapped).toBe(true);
    expect(result.body).toBe('Paragraf pertama.\n\nParagraf kedua.');
    expect(result.body).not.toContain('\\n');
  });

  it('unwraps a reply that was fenced in markdown', () => {
    const reply = '```json\n{"body": "Isi seksi dari balasan berpagar."}\n```';
    const result = unwrapJsonBody(reply);
    expect(result.unwrapped).toBe(true);
    expect(result.body).toBe('Isi seksi dari balasan berpagar.');
  });

  it('accepts the near-miss field names models use', () => {
    expect(unwrapJsonBody('{"content": "Isi lewat field content."}').body).toBe('Isi lewat field content.');
    expect(unwrapJsonBody('{"text": "Isi lewat field text."}').body).toBe('Isi lewat field text.');
  });

  it('leaves genuine prose untouched', () => {
    const prose = 'Laporan ini menyusun temuan secara berurutan sesuai template kampus.';
    const result = unwrapJsonBody(prose);
    expect(result.unwrapped).toBe(false);
    expect(result.body).toBe(prose);
  });

  it('leaves prose that merely starts with a brace untouched', () => {
    // A body may legitimately begin with `{` (a CS assignment discussing JSON).
    const prose = '{konfigurasi} adalah contoh notasi yang dipakai pada dokumentasi jaringan.';
    const result = unwrapJsonBody(prose);
    expect(result.unwrapped).toBe(false);
    expect(result.body).toBe(prose);
  });

  it('reports an envelope with no usable body instead of returning braces', () => {
    const result = unwrapJsonBody('{"section": "BAB I", "warnings": []}');
    expect(result.unwrapped).toBe(true);
    expect(result.body).toBe('');
  });
});

describe('normaliseEscapes', () => {
  it('turns escaped whitespace into real whitespace', () => {
    expect(normaliseEscapes('a\\nb')).toBe('a\nb');
    expect(normaliseEscapes('a\\r\\nb')).toBe('a\nb');
    expect(normaliseEscapes('a\\tb')).toBe('a\tb');
    expect(normaliseEscapes('kata \\"kutip\\"')).toBe('kata "kutip"');
  });

  it('leaves text without escapes unchanged', () => {
    const text = 'Tidak ada escape di sini.';
    expect(normaliseEscapes(text)).toBe(text);
  });
});

describe('looksLikeSerialisedSection', () => {
  it('detects the stored envelope that corrupted the report', () => {
    const stored = '{"section": "BAB I: PENDAHULUAN", "body": "Laporan pengujian ini disusun...", "warnings": []}';
    expect(looksLikeSerialisedSection(stored)).toBe(true);
  });

  it('detects an envelope even when it is only partially serialised', () => {
    expect(looksLikeSerialisedSection('{"body": "isi", "warnings": []}')).toBe(true);
  });

  it('does not flag normal prose', () => {
    expect(looksLikeSerialisedSection('Laporan pengujian ini disusun dalam kerangka Tugas Mandiri.')).toBe(false);
  });

  it('does not flag prose that happens to discuss JSON', () => {
    const prose = 'Format pertukaran data menggunakan objek dengan kunci "body" dan "warnings" di dalamnya.';
    expect(looksLikeSerialisedSection(prose)).toBe(false);
  });

  it('does not flag a body that starts and ends with braces but is not JSON', () => {
    expect(looksLikeSerialisedSection('{ "body": ini bukan json }')).toBe(false);
  });

  it('does not flag a JSON array, which is never a section body', () => {
    expect(looksLikeSerialisedSection('[{"body": "x"}]')).toBe(false);
  });
});
