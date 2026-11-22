import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { analyzeDocumentXml, headingPatternLevel } from './analyze.js';
import { assembleDocx } from './assemble.js';
import { buildFixtureDocx } from './fixtures.js';
import { parseXml } from './xml.js';

/**
 * Audit of the automatic, template-driven path against the shapes a real student
 * assignment actually takes.
 *
 * The existing engine tests mostly use one well-behaved template: `Heading1`
 * styles, `{{tokens}}`, tidy structure. Real handouts are messier — lecturers
 * number chapters by hand ("BAB I", "1.1", "A."), type headings as bold body text
 * with no style at all, paste rubric tables between sections, and duplicate a
 * heading inside the appendix. Each of those is handled by a different heuristic
 * in `analyze`/`assemble`, and they were never exercised together.
 *
 * Assertions describe observable output (what a person opening the .docx sees)
 * rather than internal counters, so they hold as the heuristics evolve.
 */

const ZIP = (bytes: Uint8Array) => JSZip.loadAsync(bytes);

async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await ZIP(bytes);
  return zip.file('word/document.xml')!.async('string');
}

/** Reads the text of every body-level paragraph, in document order. */
async function paragraphTexts(bytes: Uint8Array): Promise<string[]> {
  const [root] = parseXml(await documentXml(bytes));
  const body = root!.children.find((child) => child.tag === 'w:body')!;
  return body.children
    .filter((child) => child.tag === 'w:p')
    .map((paragraph) =>
      paragraph.children
        .filter((run) => run.tag === 'w:r')
        .flatMap((run) => run.children.filter((node) => node.tag === 'w:t'))
        .map((text) => text.children.map((node) => (node.tag === '#text' ? (node.text ?? '') : '')).join(''))
        .join(''),
    );
}

async function analyze(bytes: Uint8Array) {
  const zip = await ZIP(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? null;
  const coreXml = (await zip.file('docProps/core.xml')?.async('string')) ?? null;
  return analyzeDocumentXml(xml, stylesXml, coreXml);
}

describe('template analysis across assignment shapes', () => {
  it('finds hand-numbered chapters that carry no heading style', async () => {
    // A very common handout: every "heading" is plain body text, and the chapter
    // order is expressed only by the words "BAB I", "BAB II".
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Normal', bold: true },
        { text: 'Latar belakang masalah ditulis di sini.' },
        { text: 'BAB II TINJAUAN PUSTAKA', styleId: 'Normal', bold: true },
        { text: 'Teori yang relevan.' },
        { text: 'BAB III METODOLOGI', styleId: 'Normal', bold: true },
        { text: 'Metode penelitian.' },
      ],
    });

    const structure = await analyze(docx);
    const headings = structure.headings.map((heading) => heading.text);
    expect(headings).toContain('BAB I PENDAHULUAN');
    expect(headings).toContain('BAB II TINJAUAN PUSTAKA');
    expect(headings).toContain('BAB III METODOLOGI');
  });

  it('ranks a numeric hierarchy by depth so sub-sections nest under their chapter', async () => {
    expect(headingPatternLevel('1 Pendahuluan')).toBe(1);
    expect(headingPatternLevel('1.1 Latar Belakang')).toBe(2);
    expect(headingPatternLevel('1.1.1 Rumusan Masalah')).toBe(3);
    expect(headingPatternLevel('BAB IV HASIL')).toBe(1);
    expect(headingPatternLevel('A. Latar Belakang')).toBe(2);

    const docx = buildFixtureDocx({
      body: [
        { text: '1 Pendahuluan', styleId: 'Normal', bold: true },
        { text: '1.1 Latar Belakang', styleId: 'Normal', bold: true },
        { text: 'Isi latar belakang.' },
        { text: '1.2 Tujuan', styleId: 'Normal', bold: true },
        { text: 'Isi tujuan.' },
        { text: '2 Pembahasan', styleId: 'Normal', bold: true },
        { text: 'Isi pembahasan.' },
      ],
    });

    const structure = await analyze(docx);
    const levels = new Map(structure.headings.map((heading) => [heading.text, heading.level]));
    expect(levels.get('1 Pendahuluan')).toBe(1);
    expect(levels.get('1.1 Latar Belakang')).toBe(2);
    expect(levels.get('1.2 Tujuan')).toBe(2);
    expect(levels.get('2 Pembahasan')).toBe(1);
  });

  it('recognises custom organisational heading styles by outline level', async () => {
    // Schools ship their own style ids ("JudulBab"). Keying off the literal id
    // "Heading1" misses every one of them.
    const docx = buildFixtureDocx({
      customStyles: [
        { id: 'JudulBab', name: 'Judul Bab', outlineLevel: 0, bold: true, size: 32 },
        { id: 'SubBab', name: 'Sub Bab', outlineLevel: 1, bold: true, size: 28 },
      ],
      body: [
        { text: 'PENDAHULUAN', styleId: 'JudulBab' },
        { text: 'Konteks penelitian.', styleId: 'Normal' },
        { text: 'Rumusan Masalah', styleId: 'SubBab' },
        { text: 'Rumusan ditulis di sini.', styleId: 'Normal' },
      ],
    });

    const structure = await analyze(docx);
    const headings = structure.headings.map((heading) => heading.text);
    expect(headings).toContain('PENDAHULUAN');
    expect(headings).toContain('Rumusan Masalah');
  });

  it('does not treat a bold label inside a table as a chapter heading', async () => {
    // Rubric sheets put heavy bold text in table cells. Counting those as headings
    // inflated the outline and pushed generated content into the rubric.
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Isi pendahuluan.' },
        {
          table: {
            rows: [
              ['KOMPONEN PENILAIAN', 'BOBOT'],
              ['Sistematika', '20%'],
            ],
          },
        },
      ],
    });

    const structure = await analyze(docx);
    const headings = structure.headings.map((heading) => heading.text);
    expect(headings).toContain('BAB I PENDAHULUAN');
    expect(headings.some((heading) => /KOMPONEN PENILAIAN/i.test(heading))).toBe(false);
  });
});

