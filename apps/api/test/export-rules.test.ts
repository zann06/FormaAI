import { describe, expect, it } from 'vitest';
import { identityReplacements, isPlaceholderOnly, missingCoverFields } from '../src/services/export/index.js';

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

/**
 * Test 6 shipped with `[ Tuliskan Nama Lengkap Anda ]` still on the cover because
 * the project had no instructions and nothing ever asked for them. The check below
 * is what lets the export job tell the chat which details are missing.
 */
describe('missingCoverFields', () => {
  const blankCover =
    'LAPORAN TUGAS\n[ Tuliskan Nama Lengkap Anda ]\n[ Tuliskan NIM Anda ]\n[ RA / RB / RC / RD ]\n[ Tuliskan Tanggal Pengumpulan ]';

  it('names every prompt still present in the assembled document', () => {
    expect(missingCoverFields(blankCover)).toEqual(['Nama', 'NIM', 'Kelas', 'Tanggal']);
  });

  it('reports only the fields that were not replaced', () => {
    const partly = blankCover
      .replace('[ Tuliskan Nama Lengkap Anda ]', 'Farid Rizky Fauzan')
      .replace('[ Tuliskan NIM Anda ]', '124140210');
    expect(missingCoverFields(partly)).toEqual(['Kelas', 'Tanggal']);
  });

  it('says nothing when the cover is complete', () => {
    expect(missingCoverFields('Farid Rizky Fauzan\n124140210\nRA\n20 November 2026')).toEqual([]);
  });

  it('replaces the same prompts the detector looks for', () => {
    const replacements = identityReplacements('Nama: Farid\nNIM: 124140210\nKelas: RA\nTanggal: 20 November 2026');
    let filled = blankCover;
    for (const { find, replace } of replacements) filled = filled.replace(find, replace);
    expect(missingCoverFields(filled)).toEqual([]);
  });
});
