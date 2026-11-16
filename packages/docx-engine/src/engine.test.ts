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

/**
 * A 2x2 RGB PNG built by hand.
 *
 * Diagram labels are what the user actually needs, and no image decoder ships in
 * this package, so the test carries the bytes it expects to see come out again.
 */
function tinyPng(): Uint8Array {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type: string, body: number[]): number[] => {
    const header = [
      (body.length >>> 24) & 0xff,
      (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff,
      body.length & 0xff,
    ];
    const payload = [...Array.from(type).map((ch) => ch.charCodeAt(0)), ...body];
    let crc = 0xffffffff;
    for (const byte of payload) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    const final = (crc ^ 0xffffffff) >>> 0;
    return [
      ...header,
      ...payload,
      (final >>> 24) & 0xff,
      (final >>> 16) & 0xff,
      (final >>> 8) & 0xff,
      final & 0xff,
    ];
  };
  // Uncompressed-deflate-free approach: zlib stream with a stored block.
  const raw = [0, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255];
  const idat = [0x78, 0x01]; // zlib header
  idat.push(0x01, raw.length & 0xff, (raw.length >>> 8) & 0xff, ~raw.length & 0xff, (~raw.length >>> 8) & 0xff);
  idat.push(...raw);
  // adler32
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  idat.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff);

  const ihdr = [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
}

describe('source figures', () => {
  it('embeds an image as a media part with a relationship and content type', () => {
    const bytes = tinyPng();
    const template = complexTemplate();
    const before = readDocxPackage(template);
    const beforeMedia = Object.keys(before.files).filter((n) => n.startsWith('word/media/')).length;

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Topologi jaringan lab ditunjukkan pada gambar berikut.',
          figures: [{ bytes, extension: 'png', caption: 'Sumber: 1.png' }],
        },
      ],
    });

    expect(result.insertedImages).toBe(1);
    // The template's own images must survive and the fidelity check must accept
    // the addition instead of reporting drift.
    expect(result.fidelity.outputImages).toBe(beforeMedia + 1);
    expect(result.fidelity.warnings.join(' ')).not.toContain('Image count');
    expect(result.fidelity.passed).toBe(true);

    const pkg = readDocxPackage(result.buffer);
    const media = Object.keys(pkg.files).filter((n) => n.startsWith('word/media/'));
    expect(media).toHaveLength(beforeMedia + 1);

    const docXml = xmlToString(pkg.files['word/document.xml']!);
    expect(docXml).toContain('<w:drawing>');

    // A <w:drawing> whose r:embed has no matching relationship makes Word report
    // the file as corrupt, so all three parts must agree.
    const rels = xmlToString(pkg.files['word/_rels/document.xml.rels']!);
    const embedRelId = /r:embed="([^"]+)"/.exec(docXml)![1]!;
    expect(rels).toContain(`Id="${embedRelId}"`);
    expect(rels).toContain('relationships/image');

    const contentTypes = xmlToString(pkg.files['[Content_Types].xml']!);
    expect(contentTypes).toMatch(/Extension="png"[^>]*ContentType="image\/png"/);
  });

  it('keeps the bytes byte-for-byte so the reader sees the original diagram', () => {
    const bytes = tinyPng();
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Topologi.',
          figures: [{ bytes, extension: 'png' }],
        },
      ],
    });
    const pkg = readDocxPackage(result.buffer);
    const ours = Object.keys(pkg.files)
      .filter((n) => n.startsWith('word/media/'))
      .map((n) => pkg.files[n]!)
      .some((part) => part.byteLength === bytes.byteLength && part.every((b, i) => b === bytes[i]));
    expect(ours).toBe(true);
  });

  it('writes a figure even when the section was filled through a placeholder', () => {
    // A section whose text came from replacing {{token}} must still get its
    // diagram; only the prose is handled by the placeholder branch.
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-conclusion',
          headingText: 'Chapter 3 Conclusion',
          paragraphIndex: 0,
          insertionStrategy: 'placeholder',
          placeholder: '{{sec_conclusion}}',
          content: 'Kesimpulan dari praktik kerja lapangan.',
          figures: [{ bytes: tinyPng(), extension: 'png' }],
        },
      ],
    });
    expect(result.insertedImages).toBe(1);
    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    expect(docXml).toContain('<w:drawing>');
  });

  it('skips an undecodable figure instead of writing a broken package', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Topologi.',
          figures: [{ bytes: new Uint8Array([1, 2, 3]), extension: 'png' }],
        },
      ],
    });
    expect(result.insertedImages).toBe(0);
    expect(result.fidelity.passed).toBe(true);
    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    expect(docXml).not.toContain('rIdFig');
  });
});

