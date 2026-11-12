import { describe, expect, it } from 'vitest';
import { assembleDocx } from './assemble.js';
import { analyzeDocumentXml, bodyItems, extractPlaceholders, parseStyles } from './analyze.js';
import { buildFixtureDocx } from './fixtures.js';
import { readDocxPackage, xmlToString } from './zip.js';
import { findAll, findChild, paragraphText, parseXml } from './xml.js';

function complexTemplate(): Uint8Array {
  return buildFixtureDocx({
    title: 'Internship Report Template',
    headerText: 'Department of Informatics',
    footerText: 'Page footer — confidential draft',
    images: 1,
    customStyles: [{ id: 'CustomH2', name: 'Custom Section Level 2', outlineLevel: 1, bold: true }],
    body: [
      { text: 'INTERNSHIP REPORT', styleId: 'Title' },
      { text: 'Name: {{student_name}}' },
      { text: 'Company: {{company_name}}' },
      { text: 'Chapter 1 Introduction', styleId: 'Heading1', pageBreakBefore: true },
      { text: '{{sec2}}' },
      { text: 'Chapter 1a Background', styleId: 'Heading2' },
      { text: 'The company operates in the IT sector since 1998.' },
      { text: 'Chapter 1b Scope', styleId: 'Heading2', splitRuns: true },
      { text: 'Scope placeholder: {{scope_placeholder}}' },
      { text: 'Chapter 2 Activities', styleId: 'Heading1', pageBreakBefore: true },
      {
        table: {
          rows: [
            ['Activity', 'Duration'],
            ['Documentation', '3 weeks'],
            ['__NESTED__', 'nested cell'],
          ],
          nested: { rows: [['Nested A', 'Nested B']] },
        },
      },
      { text: 'Chapter 3 Conclusion', styleId: 'Heading1' },
      { text: 'Placeholder below' },
      { text: '{{sec_conclusion}}' },
      { sectionBreak: true },
      { text: 'Appendix A', styleId: 'CustomH2' },
      { text: 'Appendix content' },
    ],
  });
}

