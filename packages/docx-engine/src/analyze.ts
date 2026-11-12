import {
  findAll,
  findChild,
  paragraphAlignment,
  paragraphNumberingLevel,
  paragraphOutlineLevel,
  paragraphStyleId,
  paragraphText,
  parseXml,
  runBold,
  runSizeHalfPoints,
  textOf,
  type XmlNode,
} from './xml.js';
import type { TemplateHeading, TemplateStructure } from '@formaai/shared';

export interface AnalyzeOptions {
  /** Treat this styleId (or "Heading N"-like names) as headings when no outline level exists. */
  headingStyleIds?: string[];
}

/**
 * Word heading styles are named differently across locales and authoring tools.
 * Campus/school templates also frequently use "BAB 1", "BAGIAN 2", etc.
 */
const HEADING_NAME_RE =
  /^(heading|judul|bab|bagian|section|titre|überschrift|título|titulo|titel|kop|capítulo|capitulo)\s*([1-9])\b/i;
const HEADING_WORD_ONLY_RE = /^(heading|judul|bab|bagian|chapter|titre|überschrift|título|titulo|titel|kop)$/i;

/** Long-form chapter titles that are headings even without any special formatting. */
const COMMON_HEADING_TEXT =
  /^(kata pengantar|daftar isi|daftar tabel|daftar gambar|daftar lampiran|abstrak|abstract|pendahuluan|tinjauan pustaka|landasan teori|metodologi penelitian|metodologi|metode penelitian|hasil dan pembahasan|pembahasan|kesimpulan dan saran|kesimpulan|penutup|saran|daftar pustaka|referensi|lampiran)$/i;

export interface StyleInfo {
  id: string;
  name: string;
  type: string;
  basedOn: string | null;
  outlineLevel: number | null;
  bold: boolean | null;
  sizeHalfPoints: number | null;
}

export interface RunFormat {
  bold: boolean | null;
  sizeHalfPoints: number | null;
}

function readRunFormat(rPr: XmlNode | undefined): RunFormat {
  if (!rPr) return { bold: null, sizeHalfPoints: null };
  const boldNode = findChild(rPr, 'w:b');
  const bold = boldNode
    ? !(boldNode.attrs['w:val'] === '0' || boldNode.attrs['w:val'] === 'false' || boldNode.attrs['w:val'] === 'off')
    : null;
  const sizeNode = findChild(rPr, 'w:sz');
  const rawSize = sizeNode ? Number(sizeNode.attrs['w:val']) : NaN;
  return { bold, sizeHalfPoints: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null };
}

export function parseStyles(stylesXml: string | null): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  if (!stylesXml) return map;
  const [root] = parseXml(stylesXml);
  if (!root) return map;
  const stylesRoot = root.tag === 'w:styles' ? root : findChild(root, 'w:styles');
  if (!stylesRoot) return map;
  for (const style of stylesRoot.children.filter((c) => c.tag === 'w:style')) {
    const id = style.attrs['w:styleId'];
    if (!id) continue;
    const nameNode = findChild(style, 'w:name');
    const basedOn = findChild(style, 'w:basedOn');
    const pPr = findChild(style, 'w:pPr');
    const outline = pPr ? findChild(pPr, 'w:outlineLvl') : undefined;
    const format = readRunFormat(findChild(style, 'w:rPr'));
    map.set(id, {
      id,
      name: nameNode?.attrs['w:val'] ?? id,
      type: style.attrs['w:type'] ?? 'paragraph',
      basedOn: basedOn?.attrs['w:val'] ?? null,
      outlineLevel: outline ? Number(outline.attrs['w:val']) : null,
      bold: format.bold,
      sizeHalfPoints: format.sizeHalfPoints,
    });
  }
  return map;
}

/** Document-wide default run formatting (`w:docDefaults`). */
export function parseStyleDefaults(stylesXml: string | null): RunFormat {
  if (!stylesXml) return { bold: null, sizeHalfPoints: null };
  const [root] = parseXml(stylesXml);
  if (!root) return { bold: null, sizeHalfPoints: null };
  const stylesRoot = root.tag === 'w:styles' ? root : findChild(root, 'w:styles');
  if (!stylesRoot) return { bold: null, sizeHalfPoints: null };
  const defaults = findChild(stylesRoot, 'w:docDefaults');
  const rPrDefault = defaults ? findChild(defaults, 'w:rPrDefault') : undefined;
  return readRunFormat(rPrDefault ? findChild(rPrDefault, 'w:rPr') : undefined);
}

