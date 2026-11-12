/**
 * Deterministic DOCX assembly.
 *
 * Strategy: work on a *copy* of the original package. Only `word/document.xml`
 * is rewritten; every other part (styles, numbering, headers, footers, media,
 * relationships, settings, section properties) is copied byte-for-byte, which
 * is what makes formatting preservation possible for Word features we do not
 * understand.
 */
import {
  cloneNode,
  createParagraph,
  createTable,
  escapeXml,
  findAll,
  findChild,
  insertAfter,
  paragraphStyleId,
  paragraphText,
  parseXml,
  serializeXml,
  unescapeXml,
  type XmlNode,
} from './xml.js';
import { readDocxPackage, writeDocxPackage, xmlToString, stringToXml, type DocxPackage } from './zip.js';
import { analyzeDocumentXml, extractPlaceholders, partText } from './analyze.js';
import type { FidelityReport, InsertionStrategy } from '@formaai/shared';

export interface AssemblyTable {
  columns: string[];
  rows: string[][];
  caption?: string | null;
}

export interface AssemblySection {
  sectionId: string;
  headingText: string;
  /** Paragraph index of the heading in the template body (from template analysis). */
  paragraphIndex: number;
  insertionStrategy: InsertionStrategy;
  placeholder?: string | null;
  content: string;
  /**
   * A table to emit after the section's prose.
   *
   * Tables are structural, not text: a Markdown pipe table in `content` would be
   * flattened into identical paragraphs. The generator returns the cells and
   * this assembler writes a real <w:tbl> so Word/LibreOffice can style it.
   */
  table?: AssemblyTable | null;
  /** Skip content insertion (e.g. user excluded the section). */
  skip?: boolean;
}

export interface AssembleOptions {
  sections: AssemblySection[];
  /** Additional key/value placeholder replacements applied to the whole document. */
  globalPlaceholders?: Record<string, string>;
  /** Extra top-level info block, e.g. report title/date placeholders. */
  title?: string;
}

export interface AssembleResult {
  buffer: Uint8Array;
  fidelity: FidelityReport;
  insertedParagraphs: number;
  /** Word tables written from generated cells. */
  insertedTables: number;
  replacedPlaceholders: number;
  unresolvedPlaceholders: string[];
}

interface RunMatch {
  run: XmlNode;
  textNodes: XmlNode[];
  text: string;
}

function collectRuns(paragraph: XmlNode): RunMatch[] {
  const runs: RunMatch[] = [];
  for (const run of paragraph.children) {
    if (run.tag !== 'w:r') continue;
    const textNodes = run.children.filter((c) => c.tag === 'w:t');
    if (textNodes.length === 0) continue;
    const text = textNodes.map((t) => t.children.map((c) => (c.tag === '#text' ? (c.text ?? '') : '')).join('')).join('');
    runs.push({ run, textNodes, text });
  }
  return runs;
}

function setTextNodes(nodes: XmlNode[], text: string): void {
  nodes.forEach((node, index) => {
    if (index === 0) {
      node.attrs['xml:space'] = 'preserve';
      node.children = [{ tag: '#text', attrs: {}, children: [], text }];
    } else {
      node.children = [];
    }
  });
}

function runPropsOf(paragraph: XmlNode): XmlNode | null {
  const firstRun = paragraph.children.find((c) => c.tag === 'w:r');
  return firstRun ? (findChild(firstRun, 'w:rPr') ?? null) : null;
}

function paragraphPropsOf(paragraph: XmlNode): XmlNode | null {
  return findChild(paragraph, 'w:pPr') ?? null;
}

/**
 * Replace `token` occurrences inside a paragraph while keeping the formatting of
 * the run that contained the token. Handles tokens split across several runs
 * (very common in Word).
 */
export function replaceInParagraph(paragraph: XmlNode, token: string, value: string): number {
  let replaced = 0;
  let guard = 0;
  while (guard++ < 50) {
    const runs = collectRuns(paragraph);
    if (runs.length === 0) break;
    let fullText = '';
    for (const r of runs) fullText += r.text;
    const index = fullText.indexOf(token);
    if (index === -1) break;
    const endIndex = index + token.length;
    let cursor = 0;
    let started = false;
    for (const r of runs) {
      const runStart = cursor;
      const runEnd = cursor + r.text.length;
      cursor = runEnd;
      if (runEnd <= index || runStart >= endIndex) continue;
      const localStart = Math.max(0, index - runStart);
      const localEnd = Math.min(r.text.length, endIndex - runStart);
      const before = r.text.slice(0, localStart);
      const after = r.text.slice(localEnd);
      const insert = started ? '' : value;
      started = true;
      setTextNodes(r.textNodes, before + insert + after);
    }
    replaced += 1;
  }
  return replaced;
}