describe('template analysis', () => {
  it('detects heading hierarchy, tables, images and placeholders', () => {
    const pkg = readDocxPackage(complexTemplate());
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      xmlToString(pkg.files['docProps/core.xml']!),
    );
    const texts = structure.headings.map((h) => h.text);
    expect(texts).toContain('INTERNSHIP REPORT');
    expect(texts).toContain('Chapter 1 Introduction');
    expect(texts).toContain('Chapter 1a Background');
    expect(texts).toContain('Chapter 2 Activities');
    expect(texts).toContain('Appendix A');

    const intro = structure.headings.find((h) => h.text === 'Chapter 1 Introduction')!;
    expect(intro.hasExplicitPlaceholder).toBe(true);
    expect(intro.pageBreakBefore).toBe(true);
    expect(intro.suggestedStrategy).toBe('placeholder');

    const activities = structure.headings.find((h) => h.text === 'Chapter 2 Activities')!;
    expect(activities.tableCount).toBe(1);
    expect(activities.suggestedStrategy).toBe('after_heading');
    // the conclusion heading sits after the table
    const conclusion = structure.headings.find((h) => h.text === 'Chapter 3 Conclusion')!;
    expect(conclusion.tableCount).toBe(0);

    expect(structure.tableCount).toBe(2);
    expect(structure.nestedTableCount).toBe(1);
    expect(structure.imagesCount).toBe(1);
    expect(structure.sectionBreakCount).toBe(2);
    expect(structure.placeholders).toEqual(
      expect.arrayContaining(['student_name', 'company_name', 'sec2', 'scope_placeholder', 'sec_conclusion']),
    );
    expect(structure.title).toBe('Internship Report Template');
    expect(structure.pageSetup?.orientation).toBe('portrait');
  });

  it('parses style outline levels, including custom styles', () => {
    const styles = parseStyles(
      xmlToString(readDocxPackage(complexTemplate()).files['word/styles.xml']!),
    );
    expect(styles.get('Heading1')?.outlineLevel).toBe(0);
    expect(styles.get('CustomH2')?.name).toBe('Custom Section Level 2');
  });

  it('handles placeholders split across runs', () => {
    expect(extractPlaceholders('a {{foo}} b {{ bar }}')).toEqual(['foo', 'bar']);
  });

  /**
   * Campus/school templates routinely ignore Word heading styles and just use
   * bold, centred, larger text with manual chapter numbering.
   */
  it('infers headings from formatting and numbering when no heading styles exist', () => {
    const pkg = readDocxPackage(
      buildFixtureDocx({
        body: [
          { text: 'LAPORAN KERJA PRAKTIK', bold: true, fontSize: 32, align: 'center' },
          { text: 'BAB I PENDAHULUAN', bold: true, fontSize: 28, align: 'center', pageBreakBefore: true },
          { text: '1.1 Latar Belakang', bold: true, fontSize: 24 },
          { text: 'Perusahaan ini bergerak di bidang teknologi informasi sejak tahun 1998.' },
          { text: '1.2 Tujuan', bold: true, fontSize: 24 },
          { text: 'BAB II PEMBAHASAN', bold: true, fontSize: 28, align: 'center' },
          { text: 'Kegiatan berjalan sesuai rencana.' },
        ],
      }),
    );
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      null,
    );
    expect(structure.headings.map((h) => h.text)).toEqual([
      'LAPORAN KERJA PRAKTIK',
      'BAB I PENDAHULUAN',
      '1.1 Latar Belakang',
      '1.2 Tujuan',
      'BAB II PEMBAHASAN',
    ]);
    expect(structure.headings.map((h) => h.level)).toEqual([1, 1, 2, 2, 1]);
    expect(structure.warnings.join(' ')).toContain('inferred from formatting');
  });

  it('does not promote body prose, list items or table-of-contents lines', () => {
    const pkg = readDocxPackage(
      buildFixtureDocx({
        body: [
          { text: 'PENDAHULUAN', bold: true, fontSize: 28, align: 'center' },
          { text: 'Perusahaan ini bergerak di bidang teknologi informasi sejak tahun 1998 dan terus berkembang pesat.' },
          { text: 'PENDAHULUAN ......... 1', bold: true, fontSize: 28 },
          { text: '1. Dokumentasi', bold: true, numberingLevel: 0 },
          { text: 'Kegiatan ini berjalan lancar tanpa kendala berarti.' },
        ],
      }),
    );
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      null,
    );
    expect(structure.headings.map((h) => h.text)).toEqual(['PENDAHULUAN']);
  });

  it('recognises localised heading style names without an outline level', () => {
    const pkg = readDocxPackage(
      buildFixtureDocx({
        customStyles: [{ id: 'JudulSatu', name: 'Judul 1' }],
        body: [
          { text: 'Bab Pendahuluan', styleId: 'JudulSatu' },
          { text: 'Isi bagian pendahuluan.' },
          { text: 'Bagian Penutup', styleId: 'JudulSatu' },
        ],
      }),
    );
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      null,
    );
    expect(structure.headings.map((h) => h.text)).toEqual(['Bab Pendahuluan', 'Bagian Penutup']);
    expect(structure.headings.every((h) => h.level === 1)).toBe(true);
  });
});