function resolveOutlineLevel(styleId: string | null, styles: Map<string, StyleInfo>): number | null {
  if (!styleId) return null;
  let current: string | null = styleId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const info = styles.get(current);
    if (!info) break;
    if (info.outlineLevel != null && Number.isFinite(info.outlineLevel)) return info.outlineLevel;
    const match = HEADING_NAME_RE.exec(info.name);
    if (match) return Number(match[2]) - 1;
    if (HEADING_WORD_ONLY_RE.test(info.name)) return 0;
    if (/^(title|subtitle)$/i.test(info.name)) return info.name.toLowerCase() === 'title' ? 0 : 1;
    current = info.basedOn;
  }
  return null;
}

/** Resolves run formatting through the style inheritance chain, then direct runs. */
function resolveStyleFormat(
  styleId: string | null,
  styles: Map<string, StyleInfo>,
  defaults: RunFormat,
): RunFormat {
  const chain: StyleInfo[] = [];
  let current: string | null = styleId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const info = styles.get(current);
    if (!info) break;
    chain.push(info);
    current = info.basedOn;
  }
  let format: RunFormat = { ...defaults };
  for (const info of chain.reverse()) {
    if (info.bold !== null) format.bold = info.bold;
    if (info.sizeHalfPoints !== null) format.sizeHalfPoints = info.sizeHalfPoints;
  }
  return format;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Level implied by the text itself, e.g. "BAB II", "2.1 Peserta", "A. Latar Belakang". */
export function headingPatternLevel(text: string): number | null {
  const value = text.trim();
  if (/^(bab|chapter|bagian)\s+([ivxlc]+|\d+)\b/i.test(value)) return 1;
  const numeric = /^(\d+(?:\.\d+){0,3})\.?\s+\S/.exec(value);
  if (numeric) return Math.min(numeric[1]!.split('.').length, 4);
  if (/^[IVXLC]+\.\s+\S/.test(value)) return 1;
  if (/^[A-Z]\.\s+\S/.test(value)) return 2;
  if (/^[a-z]\.\s+\S/.test(value)) return 3;
  if (COMMON_HEADING_TEXT.test(value)) return 1;
  return null;
}

export interface BodyItem {
  kind: 'paragraph' | 'table';
  node: XmlNode;
  paragraphsInTable: number;
}

/** Body-level children, in document order, skipping bookmarks/non-content nodes. */
export function bodyItems(documentRoot: XmlNode): BodyItem[] {
  const body = findChild(documentRoot, 'w:body');
  if (!body) return [];
  const items: BodyItem[] = [];
  for (const child of body.children) {
    if (child.tag === 'w:p') items.push({ kind: 'paragraph', node: child, paragraphsInTable: 0 });
    else if (child.tag === 'w:tbl') {
      items.push({ kind: 'table', node: child, paragraphsInTable: findAll(child, 'w:p').length });
    }
  }
  return items;
}

export function extractPlaceholders(text: string, open = '{{', close = '}}'): string[] {
  const results: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(open, index);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    const key = text.slice(start + open.length, end).trim();
    if (key && key.length <= 120 && !key.includes('\n')) results.push(key);
    index = end + close.length;
  }
  return Array.from(new Set(results));
}

