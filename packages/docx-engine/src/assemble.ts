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
  createImageParagraph,
  createParagraph,
  createTable,
  escapeXml,
  findAll,
  findChild,
  imagePixelSize,
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

/**
 * A source image to embed after the section's prose.
 *
 * A diagram or a screenshot of CLI output is evidence prose cannot reproduce, and
 * OCR reads its labels imperfectly ("Gig0/0" comes back as "Gi90/0"), so the
 * picture itself is carried into the document. `bytes` is the original image; the
 * assembler writes it as a real `word/media` part plus a `<w:drawing>`.
 */
export interface AssemblyFigure {
  /** Original file bytes (PNG/JPEG/GIF). */
  bytes: Uint8Array;
  /** File extension used for the media part and content type. */
  extension: 'png' | 'jpeg' | 'gif';
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
  /** Source images to emit after the section's prose. */
  figures?: AssemblyFigure[];
  /** Skip content insertion (e.g. user excluded the section). */
  skip?: boolean;
}

export interface AssembleOptions {
  sections: AssemblySection[];
  /** Additional key/value placeholder replacements applied to the whole document. */
  globalPlaceholders?: Record<string, string>;
  /**
   * Literal text replacements applied across the whole document.
   *
   * Templates written for students carry fill-in prompts like
   * "[ Tuliskan Nama Lengkap Anda ]" rather than {{tokens}}, so the identity the
   * user typed can only be inserted by replacing that exact text in place. Doing
   * it here keeps the paragraph (and therefore the cover layout) intact instead
   * of appending a new one.
   */
  textReplacements?: Array<{ find: string; replace: string }>;
  /** Extra top-level info block, e.g. report title/date placeholders. */
  title?: string;
}