describe('assembly fidelity', () => {
  it('inserts content after headings and replaces placeholders while preserving the rest', () => {
    const template = complexTemplate();
    const before = readDocxPackage(template);
    const structure = analyzeDocumentXml(
      xmlToString(before.files['word/document.xml']!),
      xmlToString(before.files['word/styles.xml']!),
      null,
    );
    const intro = structure.headings.find((h) => h.text === 'Chapter 1 Introduction')!;
    const activities = structure.headings.find((h) => h.text === 'Chapter 2 Activities')!;
    const conclusion = structure.headings.find((h) => h.text === 'Chapter 3 Conclusion')!;

    const result = assembleDocx(template, {
      globalPlaceholders: { student_name: 'Ada Lovelace', company_name: 'PT Contoh' },
      sections: [
        {
          sectionId: intro.id,
          headingText: intro.text,
          paragraphIndex: intro.paragraphIndex,
          insertionStrategy: 'placeholder',
          placeholder: 'sec2',
          content: 'This chapter introduces the internship programme.',
        },
        {
          sectionId: activities.id,
          headingText: activities.text,
          paragraphIndex: activities.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'We documented the network topology.\n\n- First activity\n- Second activity',
        },
        {
          sectionId: conclusion.id,
          headingText: conclusion.text,
          paragraphIndex: conclusion.paragraphIndex,
          insertionStrategy: 'placeholder',
          placeholder: 'sec_conclusion',
          content: 'The internship concluded with a final presentation.',
        },
      ],
    });

    expect(result.fidelity.passed).toBe(true);
    expect(result.insertedParagraphs).toBeGreaterThan(0);
    expect(result.unresolvedPlaceholders).toEqual(['scope_placeholder']);

    const out = readDocxPackage(result.buffer);
    // untouched parts are byte-identical
    for (const name of ['word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml', 'word/media/image1.png']) {
      expect(Buffer.compare(Buffer.from(out.files[name]!), Buffer.from(before.files[name]!))).toBe(0);
    }
    const docXml = xmlToString(out.files['word/document.xml']!);
    expect(docXml).toContain('This chapter introduces the internship programme.');
    expect(docXml).toContain('We documented the network topology.');
    expect(docXml).toContain('Ada Lovelace');
    expect(docXml).not.toContain('{{sec2}}');
    expect(docXml).not.toContain('{{sec_conclusion}}');

    const [root] = parseXml(docXml);
    const body = findChild(root!, 'w:body')!;
    const paragraphs = bodyItems(root!).filter((i) => i.kind === 'paragraph').map((i) => paragraphText(i.node));
    // inserted text must appear between the Introduction heading and the next heading
    const introIdx = paragraphs.indexOf('Chapter 1 Introduction');
    const nextHeadingIdx = paragraphs.indexOf('Chapter 1a Background');
    expect(paragraphs.slice(introIdx + 1, nextHeadingIdx)).toContain('This chapter introduces the internship programme.');
    // inserted paragraphs must not inherit the heading style
    const inserted = findAll(body, 'w:p').find((p) => paragraphText(p).includes('We documented the network topology'))!;
    const styleNode = findChild(findChild(inserted, 'w:pPr') ?? { tag: '', attrs: {}, children: [] }, 'w:pStyle');
    expect(styleNode?.attrs['w:val']).not.toBe('Heading1');
    // headings unchanged
    expect(result.fidelity.outputHeadings).toBe(result.fidelity.templateHeadings);
  });

  it('escapes XML-sensitive generated content', () => {
    const template = complexTemplate();
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-4',
          headingText: 'Chapter 2 Activities',
          paragraphIndex: 9,
          insertionStrategy: 'after_heading',
          content: 'Revenue < 5% & "quoted" </w:t> injection attempt',
        },
      ],
    });
    const out = readDocxPackage(result.buffer);
    const [root] = parseXml(xmlToString(out.files['word/document.xml']!));
    const texts = findAll(root!, 'w:p').map(paragraphText).join('\n');
    expect(texts).toContain('Revenue < 5% & "quoted" </w:t> injection attempt');
  });

  it('reports placeholders that were never filled', () => {
    const result = assembleDocx(complexTemplate(), { sections: [] });
    expect(result.unresolvedPlaceholders.length).toBeGreaterThan(0);
    expect(result.fidelity.warnings.join(' ')).toContain('placeholder');
  });

  it('rejects a non-docx buffer', () => {
    expect(() => readDocxPackage(new TextEncoder().encode('hello world'))).toThrow(/not a readable ZIP/);
  });
});

