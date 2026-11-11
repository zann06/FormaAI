import { findAll, findChild, parseXml, paragraphStyleId, paragraphText, textOf, type XmlNode } from './xml.js';
import type { TemplateHeading, TemplateStructure } from '@formaai/shared';

export interface AnalyzeOptions {
  /** Treat this styleId (or "Heading N"-like names) as headings when no outline level exists. */
  headingStyleIds?: string[];
}

const HEADING_NAME_RE = /^(heading|judul|titre|überschrift|título)\s*([1-9])$/i;

export interface StyleInfo {
  id: string;
  name: string;
  type: string;
  basedOn: string | null;
  outlineLevel: number | null;
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
    map.set(id, {
      id,
      name: nameNode?.attrs['w:val'] ?? id,
      type: style.attrs['w:type'] ?? 'paragraph',
      basedOn: basedOn?.attrs['w:val'] ?? null,
      outlineLevel: outline ? Number(outline.attrs['w:val']) : null,
    });
  }
  return map;
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
    if (/^(title|subtitle)$/i.test(info.name)) return info.name.toLowerCase() === 'title' ? 0 : 1;
    current = info.basedOn;
  }
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
  const items = bodyItems(documentRoot);
  const explicitHeadingStyles = new Set(options.headingStyleIds ?? []);

  interface RawHeading {
    text: string;
    level: number;
    styleId: string | null;
    itemIndex: number;
    pageBreakBefore: boolean;
  }

  const rawHeadings: RawHeading[] = [];
  items.forEach((item, itemIndex) => {
    if (item.kind !== 'paragraph') return;
    const text = paragraphText(item.node).trim();
    if (!text) return;
    const styleId = paragraphStyleId(item.node);
    let level: number | null = null;
    if (styleId && explicitHeadingStyles.has(styleId)) {
      level = 0;
    }
    if (level == null) level = resolveOutlineLevel(styleId, styles);
    if (level == null) {
      const outline = findChild(findChild(item.node, 'w:pPr') ?? { tag: '', attrs: {}, children: [] }, 'w:outlineLvl');
      if (outline) level = Number(outline.attrs['w:val']);
    }
    if (level == null) return;
    if (level > 8) return;
    const pPr = findChild(item.node, 'w:pPr');
    const pageBreakBefore = !!(pPr && findChild(pPr, 'w:pageBreakBefore'));
    rawHeadings.push({ text, level, styleId, itemIndex, pageBreakBefore });
  });

  const placeholders = extractPlaceholders(documentXml.replace(/<[^>]+>/g, ''));
  const placeholderKeysLower = placeholders.map((p) => p.toLowerCase());

  const headings: TemplateHeading[] = rawHeadings.map((heading, order) => {
    const next = rawHeadings[order + 1];
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
      level: heading.level + 1,
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
      'No heading styles were detected. The template may use manual bold paragraphs; you can mark paragraphs as sections manually.',
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
