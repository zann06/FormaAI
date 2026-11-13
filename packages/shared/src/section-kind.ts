/**
 * Decides what kind of text a template heading expects.
 *
 * A campus template mixes two very different things under the same "heading"
 * label: prose sections ("1.1 Latar Belakang") and non-prose furniture (a cover
 * line "INSTITUT TEKNOLOGI SUMATERA", a "LEMBAR INFORMASI TUGAS" sheet, a
 * bibliography). Treating them all as prose made the generator write 250-word
 * essays *about* the cover — "Laporan ini disusun sebagai…" — instead of leaving
 * the cover alone, which is exactly the reported "hasilnya ga sesuai".
 */

export type SectionKind =
  /** A normal body section written from evidence. */
  | 'prose'
  /** Cover/title matter: reproduced as-is, never rewritten into paragraphs. */
  | 'identity'
  /** A form, rubric or sheet that should keep its template text. */
  | 'form'
  /** Front/back matter that is normally a list of references or attachments. */
  | 'listing';

export interface SectionKindInput {
  heading: string;
  level: number;
  /** True for the first few sections of the document, where covers live. */
  nearStart: boolean;
  /** True when Word marks this paragraph as the document title (style "Title"). */
  isTitleStyle?: boolean;
}

/**
 * Headings that name front/back matter rather than a discussion.
 *
 * Matched case-insensitively against the whole heading. Kept as plain strings
 * so the rules stay readable and easy to extend for other campus templates.
 */
const LISTING_HEADINGS = [
  'daftar pustaka',
  'daftar referensi',
  'referensi',
  'bibliography',
  'references',
  'daftar isi',
  'daftar tabel',
  'daftar gambar',
  'daftar lampiran',
  'lampiran',
  'appendix',
  'appendices',
];

/** Sheets and forms whose template text is the content. */
const FORM_HEADINGS = [
  'lembar informasi tugas',
  'lembar pengesahan',
  'lembar persetujuan',
  'lembar pernyataan',
  'rubrik penilaian',
  'rubrik',
  'form penilaian',
  'kartu bimbingan',
  'lembar asistensi',
  'catatan asisten',
];

/**
 * Words that mark a cover page. Institution and faculty lines are pure
 * identifiers — rewriting them produces nonsense such as a paragraph explaining
 * what a university is.
 */
const IDENTITY_PATTERNS: RegExp[] = [
  /^institut\s/i,
  /^universitas\s/i,
  /^sekolah\s+tinggi\s/i,
  /^politeknik\s/i,
  /^akademi\s/i,
  /^fakultas\s/i,
  /^program\s+studi\s/i,
  /^jurusan\s/i,
  /^departemen\s/i,
  /laporan\s+tugas\s+(besar|mandiri|akhir)/i,
  /^tugas\s+(besar|mandiri|akhir)/i,
  /^proposal\s+(tugas|skripsi|ta)/i,
  /^skripsi$/i,
  /^thesis$/i,
  /^(nama|nim|nrp|kelas|mata\s+kuliah|dosen|program\s+studi)\s*[:：]/i,
  /^disusun\s+oleh/i,
  /^oleh\s*[:：]/i,
];

/**
 * A cover is defined by its position as much as its words: the first lines of a
 * document are title matter even when they say something unusual.
 */
export function classifySection(input: SectionKindInput): SectionKind {
  const heading = input.heading.trim();
  const lower = heading.toLowerCase();

  // An explicit Title style settles it: this paragraph is the document's own
  // title, not a chapter, so its text must be left exactly as the template has it.
  if (input.isTitleStyle) return 'identity';

  if (LISTING_HEADINGS.some((name) => lower === name || lower.startsWith(`${name} `))) {
    return 'listing';
  }
  if (FORM_HEADINGS.some((name) => lower.includes(name))) {
    return 'form';
  }
  if (IDENTITY_PATTERNS.some((pattern) => pattern.test(heading))) {
    return 'identity';
  }

  // A short, unnumbered line near the start is cover text: "LAMPUNG SELATAN
  // 2026", a university name split across lines, a title in capitals.
  //
  // Position alone is not enough. Every report starts with a short heading, and
  // treating them all as cover matter meant "Introduction" was left to the
  // template and reported as "not missing" — a chapter the user asked to be
  // written, silently skipped. So the line must also *look* like cover text:
  // typed in capitals, or naming a place/date, or a single bare word pairing.
  const looksNumbered = /^(\d+(\.\d+)*|[IVX]+\.|bab\s)/i.test(heading);
  const wordCount = heading.split(/\s+/).filter(Boolean).length;
  if (input.nearStart && !looksNumbered && wordCount <= 12 && looksLikeCoverLine(heading)) {
    return 'identity';
  }

  return 'prose';
}

/**
 * True for the typographic shape of a cover line, as distinct from a chapter.
 *
 * Campus covers are set in capitals ("INSTITUT TEKNOLOGI SUMATERA"), or end in a
 * place and year ("LAMPUNG SELATAN 2026", "Bandar Lampung, 2026"). A chapter
 * heading such as "Introduction" or "Pendahuluan" has neither, so it stays prose.
 */
function looksLikeCoverLine(heading: string): boolean {
  const letters = heading.replace(/[^\p{L}]/gu, '');
  // All-capitals lines: cover matter almost always is, chapters rarely are.
  if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return true;
  }
  // A trailing year is the giveaway on the place/date line of a cover.
  if (/\b(19|20)\d{2}\b/.test(heading)) {
    return true;
  }
  return false;
}

/**
 * Sections that must not be generated from scratch because their text comes
 * from the template itself.
 *
 * The exporter keeps the template's own run formatting for these, so filling
 * them with generated prose both duplicates the cover and destroys its layout.
 */
export function shouldKeepTemplateText(kind: SectionKind): boolean {
  return kind === 'identity' || kind === 'form';
}

/**
 * Whether a section should receive a generated body at all.
 *
 * `listing` sections (bibliography, appendices) are not written from evidence:
 * they list the user's own submitted figures and attachments.
 */
export function isDraftable(kind: SectionKind): boolean {
  return kind === 'prose';
}

/**
 * True when a heading is a CHAPTER DIVIDER that legitimately holds no prose.
 *
 * "BAB I: PENDAHULUAN" is a label above 1.1, 1.2, 1.3 — a real campus template
 * writes nothing under it, and the document reads correctly that way. Counting it as
 * an empty section made the assistant report "36 of 44 written, 2 could not be
 * drafted" on a report that was actually complete, which reads as failure to the user
 * and pushes them to "fix" something that is not broken.
 *
 * Deliberately narrow: only a bare chapter marker ("BAB IV", "BAB 4", "CHAPTER II")
 * with no extra title text beyond it qualifies. "BAB I: PENDAHULUAN" is a divider too,
 * because the chapter number is present. "Pendahuluan" on its own is NOT — some
 * templates number chapters as plain prose sections and those must be written.
 */
export function isChapterDivider(heading: string): boolean {
  const trimmed = heading.trim();
  if (!trimmed) return false;
  // "BAB I", "BAB 4", "BAB IV: TINJAUAN PUSTAKA", "CHAPTER 2: METHOD"
  if (/^(bab|chapter)\s+([ivxlcdm]+|\d+)\b/i.test(trimmed)) return true;
  return false;
}