describe('assembly keeps the template intact across assignment shapes', () => {
  it('writes generated text once under a hand-numbered chapter', async () => {
    const generated = 'Paragraf hasil generasi untuk bab pertama.';
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Normal', bold: true },
        { text: 'Teks asli template yang harus diganti.' },
        { text: 'BAB II TINJAUAN PUSTAKA', styleId: 'Normal', bold: true },
        { text: 'Teks asli bab kedua.' },
      ],
    });

    const structure = await analyze(docx);
    const first = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: first.id,
          headingText: first.text,
          paragraphIndex: first.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: generated,
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    // Exactly once: a duplicated write is the classic "chapter printed twice" bug.
    expect(joined.split(generated).length - 1).toBe(1);
    // The template's own headings survive untouched.
    expect(joined).toContain('BAB I PENDAHULUAN');
    expect(joined).toContain('BAB II TINJAUAN PUSTAKA');
  });

  it('keeps content inside its own chapter instead of bleeding into the next', async () => {
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Isi asli satu.' },
        { text: 'BAB II TINJAUAN PUSTAKA', styleId: 'Heading1' },
        { text: 'Isi asli dua.' },
      ],
    });

    const structure = await analyze(docx);
    const first = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const second = structure.headings.find((heading) => heading.text === 'BAB II TINJAUAN PUSTAKA')!;

    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: first.id,
          headingText: first.text,
          paragraphIndex: first.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'MARKER_SATU',
        },
        {
          sectionId: second.id,
          headingText: second.text,
          paragraphIndex: second.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'MARKER_DUA',
        },
      ],
    });

    const texts = await paragraphTexts(result.buffer);
    const indexOf = (text: string) => texts.findIndex((line) => line.includes(text));
    // Each marker must land after its own heading and before the next one.
    expect(indexOf('BAB I PENDAHULUAN')).toBeLessThan(indexOf('MARKER_SATU'));
    expect(indexOf('MARKER_SATU')).toBeLessThan(indexOf('BAB II TINJAUAN PUSTAKA'));
    expect(indexOf('BAB II TINJAUAN PUSTAKA')).toBeLessThan(indexOf('MARKER_DUA'));
  });

  it('writes a real Word table for a rubric table rather than flattening it', async () => {
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Ringkasan hasil.',
          table: { columns: ['No', 'Temuan'], rows: [['1', 'Sistem berjalan']] },
        },
      ],
    });

    const xml = await documentXml(result.buffer);
    // A pipe-table flattened into paragraphs would contain no new <w:tbl>.
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Sistem berjalan');
    expect(result.insertedTables).toBeGreaterThan(0);
  });

  it('reports a section it could not place instead of silently dropping it', async () => {
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: 'ghost',
          headingText: 'BAB YANG TIDAK ADA',
          paragraphIndex: 999,
          insertionStrategy: 'after_heading',
          content: 'Teks yang tidak akan pernah muncul.',
        },
      ],
    });

    // A missing chapter must fail the fidelity check, not quietly pass.
    expect(result.fidelity.passed).toBe(false);
    expect(result.fidelity.warnings.length).toBeGreaterThan(0);
  });

  it('preserves header and footer text when a section is written', async () => {
    const docx = buildFixtureDocx({
      headerText: 'UNIVERSITAS CONTOH',
      footerText: 'Halaman | 1',
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Isi baru.',
        },
      ],
    });

    const zip = await ZIP(result.buffer);
    const headerName = Object.keys(zip.files).find((name) => /^word\/header\d*\.xml$/.test(name))!;
    const footerName = Object.keys(zip.files).find((name) => /^word\/footer\d*\.xml$/.test(name))!;
    expect(await zip.file(headerName)!.async('string')).toContain('UNIVERSITAS CONTOH');
    expect(await zip.file(footerName)!.async('string')).toContain('Halaman');
    expect(result.fidelity.headersPreserved).toBe(true);
    expect(result.fidelity.footersPreserved).toBe(true);
  });

  it('fills a "{{token}}" placeholder split across Word runs', async () => {
    // Word splits tokens across runs whenever the author edits mid-word, so a naive
    // string replace on one run's text silently finds nothing.
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi_pendahuluan}}', splitRuns: true },
      ],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'placeholder',
          placeholder: 'isi_pendahuluan',
          content: 'Isi yang mengisi placeholder.',
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    expect(joined).toContain('Isi yang mengisi placeholder.');
    // The raw token must be gone, in however many runs it was written.
    expect(joined).not.toContain('{{');
    expect(result.replacedPlaceholders).toBeGreaterThan(0);
  });

  it('does not print a chapter twice when the template repeats its token', async () => {
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi}}' },
        { text: '{{isi}}' },
      ],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'placeholder',
          placeholder: 'isi',
          content: 'ISI_TUNGGAL',
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    expect(joined.split('ISI_TUNGGAL').length - 1).toBe(1);
  });

  it('leaves an appendix heading with the same text as a chapter alone', async () => {
    // "LAMPIRAN" and a duplicated title are common; keying sections by heading text
    // alone made the second one receive the first one's content.
    const docx = buildFixtureDocx({
      body: [
        { text: 'PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Isi pendahuluan asli.' },
        { text: 'LAMPIRAN', styleId: 'Heading1' },
        { text: 'Isi lampiran asli.' },
        { text: 'PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Lampiran salinan pendahuluan.' },
      ],
    });

    const structure = await analyze(docx);
    const first = structure.headings[0]!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: first.id,
          headingText: first.text,
          paragraphIndex: first.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'HANYA_SEKALI',
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    expect(joined.split('HANYA_SEKALI').length - 1).toBe(1);
    // The appendix copy of the heading keeps its own template text.
    expect(joined).toContain('Lampiran salinan pendahuluan.');
  });

  it('keeps bullet and numbering structure of the template when inserting prose', async () => {
    const docx = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Poin pertama template', numberingLevel: 0 },
        { text: 'Poin kedua template', numberingLevel: 0 },
      ],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Paragraf baru.',
        },
      ],
    });

    const xml = await documentXml(result.buffer);
    // The template's numbering definitions must survive the edit.
    expect(xml).toContain('<w:numPr>');
    expect((await paragraphTexts(result.buffer)).join('\n')).toContain('Poin pertama template');
  });

  it('does not leak Markdown emphasis markers into the finished document', async () => {
    // The generator is told to return plain prose, but when it emits "**bold**" the
    // asterisks must not end up printed in the .docx.
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Ini **penting** dan ini `kode`.',
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    expect(joined).not.toContain('**');
    expect(joined).not.toContain('`');
    expect(joined).toContain('Ini penting dan ini kode.');
  });

  it('turns a Markdown bullet list into real bulleted lines', async () => {
    // The bullet detector was written against a "•" that had been corrupted into
    // three Latin-1 characters by a bad encoding pass, so "- item" was the only form
    // it recognised and a model returning "• item" kept the raw character inline.
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: '- Poin pertama\n- Poin kedua',
        },
      ],
    });

    const texts = await paragraphTexts(result.buffer);
    const bullets = texts.filter((line) => line.includes('Poin'));
    // Each bullet becomes its own paragraph, not one merged block.
    expect(bullets.length).toBe(2);
    for (const bullet of bullets) expect(bullet.trim().startsWith('•')).toBe(true);
  });

  it('explains a table that was supplied without columns', async () => {
    // A caller mistake must surface as a readable message, not a TypeError from
    // reading `.length` of undefined deep inside the assembler.
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    expect(() =>
      assembleDocx(docx, {
        sections: [
          {
            sectionId: section.id,
            headingText: section.text,
            paragraphIndex: section.paragraphIndex,
            insertionStrategy: 'after_heading',
            content: 'Ringkasan.',
            table: { columns: [], rows: [['a']] },
          },
        ],
      }),
    ).toThrow(/no columns/i);
  });

  /**
   * Markdown stripping must not touch arithmetic.
   *
   * A report is full of maths, and a naive `*italic*` rule turned "5 * 3 = 15"
   * into "5  3 = 15" — silently changing a computed result the user is about to
   * submit. Emphasis only counts when the asterisk hugs its text.
   */
  it('strips Markdown emphasis without destroying multiplication', async () => {
    const docx = buildFixtureDocx({
      body: [{ text: 'BAB I PENDAHULUAN', styleId: 'Heading1' }, { text: 'Isi.' }],
    });

    const structure = await analyze(docx);
    const section = structure.headings.find((heading) => heading.text === 'BAB I PENDAHULUAN')!;
    const result = assembleDocx(docx, {
      sections: [
        {
          sectionId: section.id,
          headingText: section.text,
          paragraphIndex: section.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Hasil 5 * 3 = 15, lalu **ditebalkan** dan *dimiringkan*.',
        },
      ],
    });

    const joined = (await paragraphTexts(result.buffer)).join('\n');
    // The arithmetic survives intact.
    expect(joined).toContain('5 * 3 = 15');
    // The emphasis markers do not.
    expect(joined).toContain('ditebalkan');
    expect(joined).toContain('dimiringkan');
    expect(joined).not.toContain('**');
  });
});