describe('figure relationships', () => {
  it('registers a relationship for every figure, not just the last one', () => {
    // The real defect: each figure rewrote document.xml.rels from a stale string,
    // so a report with 25 pictures shipped ONE valid relationship and 24 dangling
    // ones. Word calls that a corrupt file; LibreOffice silently renders the
    // pictures as nothing, which is why a 44-page preview showed 2 images while the
    // DOCX "looked fine" when inspected. Every r:embed must resolve.
    const figures = Array.from({ length: 5 }, (_, i) => ({
      bytes: tinyPng(),
      extension: 'png' as const,
      altText: `figure ${i + 1}`,
    }));
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Topologi jaringan.',
          figures,
        },
      ],
    });
    expect(result.insertedImages).toBe(5);

    const pkg = readDocxPackage(result.buffer);
    const rels = xmlToString(pkg.files['word/_rels/document.xml.rels']!);
    const docXml = xmlToString(pkg.files['word/document.xml']!);

    // Every drawing must point at a relationship that actually exists. The fixture
    // template already ships one picture, so count the figure ids specifically.
    const embeds = [...docXml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]!);
    const figureIds = embeds.filter((id) => id.startsWith('rIdFig'));
    expect(figureIds).toHaveLength(5);
    for (const id of embeds) {
      expect(rels).toContain(`Id="${id}"`);
    }

    // …and every relationship must point at a part that is really in the package.
    for (const target of [...rels.matchAll(/Target="(media\/[^"]+)"/g)].map((m) => m[1]!)) {
      expect(pkg.files[`word/${target}`]).toBeDefined();
    }

    // No relationship id may be reused, or a picture would show the wrong image.
    expect(new Set(embeds).size).toBe(embeds.length);
  });

  it('keeps the relationships the template already had', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-ip',
          headingText: 'Chapter 1a Background',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Topologi jaringan.',
          figures: [{ bytes: tinyPng(), extension: 'png' }],
        },
      ],
    });
    const pkg = readDocxPackage(result.buffer);
    const rels = xmlToString(pkg.files['word/_rels/document.xml.rels']!);
    const docXml = xmlToString(pkg.files['word/document.xml']!);
    // The template's own logo relationship (rId8 in the fixture) must survive.
    for (const id of [...docXml.matchAll(/r:embed="(rId\d+)"/g)].map((m) => m[1]!)) {
      expect(rels).toContain(`Id="${id}"`);
    }
  });
});

/**
 * Headings in real campus templates carry NO heading style and no outline level —
 * they are simply bold, larger, dark-blue runs. `buildContentParagraphs` derives
 * body formatting from the heading's run properties, and it used to do so through a
 * LIVE reference, filtering `<w:b/>`, `<w:sz/>` and `<w:color/>` off the heading
 * itself. Every section that got generated prose therefore silently demoted its own
 * heading to plain text.
 *
 * The damage was twofold: the document looked wrong (headings indistinguishable from
 * body), and the fidelity check compares detected heading counts — those headings
 * are detected *from* formatting, so the export failed with "Heading count changed
 * from 44 to 8", which blocked the PDF entirely.
 */
