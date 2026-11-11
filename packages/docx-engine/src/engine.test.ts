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