function replaceInAllParagraphs(nodes: XmlNode[], token: string, value: string): number {
  let count = 0;
  for (const node of nodes) {
    if (node.tag === 'w:p') count += replaceInParagraph(node, token, value);
    if (node.children.length) count += replaceInAllParagraphs(node.children, token, value);
  }
  return count;
}

function findHeadingParagraph(body: XmlNode, section: AssemblySection): XmlNode | null {
  const paragraphs = body.children.filter((c) => c.tag === 'w:p');
  const candidate = paragraphs[section.paragraphIndex];
  if (candidate && paragraphText(candidate).trim() === section.headingText.trim()) return candidate;
  const normalized = section.headingText.trim().toLowerCase();
  return paragraphs.find((p) => paragraphText(p).trim().toLowerCase() === normalized) ?? null;
}

function buildContentParagraphs(content: string, headingPara: XmlNode | null): XmlNode[] {
  const pProps = headingPara ? cloneNode(paragraphPropsOf(headingPara) ?? { tag: 'w:pPr', attrs: {}, children: [] }) : null;
  if (pProps) {
    // Never inherit heading styles or page-break-before for body text;
    // inheriting the heading style would turn generated body text into headings.
    pProps.children = pProps.children.filter((c) => c.tag !== 'w:pStyle' && c.tag !== 'w:outlineLvl' && c.tag !== 'w:pageBreakBefore');
    if (pProps.children.length === 0) {
      // keep an empty pPr out of the output
    }
  }
  const rProps = headingPara ? runPropsOf(headingPara) : null;
  if (rProps) {
    rProps.children = rProps.children.filter((c) => c.tag !== 'w:b' && c.tag !== 'w:bCs' && c.tag !== 'w:color' && c.tag !== 'w:sz' && c.tag !== 'w:szCs');
  }
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/);
  const paragraphs: XmlNode[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let current: string[] = [];
    const flush = () => {
      if (current.length) {
        paragraphs.push(
          createParagraph(current.join('\n'), {
            paragraphProps: pProps && pProps.children.length ? pProps : null,
            runProps: rProps,
          }),
        );
        current = [];
      }
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      if (/^([-*•]|\d+[.)])\s+/.test(trimmed)) {
        flush();
        current.push(trimmed.replace(/^[-*•]\s+/, '• '));
      } else {
        current.push(trimmed);
      }
    }
    flush();
  }
  return paragraphs;
}