describe('heading formatting survives content insertion', () => {
  /** A template whose headings are bold runs, not styles — like the real ones. */
  function runFormattedTemplate(): Uint8Array {
    return buildFixtureDocx({
      title: 'Run formatted headings',
      body: [
        { text: 'BAB I: PENDAHULUAN', bold: true, fontSize: 28, align: 'center' },
        { text: 'Latar belakang laporan.' },
        { text: '1.1 Latar Belakang', bold: true, fontSize: 24 },
        { text: 'Isi asli bagian pertama.' },
        { text: 'BAB II: PEMBAHASAN', bold: true, fontSize: 28, align: 'center' },
        { text: 'Isi asli bagian kedua.' },
      ],
    });
  }

  /** The raw `<w:p>` XML for a paragraph whose text matches. */
  function paragraphXmlFor(docXml: string, text: string): string {
    const index = docXml.indexOf(text);
    expect(index).toBeGreaterThan(-1);
    const start = Math.max(docXml.lastIndexOf('<w:p>', index), docXml.lastIndexOf('<w:p ', index));
    return docXml.slice(start, docXml.indexOf('</w:p>', index) + 6);
  }

  it('keeps bold, size and colour on a heading that receives generated prose', () => {
    const template = runFormattedTemplate();
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: '1.1 Latar Belakang',
          paragraphIndex: 3,
          insertionStrategy: 'after_heading',
          content: 'Paragraf hasil generate untuk subbab ini.',
        },
      ],
    });

    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const heading = paragraphXmlFor(docXml, '1.1 Latar Belakang');
    // The heading itself must still be bold and 12pt.
    expect(heading).toContain('<w:b/>');
    expect(heading).toContain('<w:sz w:val="24"/>');

    // The generated body paragraph must NOT be bold — body text has to look like body.
    const body = paragraphXmlFor(docXml, 'Paragraf hasil generate untuk subbab ini.');
    expect(body).not.toContain('<w:b/>');
    expect(body).not.toContain('<w:sz w:val="24"/>');
  });

  it('keeps every heading when many sections are generated', () => {
    const template = runFormattedTemplate();
    const before = readDocxPackage(template);
    const beforeHeadings = analyzeDocumentXml(
      xmlToString(before.files['word/document.xml']!),
      xmlToString(before.files['word/styles.xml']!),
      null,
    ).headings.length;
    expect(beforeHeadings).toBeGreaterThan(0);

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-a',
          headingText: 'BAB I: PENDAHULUAN',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Paragraf pembuka bab satu.',
        },
        {
          sectionId: 'sec-b',
          headingText: '1.1 Latar Belakang',
          paragraphIndex: 3,
          insertionStrategy: 'after_heading',
          content: 'Paragraf pembuka subbab.',
        },
        {
          sectionId: 'sec-c',
          headingText: 'BAB II: PEMBAHASAN',
          paragraphIndex: 5,
          insertionStrategy: 'after_heading',
          content: 'Paragraf pembuka bab dua.',
        },
      ],
    });

    // This is the exact assertion the real export failed: heading detection is
    // format-based, so stripping bold made 3 of 3 headings vanish.
    expect(result.fidelity.outputHeadings).toBe(result.fidelity.templateHeadings);
    expect(result.fidelity.warnings.join(' ')).not.toContain('Heading count');
    expect(result.fidelity.passed).toBe(true);
  });

  it('does not let generated prose inherit the heading alignment', () => {
    // A centred heading is common (titles); paragraphs under it must keep their own
    // layout rather than being centred one by one.
    const template = runFormattedTemplate();
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-title',
          headingText: 'BAB I: PENDAHULUAN',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Baris pertama.\n\nBaris kedua setelah jeda.',
        },
      ],
    });
    const docXml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    // Both generated paragraphs exist and none of them carries the heading's runs.
    expect(docXml).toContain('Baris pertama.');
    expect(docXml).toContain('Baris kedua setelah jeda.');
    const first = paragraphXmlFor(docXml, 'Baris pertama.');
    expect(first).not.toContain('<w:b/>');
  });
});

/**
 * Regressions found by auditing the assembler against the MVP promise: "the
 * output adapts to the template the user uploaded". Each test below reproduced a
 * way the generated report could silently diverge from the template — text in the
 * wrong chapter, text printed twice, or a whole chapter with its table and figures
 * vanishing — while the fidelity report still said `passed: true`.
 */
