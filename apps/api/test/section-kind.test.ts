import { describe, expect, it } from 'vitest';
import { classifySection, isChapterDivider, isDraftable, shouldKeepTemplateText } from '@formaai/shared';

/**
 * The template of the real reported project is the fixture: sections 0–5 are
 * cover matter at levels 1–3, interleaved with genuine chapters also at level 1.
 * Level alone cannot separate them, which is why classification uses the wording
 * and the position as well.
 */
describe('classifySection', () => {
  const coverHeadings = [
    'INSTITUT TEKNOLOGI SUMATERA',
    'FAKULTAS TEKNOLOGI INDUSTRI',
    'PROGRAM STUDI TEKNIK INFORMATIKA',
    'LAPORAN TUGAS BESAR / TUGAS MANDIRI 09',
    'LAMPUNG SELATAN\n2026',
  ];

  it('classifies every cover line of the reported template as identity', () => {
    for (const heading of coverHeadings) {
      expect(classifySection({ heading, level: 1, nearStart: true })).toBe('identity');
    }
  });

  it('classifies a rubric sheet as a form', () => {
    expect(
      classifySection({ heading: 'LEMBAR INFORMASI TUGAS & RUBRIK PENILAIAN', level: 2, nearStart: true }),
    ).toBe('form');
  });

  it('classifies a bibliography and an appendix as listings', () => {
    expect(classifySection({ heading: 'DAFTAR PUSTAKA', level: 1, nearStart: false })).toBe('listing');
    expect(classifySection({ heading: 'LAMPIRAN', level: 1, nearStart: false })).toBe('listing');
    expect(classifySection({ heading: 'Daftar Gambar', level: 1, nearStart: false })).toBe('listing');
  });

  it('keeps real chapters as prose', () => {
    const chapters = [
      'BAB I: PENDAHULUAN',
      '1.1 Latar Belakang',
      '2.3 Tabel Alokasi Pengalamatan IP',
      'BAB III: HASIL DAN PEMBAHASAN',
      '6.1 Kesimpulan',
    ];
    for (const heading of chapters) {
      // Same level, same position band as some cover lines: only the wording differs.
      expect(classifySection({ heading, level: 1, nearStart: true })).toBe('prose');
    }
  });

  it('does not treat a numbered chapter as cover text even at the very start', () => {
    expect(classifySection({ heading: 'BAB I: PENDAHULUAN', level: 1, nearStart: true })).toBe('prose');
  });

  /**
   * Position alone must not decide. Every report opens with a short heading, so
   * a "nearStart" rule that caught them all left "Introduction" to the template
   * and reported it as "not missing" — a chapter the user asked for, skipped.
   */
  it('does not treat an ordinary short chapter heading as cover text', () => {
    for (const heading of ['Introduction', 'Pendahuluan', 'Conclusion', 'Kesimpulan', 'Metodologi']) {
      expect(classifySection({ heading, level: 1, nearStart: true })).toBe('prose');
    }
  });

  it('still recognises a place-and-date cover line', () => {
    expect(classifySection({ heading: 'Bandar Lampung, 2026', level: 3, nearStart: true })).toBe('identity');
  });

  /**
   * A title-case title ("Quarterly Activity Report") is indistinguishable from a
   * chapter by wording alone. Word's own Title style is the deciding signal, and
   * without it the exporter wrote an essay directly under the report's title.
   */
  it('treats a paragraph styled as the document title as cover matter', () => {
    expect(
      classifySection({ heading: 'Quarterly Activity Report', level: 1, nearStart: true, isTitleStyle: true }),
    ).toBe('identity');
    // The same words with an ordinary heading style are a chapter.
    expect(
      classifySection({ heading: 'Quarterly Activity Report', level: 1, nearStart: true, isTitleStyle: false }),
    ).toBe('prose');
  });

  it('does not treat a later unnumbered line as cover text', () => {
    // Position matters: away from the start, a short heading is just a heading.
    expect(classifySection({ heading: 'Catatan Penutup', level: 2, nearStart: false })).toBe('prose');
  });

  it('recognises an explicit identity field', () => {
    expect(classifySection({ heading: 'Nama: __________', level: 2, nearStart: true })).toBe('identity');
    expect(classifySection({ heading: 'Disusun oleh', level: 2, nearStart: true })).toBe('identity');
  });
});

describe('isDraftable', () => {
  it('drafts only prose sections', () => {
    expect(isDraftable('prose')).toBe(true);
    expect(isDraftable('identity')).toBe(false);
    expect(isDraftable('form')).toBe(false);
    expect(isDraftable('listing')).toBe(false);
  });
});

describe('shouldKeepTemplateText', () => {
  /**
   * This is the rule behind the reported defect: the cover was generated as
   * 1.5 KB of "Laporan ini disusun sebagai…" prose. Cover and form sections must
   * keep the template's own text so the layout and wording survive.
   */
  it('keeps cover and form text, but replaces listing stubs', () => {
    expect(shouldKeepTemplateText('identity')).toBe(true);
    expect(shouldKeepTemplateText('form')).toBe(true);
    expect(shouldKeepTemplateText('prose')).toBe(false);
    expect(shouldKeepTemplateText('listing')).toBe(false);
  });
});

/**
 * The reported report was called "36 of 44 written, 2 could not be drafted" while
 * one of the two was only the label "BAB I: PENDAHULUAN" above 1.1–1.3. A chapter
 * marker is allowed to be empty; a real section is not.
 */
describe('isChapterDivider', () => {
  it('recognises a bare chapter marker in either language and numbering style', () => {
    for (const heading of [
      'BAB I: PENDAHULUAN',
      'BAB IV',
      'BAB 4',
      'BAB III: HASIL DAN PEMBAHASAN',
      'CHAPTER II',
      'Chapter 2: Method',
      'BAB I: PENDAHULUAN DAN LATAR BELAKANG MASALAH',
      '  BAB V: PENUTUP  ',
    ]) {
      expect(isChapterDivider(heading)).toBe(true);
    }
  });

  it('does not excuse a real section that merely starts with the word bab', () => {
    for (const heading of ['Pendahuluan', 'BAB', 'Babylonia', 'BAB IAN', '1.1 Latar Belakang']) {
      expect(isChapterDivider(heading)).toBe(false);
    }
  });

  it('never treats an empty heading as a divider', () => {
    expect(isChapterDivider('')).toBe(false);
    expect(isChapterDivider('   ')).toBe(false);
  });
});
