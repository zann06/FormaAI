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
import { isScreenshotSlotText, matchFiguresToSlots } from './screenshot-slots.js';
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
  /**
   * Which source image this came from.
   *
   * Templates reserve dashed boxes with "[ TEMPELKAN SCREENSHOT: â€¦ ]" instructions,
   * and the right picture for a box is decided by matching the box's wording against
   * the image's OCR text â€” so the figure has to carry its source identity here.
   */
  documentId?: string;
  /** OCR text of the source image, used to pick the slot this figure belongs in. */
  text?: string | null;
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

/**
 * Run properties for generated body text, always safe to modify.
 *
 * Returns a CLONE. `buildContentParagraphs` strips bold/size/colour from these
 * before using them for prose, and handing back the heading's live `<w:rPr>` meant
 * that strip edited the heading itself: every generated section silently turned its
 * own heading from bold 14pt dark blue into plain body text. The visible damage was
 * a document whose headings looked like paragraphs, and the fidelity check then
 * failed with "Heading count changed from 44 to 8" because headings are detected
 * from exactly that formatting â€” which blocked the PDF export as well.
 */
function clonedRunPropsOf(paragraph: XmlNode): XmlNode | null {
  const props = runPropsOf(paragraph);
  return props ? cloneNode(props) : null;
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
 * Replaces `token` inside one section's own stretch of the body, returning the
 * paragraph that received the content so a figure can be anchored to it.
 *
 * Only the first paragraph carrying the token is touched: the token is usually a
 * lone placeholder line, but if the author pasted it twice, filling both would print
 * the generated chapter twice.
 */
function replaceInSectionParagraphs(
  nodes: XmlNode[],
  token: string,
  value: string,
): { count: number; anchor: XmlNode | null } {
  for (const node of nodes) {
    if (node.tag !== 'w:p') continue;
    const count = replaceInParagraph(node, token, value);
    if (count > 0) return { count, anchor: node };
  }
  return { count: 0, anchor: null };
}

/**
 * Body paragraphs that belong to one section: from just after its heading up to the
 * next heading in the template.
 *
 * The bounds come from the analysis's `paragraphIndex` values, not from matching
 * heading text, because two chapters may legitimately share a title and a text match
 * sent every body to whichever came first.
 */
function sectionParagraphs(body: XmlNode, startIndex: number, endIndex: number): XmlNode[] {
  const nodes: XmlNode[] = [];
  for (let index = startIndex + 1; index < endIndex && index < body.children.length; index += 1) {
    const node = body.children[index]!;
    if (node.tag === 'w:p') nodes.push(node);
  }
  return nodes;
}

/**
 * Locates the paragraph that held `token`, so a figure can follow it.
 *
 * Only an exact token hit counts. The old version fell back to the document's first
 * paragraph, which silently anchored the figure to the cover page: by the time the
 * figures were written the token had already been replaced, so the fallback was
 * taken *every* time and the figure never landed in its chapter. Returning null
 * lets the caller place it after the heading instead.
 */
function findPlaceholderParagraph(body: XmlNode, token: string): XmlNode | null {
  const paragraphs = body.children.filter((c) => c.tag === 'w:p');
  return paragraphs.find((p) => paragraphText(p).includes(token)) ?? null;
}

/**
 * The body-level index of the next detected heading after `heading`.
 *
 * A placeholder belongs to the chapter it sits in, so the replacement must stop at
 * the following heading. The stopping rule is the template's own heading paragraphs
 * — the set of heading texts the analysis found — re-scanned against the *current*
 * body, because paragraphs inserted for earlier sections have already shifted the
 * original indices.
 */
function nextHeadingIndex(
  body: XmlNode,
  heading: XmlNode,
  structure: { headings: Array<{ text: string }> },
): number {
  const start = body.children.indexOf(heading);
  if (start < 0) return body.children.length;
  const titles = new Set(structure.headings.map((h) => h.text.trim()).filter(Boolean));
  for (let index = start + 1; index < body.children.length; index += 1) {
    const node = body.children[index]!;
    if (node.tag !== 'w:p') continue;
    if (titles.has(paragraphText(node).trim())) return index;
  }
  return body.children.length;
}

/**
 * Locates a section's heading paragraph.
 *
 * `section.paragraphIndex` comes from the template analysis and indexes
 * `w:body`'s children — which include tables. This function used to look it up in a
 * paragraphs-only array, so the moment a template had a table anywhere above a
 * chapter every later heading resolved to the wrong paragraph (or to none).
 */
function findHeadingParagraph(body: XmlNode, section: AssemblySection): XmlNode | null {
  const wanted = section.headingText.trim();
  if (!wanted) return null;
  const byIndex = body.children[section.paragraphIndex];
  if (byIndex && byIndex.tag === 'w:p' && paragraphText(byIndex).trim() === wanted) return byIndex;

  // The recorded index can also drift when an earlier section in this same pass has
  // already inserted paragraphs. The title is then the next best handle — but it
  // must be *this section's* title: matching any later paragraph with the same text
  // put every chapter that shared a name into the first one. Search outwards from
  // the recorded index, then accept a unique match; an ambiguous title has no safe
  // target, so refuse and let the caller warn instead of guessing.
  const isMatch = (node: XmlNode | undefined) => node !== undefined && node.tag === 'w:p' && paragraphText(node).trim() === wanted;
  const span = body.children.length;
  for (let offset = 1; offset <= Math.min(16, span); offset += 1) {
    const after = body.children[section.paragraphIndex + offset];
    if (isMatch(after)) return after!;
    const before = body.children[section.paragraphIndex - offset];
    if (isMatch(before)) return before!;
  }
  const matches = body.children.filter((node) => isMatch(node));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Places figures into the template's reserved screenshot boxes.
 *
 * The box is a one-cell table with dashed borders; its text is the instruction
 * (`[ TEMPELKAN SCREENSHOT: â€¦ ]` plus a small resolution hint). Filling it means:
 *   1. drop the instruction paragraphs from the cell,
 *   2. append the picture paragraph inside the same cell,
 *   3. size the picture to the cell width so it cannot overflow the frame.
 *
 * The caption paragraph ("Gambar 1. â€¦") sits OUTSIDE the table in these templates,
 * so it keeps its place automatically â€” which is why the caption and its picture were
 * on different pages before.
 *
 * Figures that match no box are returned so the caller can append them as before.
 */
function fillScreenshotSlots(
  body: XmlNode,
  figures: AssemblyFigure[],
  writer: { add: (figure: AssemblyFigure, options?: { maxWidthEmu?: number }) => XmlNode | null },
  headingPara: XmlNode | null,
): { filled: number; remaining: AssemblyFigure[] } {
  if (figures.length === 0) return { filled: 0, remaining: figures };

  // Only boxes AFTER this section's heading belong to it. Without this, the first
  // section's figures could fill the last section's boxes.
  const startIndex = headingPara ? body.children.indexOf(headingPara) : 0;
  if (startIndex < 0) return { filled: 0, remaining: figures };

  const slots: Array<{ node: XmlNode; slotText: string }> = [];
  for (let index = startIndex; index < body.children.length; index += 1) {
    const node = body.children[index]!;
    if (node.tag !== 'w:tbl') continue;
    const text = collectNodeText(node);
    if (!isScreenshotSlotText(text)) continue;
    slots.push({ node, slotText: text });
  }
  if (slots.length === 0) return { filled: 0, remaining: figures };

  const candidates = figures
    .filter((figure) => figure.documentId)
    .map((figure) => ({ documentId: figure.documentId!, text: figure.text ?? '' }));
  if (candidates.length === 0) return { filled: 0, remaining: figures };

  const { matches } = matchFiguresToSlots(slots, candidates);
  if (matches.length === 0) return { filled: 0, remaining: figures };

  const filledIds = new Set(matches.map((match) => match.documentId));
  let filled = 0;
  for (const match of matches) {
    const figure = figures.find((candidate) => candidate.documentId === match.documentId);
    if (!figure) continue;

    const cell = findCellOf(match.node);
    if (!cell) continue;

    // Reserve the cell's own width for the picture (dxa -> EMU: 1 dxa = 635 EMU),
    // minus the cell margins the template set (200 twips each side).
    const cellWidthDxa = cellWidthOf(cell) ?? 8504;
    const maxWidthEmu = Math.max(914400, (cellWidthDxa - 400) * 635);

    const imagePara = writer.add(figure, { maxWidthEmu });
    if (!imagePara) continue;

    // Remove the instruction paragraphs so the box shows the picture, not the prompt.
    const keptChildren: XmlNode[] = [];
    for (const child of cell.children) {
      if (child.tag === 'w:tcPr') {
        keptChildren.push(child);
        continue;
      }
      if (child.tag === 'w:p' && isScreenshotSlotText(collectNodeText(child))) continue;
      // The small "Pastikan screenshot diambilâ€¦" hint is also part of the prompt.
      if (child.tag === 'w:p' && /pastikan\s+screenshot/i.test(collectNodeText(child))) continue;
      keptChildren.push(child);
    }
    // A table cell must contain at least one paragraph; the image paragraph counts,
    // but Word is happier with a trailing empty one.
    cell.children = [...keptChildren, imagePara, createParagraph('')];
    filled += 1;
  }

  return { filled, remaining: figures.filter((figure) => !figure.documentId || !filledIds.has(figure.documentId)) };
}

function collectNodeText(node: XmlNode): string {
  if (node.tag === '#text') return node.text ?? '';
  let out = '';
  for (const child of node.children) out += collectNodeText(child);
  return out;
}

function findCellOf(table: XmlNode): XmlNode | null {
  const cells = findAll(table, 'w:tc');
  return cells[0] ?? null;
}

function cellWidthOf(cell: XmlNode): number | null {
  const props = findChild(cell, 'w:tcPr');
  const width = props ? findChild(props, 'w:tcW') : null;
  const value = width?.attrs['w:w'];
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  // Body text must not inherit heading emphasis (bold, larger size, colour). This
  // filters the run properties, so it must operate on a COPY â€” `runPropsOf` hands
  // back the heading's live `<w:rPr>` and editing that in place stripped the
  // heading's own formatting (see `clonedRunPropsOf`).
  const rProps = headingPara ? clonedRunPropsOf(headingPara) : null;
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
      if (/^([-*â€¢]|\d+[.)])\s+/.test(trimmed)) {
        flush();
        current.push(trimmed.replace(/^[-*â€¢]\s+/, 'â€¢ '));
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
  add: (figure: AssemblyFigure, options?: { maxWidthEmu?: number }) => XmlNode | null;
} {
  const relsPath = 'word/_rels/document.xml.rels';
  // These must MUTATE as figures are added. Writing `pkg.files[relsPath]` from a
  // stale local string made each figure overwrite the previous relationship, so a
  // 25-image report shipped one valid relationship and 24 dangling ones â€” Word
  // treats a drawing whose r:embed resolves to nothing as corrupt, and LibreOffice
  // silently drops it. The PDF then showed 2 of 25 pictures while the DOCX looked
  // fine on inspection.
  let relsXml = pkg.files[relsPath] ? xmlToString(pkg.files[relsPath]!) : null;
  const contentTypesPath = '[Content_Types].xml';
  let contentTypesXml = pkg.files[contentTypesPath] ? xmlToString(pkg.files[contentTypesPath]!) : null;

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
    add(figure, options) {
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
      // Append to the CURRENT rels text, not the text as it was before the previous
      // figures added theirs â€” otherwise this write erases them.
      relsXml = relsXml.includes('</Relationships>')
        ? relsXml.replace('</Relationships>', `${relationship}</Relationships>`)
        : relsXml;
      pkg.files[relsPath] = stringToXml(relsXml);

      // <Default Extension="png" .../> is required or Word refuses the package.
      const mime =
        figure.extension === 'png' ? 'image/png' : figure.extension === 'gif' ? 'image/gif' : 'image/jpeg';
      if (!addedExtensions.has(figure.extension) && !contentTypesXml.includes(`Extension="${figure.extension}"`)) {
        addedExtensions.add(figure.extension);
        const decl = `<Default Extension="${figure.extension}" ContentType="${mime}"/>`;
        contentTypesXml = contentTypesXml.includes('<Types')
          ? contentTypesXml.replace(/(<Types[^>]*>)/, `$1${decl}`)
          : contentTypesXml;
        pkg.files[contentTypesPath] = stringToXml(contentTypesXml);
      }

      return createImageParagraph({
        relId,
        documentPrId: docPrId,
        name: fileName,
        widthPx: size.width,
        heightPx: size.height,
        ...(options?.maxWidthEmu ? { maxWidthEmu: options.maxWidthEmu } : {}),
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
  /** Dashed template slots that received their picture. */
  let tablesFilled = 0;
  /**
   * Sections whose content could not be placed where the template wanted it.
   *
   * These are fidelity failures, not notes: the chapter keeps its template text or
   * goes missing entirely, so the report must not claim it passed.
   */
  const unresolvedSections: string[] = [];

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
      /*
       * The replacement is scoped to the section's OWN body. Sweeping the whole
       * document filled the token wherever it appeared — printing the chapter twice
       * when the author had duplicated the token, and rewriting a `{{token}}` sitting
       * in the table of contents.
       *
       * When no heading can be located the whole body is searched instead, but
       * `replaceInSectionParagraphs` still stops at the FIRST paragraph carrying the
       * token, so a duplicated token can never print the chapter twice.
       */
      const heading = findHeadingParagraph(body, section) ?? findPlaceholderParagraph(body, token);
      const scope = heading
        ? sectionParagraphs(body, body.children.indexOf(heading), nextHeadingIndex(body, heading, originalStructure))
        : [];
      const targets = scope.length > 0 ? scope : body.children;
      const { count, anchor: filledParagraph } = replaceInSectionParagraphs(
        targets,
        token,
        content.replace(/\n{2,}/g, '\n'),
      );
      replacedPlaceholders += count;
      if (count === 0) {
        // The token was not found where it belongs, so this chapter will keep its
        // template text. That is a fidelity failure, not a cosmetic warning.
        unresolvedSections.push(`${section.headingText}: placeholder {{${placeholder}}} was not found in this section`);
      }
      // A figure belongs to the section whatever strategy filled its text. The anchor
      // is the paragraph that received the content, falling back to the heading — not
      // a fresh token lookup, which would only work while the token is still there.
      if (count > 0 && (section.figures?.length ?? 0) > 0) {
        const placeholderPara = filledParagraph ?? heading;
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
    if (!headingPara) {
      // Silently `continue`-ing here deleted the chapter AND its generated table and
      // figures while the report still said `passed: true`. Say so instead.
      unresolvedSections.push(`${section.headingText}: heading not found in the template, its content was not written`);
      continue;
    }
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
    //
    // But a template that RESERVES a slot for the picture must be honoured. Real
    // campus templates wrap a dashed-border table cell around
    // "[ TEMPELKAN SCREENSHOT: Diagram Topologi â€¦ ]", and appending the figure after
    // the prose left that box empty while the picture floated elsewhere â€” the defect
    // the user reported. Figures that match a slot go INSIDE it; only the leftovers
    // are appended as before.
    const sectionFigures = section.figures ?? [];
    const slotResult = fillScreenshotSlots(body, sectionFigures, figureWriter, headingPara);
    imagesInserted += slotResult.filled;
    if (slotResult.filled > 0) tablesFilled += slotResult.filled;

    let imageAnchor = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]! : headingPara;
    let sectionImages = 0;
    for (const figure of slotResult.remaining) {
      const node = figureWriter.add(figure);
      if (!node) continue;
      insertAfter(body, imageAnchor, [node]);
      imageAnchor = node;
      sectionImages += 1;
      imagesInserted += 1;
    }
    if (paragraphs.length === 0 && !section.table && sectionImages === 0 && slotResult.filled === 0) continue;
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
  // A section that could not be placed is the difference between "the report follows
  // the template" and "the report is missing a chapter". It used to be swallowed.
  for (const problem of unresolvedSections) warnings.push(problem);
  if (originalStructure.contentControlCount > 0) {
    warnings.push('Content controls (w:sdt) were preserved but not restructured.');
  }

  /**
   * Header/footer preservation, checked by content and not by filename.
   *
   * This used to be `partCount === partCount` — a filename census that is true by
   * construction, because the export copies those parts through untouched. A census
   * cannot detect a header whose text was lost, so it compared nothing. Compare the
   * actual text now: whatever the template's headers said must still be said.
   */
  const sourceParts = readDocxPackage(templateBytes).files;
  const headerPartsIntact = headerTexts.every((text) =>
    headerParts.some((name) => partText(xmlToString(reopened.files[name]!)).includes(text)),
  ) && headerParts.length === Object.keys(sourceParts).filter((n) => /^word\/header\d+\.xml$/.test(n)).length;
  const footerPartsIntact = footerTexts.every((text) =>
    footerParts.some((name) => partText(xmlToString(reopened.files[name]!)).includes(text)),
  ) && footerParts.length === Object.keys(sourceParts).filter((n) => /^word\/footer\d+\.xml$/.test(n)).length;

  const fidelity: FidelityReport = {
    templateHeadings: originalStructure.headings.length,
    outputHeadings: outputStructure.headings.length,
    templateTables: originalStructure.tableCount,
    outputTables: outputStructure.tableCount,
    templateImages: originalStructure.imagesCount,
    outputImages: outputStructure.imagesCount,
    templateStylesPreserved: stylesPreserved,
    headersPreserved: headerPartsIntact,
    footersPreserved: footerPartsIntact,
    insertedParagraphs,
    replacedPlaceholders,
    warnings,
    // A chapter that could not be placed, or a header/footer whose text went missing,
    // means the output does not follow the template — regardless of the counts.
    passed:
      headingsOk &&
      tablesOk &&
      imagesOk &&
      stylesPreserved &&
      headerPartsIntact &&
      footerPartsIntact &&
      unresolvedSections.length === 0,
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