describe('assembly must not silently corrupt the template', () => {
  /** Every body paragraph text, in document order. */
  function bodyTexts(buffer: Uint8Array): string[] {
    const [root] = parseXml(xmlToString(readDocxPackage(buffer).files['word/document.xml']!));
    return findChild(root!, 'w:body')!.children
      .filter((c) => c.tag === 'w:p')
      .map(paragraphText);
  }

  /**
   * A token that appears twice is a template authoring slip, but it must not print
   * the generated chapter twice: only one copy of the prose may survive, and the
   * other token must be reported instead of being filled.
   */
  it('fills a duplicated placeholder only once and still reports the section as filled', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{bab1}}' },
        { text: 'BAB II PEMBAHASAN', styleId: 'Heading1' },
        { text: 'Isi pembahasan.' },
        // The same token pasted again, e.g. by a copy/paste inside the template.
        { text: 'Catatan: {{bab1}}' },
      ],
    });

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: 'BAB I PENDAHULUAN',
          paragraphIndex: 0,
          insertionStrategy: 'placeholder',
          placeholder: 'bab1',
          content: 'Paragraf pendahuluan yang dihasilkan.',
        },
      ],
    });

    const texts = bodyTexts(result.buffer);
    const occurrences = texts.filter((t) => t === 'Paragraf pendahuluan yang dihasilkan.').length;
    expect(occurrences).toBe(1);
    // The second token is left alone rather than duplicated into the prose.
    expect(texts.join('\n')).toContain('Catatan: {{bab1}}');
    expect(result.fidelity.warnings.join(' ')).toContain('bab1');
  });

  /**
   * A token that sits directly under the *next* heading belongs to that next
   * section. Analysis used to slice the body by paragraph index only, so a token
   * before heading B was attributed to A — the generated text landed in the
   * previous chapter and B's token survived untouched.
   */
  it('binds a placeholder to the heading above it, not to the previous section', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi_bab1}}' },
        { text: 'BAB II PEMBAHASAN', styleId: 'Heading1' },
        { text: '{{isi_bab2}}' },
        { text: 'BAB III PENUTUP', styleId: 'Heading1' },
      ],
    });
    const pkg = readDocxPackage(template);
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      null,
    );
    const bab2 = structure.headings.find((h) => h.text === 'BAB II PEMBAHASAN')!;
    const bab1 = structure.headings.find((h) => h.text === 'BAB I PENDAHULUAN')!;
    // The token physically under BAB II belongs to BAB II, and BAB I must not be
    // told it has a reserved placeholder — that is what made the assembler write the
    // generated text into the previous chapter and leave BAB II's token in place.
    expect(bab2.placeholders).toContain('isi_bab2');
    expect(bab1.hasExplicitPlaceholder).toBe(true); // it owns {{isi_bab1}}
    expect(bab2.hasExplicitPlaceholder).toBe(true);
    expect(bab2.suggestedStrategy).toBe('placeholder');
    expect(bab2.bodyText).toContain('{{isi_bab2}}');
    // BAB I's own body must not contain BAB II's token.
    expect(bab1.bodyText).not.toContain('{{isi_bab2}}');

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: bab2.id,
          headingText: bab2.text,
          paragraphIndex: bab2.paragraphIndex,
          insertionStrategy: 'placeholder',
          placeholder: 'isi_bab2',
          content: 'Isi bab dua.',
        },
      ],
    });

    const texts = bodyTexts(result.buffer);
    const insertedAt = texts.indexOf('Isi bab dua.');
    const bab2At = texts.indexOf('BAB II PEMBAHASAN');
    const bab3At = texts.indexOf('BAB III PENUTUP');
    expect(insertedAt).toBeGreaterThan(bab2At);
    expect(insertedAt).toBeLessThan(bab3At);
  });

  /**
   * The analysis bug had a second half that survives any analysis fix: the UI may
   * already hold a stale `placeholder` for a section (the user's template was edited
   * after analysis). If BAB I is told to fill `isi_bab2`, the token physically sits
   * in BAB II, so the generated text must NOT be written above BAB II — and the
   * mismatch must be reported rather than silently pasted into the wrong chapter.
   */
  it('refuses to fill a token that lives outside the section it was assigned to', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi_bab1}}' },
        { text: 'BAB II PEMBAHASAN', styleId: 'Heading1' },
        { text: '{{isi_bab2}}' },
      ],
    });
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: 'BAB I PENDAHULUAN',
          paragraphIndex: 0,
          insertionStrategy: 'placeholder',
          placeholder: 'isi_bab2', // stale assignment: this token is in BAB II
          content: 'Isi yang seharusnya milik BAB I.',
        },
      ],
    });

    const texts = bodyTexts(result.buffer);
    const insertedAt = texts.indexOf('Isi yang seharusnya milik BAB I.');
    // The prose must not be written under BAB I, and BAB II's token must survive.
    expect(insertedAt).toBe(-1);
    expect(texts.join('\n')).toContain('{{isi_bab2}}');
    expect(result.fidelity.passed).toBe(false);
    expect(result.fidelity.warnings.join(' ')).toContain('isi_bab2');
  });

  /**
   * A figure attached to a `placeholder` section belongs in that chapter, not on the
   * cover. The anchor is the section's heading, and it has to stay inside the
   * chapter even when the section arrives with a stale `paragraphIndex`.
   */
  it('anchors a figure to its own chapter, not to the first paragraph of the document', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'LAPORAN KERJA PRAKTIK', styleId: 'Title' },
        { text: 'Nama: Ada' },
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1', pageBreakBefore: true },
        { text: '{{isi}}' },
        { text: 'BAB II PENUTUP', styleId: 'Heading1' },
      ],
    });
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: 'BAB I PENDAHULUAN',
          paragraphIndex: 2,
          insertionStrategy: 'placeholder',
          placeholder: 'isi',
          content: 'Isi bab satu dengan gambar.',
          figures: [{ bytes: tinyPng(), extension: 'png', caption: 'Sumber: 1.png' }],
        },
      ],
    });

    expect(result.insertedImages).toBe(1);
    const [root] = parseXml(xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!));
    const body = findChild(root!, 'w:body')!;
    const drawingAt = body.children.findIndex((node) => findAll(node, 'w:drawing').length > 0);
    const titleAt = body.children.findIndex((node) => node.tag === 'w:p' && paragraphText(node) === 'LAPORAN KERJA PRAKTIK');
    const headingAt = body.children.findIndex((node) => node.tag === 'w:p' && paragraphText(node) === 'BAB I PENDAHULUAN');
    // After the chapter heading, and nowhere near the cover.
    expect(drawingAt).toBeGreaterThan(headingAt);
    expect(drawingAt).toBeGreaterThan(titleAt);
  });

  /**
   * A section whose heading text does not exist in the template must never be
   * placed by approximation. The user asked for "BAB I PENDAHULUAN" and the template
   * has it; if the section arrives carrying an edited title, writing its prose into
   * whichever chapter happens to be nearby would be a silent corruption.
   */
  it('refuses to place a section whose heading text is not in the template', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Isi asli.' },
        { text: 'BAB II PENUTUP', styleId: 'Heading1' },
      ],
    });
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: 'BAB I PENDAHULUAN (revisi)',
          paragraphIndex: 99,
          insertionStrategy: 'after_heading',
          content: 'Isi yang dihasilkan.',
        },
      ],
    });

    const texts = bodyTexts(result.buffer);
    expect(texts).not.toContain('Isi yang dihasilkan.');
    expect(result.fidelity.passed).toBe(false);
    expect(result.fidelity.warnings.join(' ')).toContain('BAB I PENDAHULUAN (revisi)');
  });

  /**
   * A figure attached to a `placeholder` section must survive even when the section
   * arrives with a title that no longer matches the template. The token is then the
   * only handle on the chapter, and the picture has to be written next to the prose
   * it belongs to rather than dropped.
   *
   * (An earlier version anchored figures through a lookup that fell back to the
   * document's first paragraph. That fallback is gone: if the anchor cannot be
   * established the figure is placed after the section heading, never on the cover.)
   */
  it('keeps the figure of a placeholder section whose heading text no longer matches', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'LAPORAN KERJA PRAKTIK', styleId: 'Title' },
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi}}' },
        { text: 'BAB II PENUTUP', styleId: 'Heading1' },
      ],
    });
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          // Deliberately not resolvable: the token, not the title, is the handle.
          headingText: 'Judul yang tidak ada di template',
          paragraphIndex: 99,
          insertionStrategy: 'placeholder',
          placeholder: 'isi',
          content: 'Isi bab satu.',
          figures: [{ bytes: tinyPng(), extension: 'png', caption: 'Sumber: 1.png' }],
        },
      ],
    });

    expect(result.insertedImages).toBe(1);
    const xml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    expect(xml).toContain('<w:drawing');
    // ...and the picture sits with its own prose, not on the cover.
    const [root] = parseXml(xml);
    const body = findChild(root!, 'w:body')!;
    const proseAt = body.children.findIndex((node) => node.tag === 'w:p' && paragraphText(node).includes('Isi bab satu.'));
    const drawingAt = body.children.findIndex((node) => findAll(node, 'w:drawing').length > 0);
    expect(proseAt).toBeGreaterThan(0);
    expect(drawingAt).toBeGreaterThan(proseAt);
  });

  /**
   * Two chapters can legitimately share a title ("PENDAHULUAN" in a proposal and in
   * an appendix). Matching by text sent every body to the first one, so the chapter
   * that received the generated prose depended on insertion order rather than on
   * which chapter the user edited. The table in the middle also proves the lookup
   * uses `w:body` indices: `paragraphIndex` counts tables, so a paragraphs-only
   * lookup resolved to the wrong paragraph from that point on.
   */
  it('targets the intended chapter when two headings share the same text', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Isi pendahuluan asli.' },
        { table: { rows: [['No', 'Uraian'], ['1', 'Data awal']] } },
        { text: 'LAMPIRAN', styleId: 'Heading1' },
        { text: 'Isi lampiran asli.' },
        { text: 'PENDAHULUAN', styleId: 'Heading1' },
        { text: 'Pembuka lampiran.' },
      ],
    });
    const pkg = readDocxPackage(template);
    const structure = analyzeDocumentXml(
      xmlToString(pkg.files['word/document.xml']!),
      xmlToString(pkg.files['word/styles.xml']!),
      null,
    );
    const duplicates = structure.headings.filter((h) => h.text === 'PENDAHULUAN');
    expect(duplicates).toHaveLength(2);
    const second = duplicates[1]!;

    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: second.id,
          headingText: second.text,
          paragraphIndex: second.paragraphIndex,
          insertionStrategy: 'after_heading',
          content: 'Isi baru untuk pendahuluan kedua.',
        },
      ],
    });

    const texts = bodyTexts(result.buffer);
    const insertedAt = texts.indexOf('Isi baru untuk pendahuluan kedua.');
    const lastHeadingAt = texts.lastIndexOf('PENDAHULUAN');
    // The generated prose sits under the SECOND occurrence, not the first.
    expect(insertedAt).toBeGreaterThan(lastHeadingAt);
    expect(texts.indexOf('Pendahuluan kedua.')).toBe(-1);
    // The first chapter and the appendix keep their original bodies.
    expect(texts).toContain('Isi pendahuluan asli.');
    expect(texts).toContain('Pembuka lampiran.');
  });

  /**
   * If the heading the caller asked for cannot be located, the old code skipped the
   * section without a word: its prose, its generated table and its figures all
   * disappeared while `fidelity.passed` stayed true. Failing loudly is the only
   * safe behaviour — the user must know the chapter is missing.
   */
  it('reports a section whose heading cannot be located instead of dropping it silently', () => {
    const result = assembleDocx(complexTemplate(), {
      sections: [
        {
          sectionId: 'sec-x',
          headingText: 'Chapter 9 Not In This Template',
          paragraphIndex: 42,
          insertionStrategy: 'after_heading',
          content: 'This content has nowhere to go.',
        },
      ],
    });

    expect(result.fidelity.warnings.join(' ')).toContain('Chapter 9 Not In This Template');
    expect(result.fidelity.passed).toBe(false);
  });

  /**
   * `placeholder` strategy with an empty token used to fall through to the
   * heading path and leave the token in place without saying why.
   */
  it('falls back to the heading when the placeholder strategy has no token', () => {
    const template = buildFixtureDocx({
      body: [
        { text: 'BAB I PENDAHULUAN', styleId: 'Heading1' },
        { text: '{{isi}}' },
        { text: 'BAB II PENUTUP', styleId: 'Heading1' },
      ],
    });
    const result = assembleDocx(template, {
      sections: [
        {
          sectionId: 'sec-1',
          headingText: 'BAB I PENDAHULUAN',
          paragraphIndex: 0,
          insertionStrategy: 'placeholder',
          placeholder: '   ',
          content: 'Isi bab satu.',
        },
      ],
    });
    const texts = bodyTexts(result.buffer);
    const insertedAt = texts.indexOf('Isi bab satu.');
    expect(insertedAt).toBeGreaterThan(texts.indexOf('BAB I PENDAHULUAN'));
    expect(insertedAt).toBeLessThan(texts.indexOf('BAB II PENUTUP'));
  });
});


