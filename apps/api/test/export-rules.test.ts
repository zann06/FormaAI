import { describe, expect, it } from 'vitest';
import { isPlaceholderOnly } from '../src/services/export/index.js';

/**
 * Export refuses to build a document with genuinely empty required sections.
 * A "[MISSING: ...]" marker is different: generation writes it deliberately when
 * no evidence could be mapped, so the gap is visible inside the report. Treating
 * that marker as "empty" blocked an otherwise finished 40-section report behind
 * four cover-page/appendix sections that no source could ever fill.
 */
describe('isPlaceholderOnly', () => {
  it('recognises a bare placeholder', () => {
    expect(
      isPlaceholderOnly('[MISSING: no source material was mapped to this section. Upload evidence or enter the content manually.]'),
    ).toBe(true);
  });

  it('recognises a placeholder with surrounding whitespace', () => {
    expect(isPlaceholderOnly('\n  [MISSING: 6.1 Kesimpulan]  \n')).toBe(true);
  });

  it('treats real prose as content', () => {
    expect(isPlaceholderOnly('Bab ini menjelaskan hasil pengujian jaringan.')).toBe(false);
  });

  it('treats prose plus a placeholder as content', () => {
    // Partially written: the author is working on it, so it is not "empty".
    expect(isPlaceholderOnly('Hasil pengujian menunjukkan penurunan latensi. [MISSING: tanggal]')).toBe(false);
  });

  it('does not treat genuinely empty content as a placeholder', () => {
    expect(isPlaceholderOnly('')).toBe(false);
    expect(isPlaceholderOnly(null)).toBe(false);
    expect(isPlaceholderOnly(undefined)).toBe(false);
    expect(isPlaceholderOnly('   ')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPlaceholderOnly('[missing: something]')).toBe(true);
  });
});