export function assembleDocx(templateBytes: Uint8Array, options: AssembleOptions): AssembleResult {
  const pkg: DocxPackage = readDocxPackage(templateBytes);
  const documentXml = xmlToString(pkg.files['word/document.xml']!);
  const stylesXml = pkg.files['word/styles.xml'] ? xmlToString(pkg.files['word/styles.xml']!) : null;
  const coreXml = pkg.files['docProps/core.xml'] ? xmlToString(pkg.files['docProps/core.xml']!) : null;

  const originalStructure = analyzeDocumentXml(documentXml, stylesXml, coreXml);

  const [root] = parseXml(documentXml);
  if (!root) throw new Error('Unable to parse word/document.xml');
  const body = findChild(root, 'w:body');
  if (!body) throw new Error('word/document.xml has no w:body');

  let replacedPlaceholders = 0;
  let insertedParagraphs = 0;
  let tablesInserted = 0;

  // 1. Global placeholder replacements (e.g. {{report_title}}, {{date}})
  if (options.globalPlaceholders) {
    for (const [key, value] of Object.entries(options.globalPlaceholders)) {
      replacedPlaceholders += replaceInAllParagraphs(root.children, `{{${key}}}`, value);
    }
  }

  // 2. Section content insertion
  for (const section of options.sections) {
    if (section.skip) continue;
    const content = section.content ?? '';
    const placeholder = section.placeholder?.trim();
    if (section.insertionStrategy === 'placeholder' && placeholder) {
      const token = placeholder.startsWith('{{') ? placeholder : `{{${placeholder}}}`;
      const count = replaceInAllParagraphs(root.children, token, content.replace(/\n{2,}/g, '\n'));
      replacedPlaceholders += count;
      continue;
    }
    const headingPara = findHeadingParagraph(body, section);
    if (!headingPara) continue;
    const paragraphs = buildContentParagraphs(content, headingPara);
    if (paragraphs.length > 0) {
      insertAfter(body, headingPara, paragraphs);
      insertedParagraphs += paragraphs.length;
    }
    // A table goes after the prose it introduces, as a real Word table.
    if (section.table && section.table.columns.length > 0) {
      const tableNodes = createTable(section.table);
      const anchor = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]! : headingPara;
      insertAfter(body, anchor, tableNodes);
      insertedParagraphs += 1;
      tablesInserted += 1;
    }
    if (paragraphs.length === 0 && !section.table) continue;
  }

  const outputXml = serializeXml([root]);
  pkg.files['word/document.xml'] = stringToXml(outputXml);
  const outputBuffer = writeDocxPackage(pkg, templateBytes);

  // ---- Validation & fidelity report -------------------------------------
  const warnings: string[] = [];
  const reopened = readDocxPackage(outputBuffer);
  const reopenedXml = xmlToString(reopened.files['word/document.xml']!);
  const outputStructure = analyzeDocumentXml(reopenedXml, stylesXml, coreXml);

  const headerParts = Object.keys(pkg.files).filter((n) => /^word\/header\d+\.xml$/.test(n));
  const footerParts = Object.keys(pkg.files).filter((n) => /^word\/footer\d+\.xml$/.test(n));
  const mediaParts = Object.keys(pkg.files).filter((n) => n.startsWith('word/media/'));

  const headerTexts = headerParts.map((n) => partText(xmlToString(pkg.files[n]!))).filter(Boolean);
  const footerTexts = footerParts.map((n) => partText(xmlToString(pkg.files[n]!))).filter(Boolean);

  const stylesPreserved = !!stylesXml && reopened.files['word/styles.xml'] !== undefined;
  const expectedHeadings =
    originalStructure.headings.length +
    0; // insertion never adds headings (we strip pStyle from inserted paragraphs)
  const headingsOk = outputStructure.headings.length === expectedHeadings;
  if (!headingsOk) {
    warnings.push(
      `Heading count changed from ${originalStructure.headings.length} to ${outputStructure.headings.length}. Check the template's custom styles.`,
    );
  }
  // Tables we wrote are additions, not drift: the template's own tables must all
  // still be present, plus exactly the ones generated for this report.
  const expectedTables = originalStructure.tableCount + tablesInserted;
  const tablesOk = outputStructure.tableCount === expectedTables;
  if (!tablesOk) {
    warnings.push(
      `Table count is ${outputStructure.tableCount}, expected ${expectedTables} (${originalStructure.tableCount} from the template plus ${tablesInserted} generated).`,
    );
  }

  const unresolved = extractPlaceholders(reopenedXml.replace(/<[^>]+>/g, '')).filter(
    (key) => !/^w:|^xml/.test(key),
  );
  if (unresolved.length) {
    warnings.push(`${unresolved.length} placeholder(s) were not filled: ${unresolved.slice(0, 8).join(', ')}`);
  }
  if (originalStructure.contentControlCount > 0) {
    warnings.push('Content controls (w:sdt) were preserved but not restructured.');
  }

  const fidelity: FidelityReport = {
    templateHeadings: originalStructure.headings.length,
    outputHeadings: outputStructure.headings.length,
    templateTables: originalStructure.tableCount,
    outputTables: outputStructure.tableCount,
    templateImages: originalStructure.imagesCount,
    outputImages: outputStructure.imagesCount,
    templateStylesPreserved: stylesPreserved,
    headersPreserved: headerParts.length === Object.keys(readDocxPackage(templateBytes).files).filter((n) => /^word\/header\d+\.xml$/.test(n)).length,
    footersPreserved: footerParts.length === Object.keys(readDocxPackage(templateBytes).files).filter((n) => /^word\/footer\d+\.xml$/.test(n)).length,
    insertedParagraphs,
    replacedPlaceholders,
    warnings,
    passed: headingsOk && tablesOk && stylesPreserved,
  };

  void mediaParts;
  return {
    buffer: outputBuffer,
    fidelity,
    insertedParagraphs,
    insertedTables: tablesInserted,
    replacedPlaceholders,
    unresolvedPlaceholders: unresolved,
  };
}

export { escapeXml, unescapeXml, findAll, paragraphStyleId };