/**
 * "Gambar & tabel tidak masuk" was reported by the user. The export already kept
 * the template's own tables and images byte-for-byte, so the missing piece was
 * generated ones: a section about an addressing plan was answered with three
 * paragraphs describing a table. These tests pin the fix — generated cells
 * become a real <w:tbl>, never Markdown pipes inside a paragraph.
 */
describe('generated tables', () => {
  it('writes a real Word table and reports it as inserted', () => {
    const template = complexTemplate();
    const before = readDocxPackage(template);
    const beforeStructure = analyzeDocumentXml(
      xmlToString(before.files['word/document.xml']!),
      xmlToString(before.files['word/styles.xml']!),
      null,
    );

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Tabel berikut merangkum alokasi pengalamatan IP.',
          table: {
            caption: 'Tabel 2.3 Alokasi Pengalamatan IP',
            columns: ['Perangkat', 'Alamat IP', 'Gateway'],
            rows: [
              ['Router', '192.168.10.98', '192.168.10.1'],
              ['Server DHCP', '192.168.10.2', '192.168.10.1'],
            ],
          },
        },
      ],
    });

    expect(result.insertedTables).toBe(1);
    // The template's own tables must survive *and* the fidelity check must accept
    // the addition instead of reporting drift.
    expect(result.fidelity.outputTables).toBe(beforeStructure.tableCount + 1);
    expect(result.fidelity.warnings.join(' ')).not.toContain('Table count');
    expect(result.fidelity.passed).toBe(true);

    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const [root] = parseXml(docXml);
    const body = findChild(root!, 'w:body')!;
    const tables = findAll(body, 'w:tbl');
    // `paragraphText` collects every w:t below the node, so search on the table.
    const generated = tables.find((t) => paragraphText(t).includes('192.168.10.98'))!;
    expect(generated).toBeDefined();

    // Every cell is its own <w:tc>, so Word renders columns, not one run of text.
    const rows = findAll(generated, 'w:tr');
    expect(rows).toHaveLength(3); // header + 2 body rows
    expect(findAll(rows[0]!, 'w:tc').map(paragraphText)).toEqual(['Perangkat', 'Alamat IP', 'Gateway']);
    expect(findAll(rows[1]!, 'w:tc').map(paragraphText)).toEqual(['Router', '192.168.10.98', '192.168.10.1']);
    expect(docXml).toContain('Tabel 2.3 Alokasi Pengalamatan IP');
  });

  it('never writes Markdown pipes into the document', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Berikut alokasinya.',
          table: { columns: ['A', 'B'], rows: [['x', 'y']] },
        },
      ],
    });
    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    expect(docXml).not.toMatch(/\|\s*-{3,}/);
    expect(docXml).not.toContain('| A | B |');
  });

  it('pads short rows to the header width so cells do not shift', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Ringkasan.',
          table: { columns: ['A', 'B', 'C'], rows: [['only-one-cell']] },
        },
      ],
    });
    const [root] = parseXml(xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!));
    const tables = findAll(findChild(root!, 'w:body')!, 'w:tbl');
    const generated = tables.find((t) => paragraphText(t).includes('only-one-cell'))!;
    const bodyRow = findAll(generated, 'w:tr')[1]!;
    expect(findAll(bodyRow, 'w:tc')).toHaveLength(3);
  });

  it('does not disturb the section prose when a table is present', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Kalimat pengantar sebelum tabel.',
          table: { columns: ['A'], rows: [['1']] },
        },
      ],
    });
    const [root] = parseXml(xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!));
    const items = bodyItems(root!);
    const headingIdx = items.findIndex((i) => i.kind === 'paragraph' && paragraphText(i.node) === 'Chapter 1a Background');
    // lead-in paragraph first, then the table
    expect(items[headingIdx + 1]!.kind).toBe('paragraph');
    expect(paragraphText(items[headingIdx + 1]!.node)).toBe('Kalimat pengantar sebelum tabel.');
    expect(items[headingIdx + 2]!.kind).toBe('table');
  });
});