export interface AssembleResult {
  buffer: Uint8Array;
  fidelity: FidelityReport;
  insertedParagraphs: number;
  /** Word tables written from generated cells. */
  insertedTables: number;
  /** Source images embedded as real media parts. */
  insertedImages: number;
  replacedPlaceholders: number;
  /** Literal "[ ... ]" fill-in prompts replaced with user-supplied values. */
  replacedLiteralPrompts: number;
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

/**
 * Locates the paragraph that held `token` so a figure can follow it.
 *
 * The replacement keeps the paragraph and swaps its text, so the enclosing <w:p>
 * is found by walking up from the text that is still there. Falls back to the
 * first body paragraph rather than dropping the figure entirely.
 */
function findPlaceholderParagraph(body: XmlNode, token: string): XmlNode | null {
  const paragraphs = body.children.filter((c) => c.tag === 'w:p');
  return paragraphs.find((p) => paragraphText(p).includes(token)) ?? paragraphs[0] ?? null;
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

/**
 * Registers source images as real DOCX media parts and builds their drawing XML.
 *
 * Word treats a `<w:drawing>` whose `r:embed` has no matching relationship as a
 * corrupt document, so the bytes, the relationship and the content-type default
 * are written together here. Anything that cannot be registered returns null and
 * the section simply keeps its prose rather than producing a broken file.
 */
function createFigureWriter(pkg: DocxPackage): {
  add: (figure: AssemblyFigure) => XmlNode | null;
} {
  const relsPath = 'word/_rels/document.xml.rels';
  const relsXml = pkg.files[relsPath] ? xmlToString(pkg.files[relsPath]!) : null;
  const contentTypesPath = '[Content_Types].xml';
  const contentTypesXml = pkg.files[contentTypesPath] ? xmlToString(pkg.files[contentTypesPath]!) : null;

  // Continue numbering from whatever the template already contains.
  const existingMedia = Object.keys(pkg.files).filter((n) => n.startsWith('word/media/')).length;
  const existingRelIds = new Set(
    [...(relsXml ?? '').matchAll(/Id="([^"]+)"/g)].map((match) => match[1]!),
  );

  let mediaIndex = existingMedia;
  let relIndex = 0;
  let docPrId = 1000;
  const addedExtensions = new Set<string>();

  return {
    add(figure) {
      if (!relsXml || !contentTypesXml) return null;
      if (figure.bytes.byteLength === 0) return null;
      const size = imagePixelSize(figure.bytes);
      if (!size || size.width <= 0 || size.height <= 0) return null;

      mediaIndex += 1;
      relIndex += 1;
      docPrId += 1;
      const fileName = `image${mediaIndex}.${figure.extension}`;
      let relId = `rIdFig${relIndex}`;
      while (existingRelIds.has(relId)) {
        relIndex += 1;
        relId = `rIdFig${relIndex}`;
      }
      existingRelIds.add(relId);

      const mediaPath = `word/media/${fileName}`;
      // `writeDocxPackage` iterates `pkg.names`, so a new part must be registered
      // there or it is silently dropped and the relationship points at nothing.
      if (!pkg.files[mediaPath]) pkg.names.push(mediaPath);
      pkg.files[mediaPath] = figure.bytes;

      const relationship =
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`;
      pkg.files[relsPath] = stringToXml(
        relsXml.includes('</Relationships>')
          ? relsXml.replace('</Relationships>', `${relationship}</Relationships>`)
          : relsXml,
      );

      // <Default Extension="png" .../> is required or Word refuses the package.
      const mime =
        figure.extension === 'png' ? 'image/png' : figure.extension === 'gif' ? 'image/gif' : 'image/jpeg';
      if (!addedExtensions.has(figure.extension) && !contentTypesXml.includes(`Extension="${figure.extension}"`)) {
        addedExtensions.add(figure.extension);
        const decl = `<Default Extension="${figure.extension}" ContentType="${mime}"/>`;
        pkg.files[contentTypesPath] = stringToXml(
          contentTypesXml.includes('<Types')
            ? contentTypesXml.replace(/(<Types[^>]*>)/, `$1${decl}`)
            : contentTypesXml,
        );
      }

      return createImageParagraph({
        relId,
        documentPrId: docPrId,
        name: fileName,
        widthPx: size.width,
        heightPx: size.height,
      });
    },
  };
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
  let imagesInserted = 0;

  // Figures are written as real media parts. Word needs three things to stay
  // consistent: the bytes under `word/media/`, a relationship in
  // `word/_rels/document.xml.rels`, and a content-type default for the extension.
  const figureWriter = createFigureWriter(pkg);

  // 1. Global placeholder replacements (e.g. {{report_title}}, {{date}})
  if (options.globalPlaceholders) {
    for (const [key, value] of Object.entries(options.globalPlaceholders)) {
      replacedPlaceholders += replaceInAllParagraphs(root.children, `{{${key}}}`, value);
    }
  }
  // 1b. Literal replacements for templates that use "[ ... ]" fill-in prompts.
  // Applied in place so the cover keeps its layout and line breaks.
  let literalReplacements = 0;
  if (options.textReplacements) {
    for (const { find, replace } of options.textReplacements) {
      if (!find) continue;
      const hits = replaceInAllParagraphs(root.children, find, replace);
      literalReplacements += hits;
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
      // A figure belongs to the section whatever strategy filled its text, so it
      // still has to be written; only the prose was handled above.
      if (count > 0 && (section.figures?.length ?? 0) > 0) {
        const placeholderPara = findPlaceholderParagraph(body, token);
        if (placeholderPara) {
          let anchor = placeholderPara;
          for (const figure of section.figures ?? []) {
            const node = figureWriter.add(figure);
            if (!node) continue;
            insertAfter(body, anchor, [node]);
            anchor = node;
            imagesInserted += 1;
          }
        }
      }
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
    // Source images follow the table: the reader sees the original diagram, which
    // is what makes imperfect OCR harmless rather than misleading.
    let imageAnchor = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]! : headingPara;
    let sectionImages = 0;
    for (const figure of section.figures ?? []) {
      const node = figureWriter.add(figure);
      if (!node) continue;
      insertAfter(body, imageAnchor, [node]);
      imageAnchor = node;
      sectionImages += 1;
      imagesInserted += 1;
    }
    if (paragraphs.length === 0 && !section.table && sectionImages === 0) continue;
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
  // Source images we embedded are additions too: the template's own images must all
  // survive, plus exactly the figures attached to sections.
  const expectedImages = originalStructure.imagesCount + imagesInserted;
  const imagesOk = outputStructure.imagesCount === expectedImages;
  if (!imagesOk) {
    warnings.push(
      `Image count is ${outputStructure.imagesCount}, expected ${expectedImages} (${originalStructure.imagesCount} from the template plus ${imagesInserted} from sources).`,
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
    passed: headingsOk && tablesOk && imagesOk && stylesPreserved,
  };

  void mediaParts;
  return {
    buffer: outputBuffer,
    fidelity,
    insertedParagraphs,
    insertedTables: tablesInserted,
    insertedImages: imagesInserted,
    replacedPlaceholders,
    replacedLiteralPrompts: literalReplacements,
    unresolvedPlaceholders: unresolved,
  };
}

export { escapeXml, unescapeXml, findAll, paragraphStyleId };