export function analyzeDocumentXml(
  documentXml: string,
  stylesXml: string | null,
  coreXml: string | null,
  options: AnalyzeOptions = {},
): TemplateStructure {
  const warnings: string[] = [];
  const [documentRoot] = parseXml(documentXml);
  if (!documentRoot) throw new Error('word/document.xml has no root element');
  const styles = parseStyles(stylesXml);
  const styleDefaults = parseStyleDefaults(stylesXml);
  const items = bodyItems(documentRoot);
  const explicitHeadingStyles = new Set(options.headingStyleIds ?? []);

  interface ParagraphFeature {
    itemIndex: number;
    text: string;
    styleId: string | null;
    styleName: string | null;
    /** 0-based level from a Word style/outline level, when the document states one. */
    outlineLevel: number | null;
    bold: boolean;
    sizeHalfPoints: number | null;
    alignment: string | null;
    numberingLevel: number | null;
    pageBreakBefore: boolean;
  }

  const features: ParagraphFeature[] = [];
  items.forEach((item, itemIndex) => {
    if (item.kind !== 'paragraph') return;
    const text = paragraphText(item.node).trim();
    if (!text) return;
    const styleId = paragraphStyleId(item.node);
    const styleInfo = styleId ? styles.get(styleId) : undefined;
    const baseFormat = resolveStyleFormat(styleId, styles, styleDefaults);

    // Boldness is weighted by characters so a bold label inside an otherwise
    // regular paragraph does not turn the whole paragraph into a heading.
    let boldChars = 0;
    let totalChars = 0;
    let maxSize: number | null = null;
    for (const run of findAll(item.node, 'w:r')) {
      const runText = textOf(run).trim();
      const length = runText.length;
      const runIsBold = runBold(run) ?? baseFormat.bold ?? false;
      if (length > 0) {
        totalChars += length;
        if (runIsBold) boldChars += length;
      }
      const runSize = runSizeHalfPoints(run) ?? baseFormat.sizeHalfPoints;
      if (runSize !== null) maxSize = maxSize === null ? runSize : Math.max(maxSize, runSize);
    }
    const bold = totalChars > 0 ? boldChars / totalChars >= 0.85 : baseFormat.bold === true;

    let level: number | null = null;
    if (styleId && explicitHeadingStyles.has(styleId)) level = 0;
    if (level === null) level = resolveOutlineLevel(styleId, styles);
    if (level === null) level = paragraphOutlineLevel(item.node);

    const pPr = findChild(item.node, 'w:pPr');
    features.push({
      itemIndex,
      text,
      styleId,
      styleName: styleInfo?.name ?? null,
      outlineLevel: level !== null && level <= 8 ? level : null,
      bold,
      sizeHalfPoints: maxSize ?? baseFormat.sizeHalfPoints,
      alignment: paragraphAlignment(item.node),
      numberingLevel: paragraphNumberingLevel(item.node),
      pageBreakBefore: !!(pPr && findChild(pPr, 'w:pageBreakBefore')),
    });
  });

  // Body text size is only a baseline for comparison; heading-heavy documents
  // still produce a usable median because headings are a minority.
  const medianSize = median(
    features.map((f) => f.sizeHalfPoints).filter((value): value is number => value !== null),
  );

  function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function looksLikeHeadingText(text: string): boolean {
    if (text.length > 160) return false;
    if (/[.;,]$/.test(text)) return false;
    // Table-of-contents leaders are not headings.
    if (/\.{3,}/.test(text) || /\t/.test(text)) return false;
    if (/^[•·●○◦▪▫–—*]\s/.test(text)) return false;
    // A full sentence is body text, however it is formatted.
    if (wordCount(text) > 16) return false;
    return true;
  }

  function isAllCapsHeading(text: string): boolean {
    const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (letters.length < 3) return false;
    return letters === letters.toUpperCase() && wordCount(text) <= 12;
  }

  interface DetectedHeading {
    text: string;
    level: number;
    styleId: string | null;
    itemIndex: number;
    pageBreakBefore: boolean;
    source: 'style' | 'format';
    score: number;
    sizeHalfPoints: number | null;
  }

  function formatScore(feature: ParagraphFeature, patternLevel: number | null): number {
    let score = 0;
    if (feature.bold) score += 1.5;
    if (medianSize !== null && feature.sizeHalfPoints !== null) {
      if (feature.sizeHalfPoints >= medianSize + 2) score += 1.5;
      else if (feature.sizeHalfPoints >= medianSize + 1) score += 0.75;
    }
    if (feature.alignment === 'center') score += 1;
    if (feature.pageBreakBefore) score += 1;
    if (feature.numberingLevel !== null) score += 0.5;
    if (patternLevel !== null) score += 2;
    if (isAllCapsHeading(feature.text)) score += 1;
    return score;
  }

  const styleHeadings: DetectedHeading[] = [];
  const formatCandidates: DetectedHeading[] = [];
  for (const feature of features) {
    if (feature.outlineLevel !== null) {
      styleHeadings.push({
        text: feature.text,
        level: feature.outlineLevel + 1,
        styleId: feature.styleId,
        itemIndex: feature.itemIndex,
        pageBreakBefore: feature.pageBreakBefore,
        source: 'style',
        score: 10,
        sizeHalfPoints: feature.sizeHalfPoints,
      });
      continue;
    }
    if (!looksLikeHeadingText(feature.text)) continue;
    const patternLevel = headingPatternLevel(feature.text);
    const score = formatScore(feature, patternLevel);
    // Two independent kinds of evidence are required. A bold, large paragraph
    // that reads like a sentence is not promoted, because promoting it would
    // insert generated text in the middle of the author's prose. Bold numbered
    // list items are common in body text, so they need more evidence.
    const isListItem = feature.numberingLevel !== null;
    const accepted =
      patternLevel !== null
        ? score >= (isListItem ? 4.5 : 3)
        : score >= 4 && (feature.bold || feature.alignment === 'center');
    if (!accepted) continue;
    formatCandidates.push({
      text: feature.text,
      level: patternLevel ?? 0,
      styleId: feature.styleId,
      itemIndex: feature.itemIndex,
      pageBreakBefore: feature.pageBreakBefore,
      source: 'format',
      score,
      sizeHalfPoints: feature.sizeHalfPoints,
    });
  }

  // If formatting alone suggests an implausible share of the document, tighten
  // the threshold for *patternless* candidates rather than turning half the
  // document into sections. Numbered/chapter-titled candidates are reliable
  // enough to keep, because they carry an explicit hierarchy in their text.
  const patterned = formatCandidates.filter((candidate) => candidate.level > 0);
  const patternless = formatCandidates.filter((candidate) => candidate.level === 0);
  let acceptedFormat = [...patterned, ...patternless];
  const maxPatternless = Math.max(3, Math.floor(features.length * 0.4));
  if (patternless.length > maxPatternless) {
    const ranked = [...patternless].sort((a, b) => b.score - a.score).slice(0, maxPatternless);
    const keep = new Set(ranked.map((candidate) => candidate.itemIndex));
    acceptedFormat = [...patterned, ...patternless.filter((candidate) => keep.has(candidate.itemIndex))];
  }
  acceptedFormat.sort((a, b) => a.itemIndex - b.itemIndex);

  // Format-only sections have no declared level; rank their font sizes so the
  // largest heading level becomes chapter level.
  const distinctSizes = Array.from(
    new Set(
      acceptedFormat
        .filter((candidate) => candidate.level === 0 && candidate.sizeHalfPoints !== null)
        .map((candidate) => candidate.sizeHalfPoints!),
    ),
  ).sort((a, b) => b - a);
  const sizeLevel = new Map<number, number>();
  distinctSizes.forEach((size, index) => sizeLevel.set(size, Math.min(index + 1, 4)));

  const detected: DetectedHeading[] = [...styleHeadings, ...acceptedFormat].sort(
    (a, b) => a.itemIndex - b.itemIndex,
  );

  // Keep the first section at level 1 and never jump more than one level at a
  // time; both are requirements of the outline UI and the DOCX assembler.
  let previousLevel = 0;
  for (const heading of detected) {
    let level = heading.level;
    if (level <= 0 && heading.sizeHalfPoints !== null) level = sizeLevel.get(heading.sizeHalfPoints) ?? 0;
    if (previousLevel === 0) level = 1;
    else if (level <= 0) level = Math.min(previousLevel + 1, 3);
    else if (level > previousLevel + 1) level = previousLevel + 1;
    heading.level = Math.max(1, Math.min(level, 6));
    previousLevel = heading.level;
  }

  const formatHeadingCount = detected.filter((heading) => heading.source === 'format').length;

  const placeholders = extractPlaceholders(documentXml.replace(/<[^>]+>/g, ''));
  const placeholderKeysLower = placeholders.map((p) => p.toLowerCase());

  const headings: TemplateHeading[] = detected.map((heading, order) => {
    const next = detected[order + 1];
    const endIndex = next ? next.itemIndex : items.length;
    const sectionItems = items.slice(heading.itemIndex + 1, endIndex);
    const bodyTexts: string[] = [];
    let tableCount = 0;
    let hasImages = false;
    for (const item of sectionItems) {
      if (item.kind === 'paragraph') bodyTexts.push(paragraphText(item.node));
      else tableCount += 1;
      if (findAll(item.node, 'w:drawing').length > 0 || findAll(item.node, 'w:pict').length > 0) hasImages = true;
    }
    const bodyText = bodyTexts.filter(Boolean).join('\n').trim();
    const sectionPlaceholders = extractPlaceholders(bodyText);
    const keyCandidates = [
      `sec${order + 1}`,
      `section${order + 1}`,
      heading.text.toLowerCase().trim(),
    ];
    const hasExplicitPlaceholder = keyCandidates.some((candidate) =>
      placeholderKeysLower.some((p) => p === candidate || p.includes(candidate)),
    );
    return {
      id: `sec-${order + 1}`,
      text: heading.text,
      level: heading.level,
      order,
      styleId: heading.styleId,
      styleName: heading.styleId ? (styles.get(heading.styleId)?.name ?? heading.styleId) : null,
      numberingLabel: null,
      paragraphIndex: heading.itemIndex,
      bodyText: bodyText.slice(0, 4000),
      bodyParagraphCount: bodyTexts.filter(Boolean).length,
      placeholders: sectionPlaceholders,
      hasExplicitPlaceholder,
      tableCount,
      hasImages,
      pageBreakBefore: heading.pageBreakBefore,
      suggestedStrategy: sectionPlaceholders.length > 0 ? 'placeholder' : 'after_heading',
    };
  });

    const tables = findAll(documentRoot, 'w:tbl');
  const nestedTables = tables.filter((table) => findAll(table, 'w:tbl').length > 0).length;
  const images = findAll(documentRoot, 'w:drawing').length + findAll(documentRoot, 'w:pict').length;
  const contentControls = findAll(documentRoot, 'w:sdt').length;
  const sectionProps = findAll(documentRoot, 'w:sectPr');

  const pageSetupNode = sectionProps[0] ? findChild(sectionProps[0], 'w:pgSz') : undefined;
  const marginsNode = sectionProps[0] ? findChild(sectionProps[0], 'w:pgMar') : undefined;
  const width = pageSetupNode ? Number(pageSetupNode.attrs['w:w']) : NaN;
  const height = pageSetupNode ? Number(pageSetupNode.attrs['w:h']) : NaN;

  if (headings.length === 0) {
    warnings.push(
      'No headings were detected. FormaAI looked for Word heading styles, outline levels, chapter numbering and heading-like formatting (bold, larger or centred short paragraphs). Add headings to the document, or mark sections manually.',
    );
  } else if (formatHeadingCount > 0) {
    warnings.push(
      `${formatHeadingCount} of ${headings.length} sections were inferred from formatting and numbering rather than Word heading styles. Review the outline and remove any false positives before drafting.`,
    );
  }
  if (contentControls > 0) {
    warnings.push(
      `${contentControls} content control(s) (w:sdt) detected. Placeholders inside them are replaced, but the control wrappers themselves are preserved unchanged.`,
    );
  }

  let title: string | null = null;
  if (coreXml) {
    const match = /<dc:title>([^<]*)<\/dc:title>/.exec(coreXml);
    if (match?.[1]) title = match[1].trim();
  }

  return {
    detectedAt: new Date().toISOString(),
    title,
    headings,
    placeholders,
    paragraphCount: items.filter((i) => i.kind === 'paragraph').length,
    tableCount: tables.length,
    nestedTableCount: nestedTables,
    imagesCount: images,
    hasHeaders: false,
    hasFooters: false,
    headerTexts: [],
    footerTexts: [],
    pageSetup: sectionProps.length
      ? {
          widthTwips: Number.isFinite(width) ? width : null,
          heightTwips: Number.isFinite(height) ? height : null,
          orientation:
            pageSetupNode?.attrs['w:orient'] === 'landscape'
              ? 'landscape'
              : pageSetupNode
                ? 'portrait'
                : null,
          marginTopTwips: marginsNode ? Number(marginsNode.attrs['w:top']) : null,
          marginBottomTwips: marginsNode ? Number(marginsNode.attrs['w:bottom']) : null,
          marginLeftTwips: marginsNode ? Number(marginsNode.attrs['w:left']) : null,
          marginRightTwips: marginsNode ? Number(marginsNode.attrs['w:right']) : null,
          sectionCount: sectionProps.length,
        }
      : null,
    styleIds: Array.from(styles.keys()),
    sectionBreakCount: sectionProps.length,
    contentControlCount: contentControls,
    warnings,
  };
}

/** Extract visible text from a header/footer part. */
export function partText(xml: string): string {
  const [root] = parseXml(xml);
  if (!root) return '';
  return findAll(root, 'w:p')
    .map((p) => paragraphText(p).trim())
    .filter(Boolean)
    .join('\n');
}

export function textOfNode(node: XmlNode): string {
  return textOf(node);
}
