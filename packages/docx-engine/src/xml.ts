/**
 * Minimal, order-preserving XML model + parser/serializer built on fast-xml-parser.
 *
 * Why not use a DOM library: we must round-trip WordprocessingML with *zero*
 * loss of unknown elements, attribute order, or namespace prefixes. Converting
 * to a generic JS object and back is risky; instead we keep the original XML
 * string in every node and only re-serialise nodes we actually modify.
 */
import { XMLParser } from 'fast-xml-parser';

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Character data for text nodes (tag === '#text'). */
  text?: string;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

interface ParserNode {
  '#text'?: string;
  [key: string]: unknown;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: false,
  ignorePiTags: true,
});

/** Parse a WordprocessingML part into an ordered array of root nodes. */
export function parseXml(xml: string): XmlNode[] {
  const result = parser.parse(xml) as unknown as Array<Record<string, unknown>>;
  const nodes: XmlNode[] = [];
  for (const entry of result) {
    const node = convertEntry(entry);
    if (node) nodes.push(node);
  }
  return nodes;
}

function convertEntry(entry: Record<string, unknown>): XmlNode | null {
  if (entry['#text'] !== undefined) {
    return { tag: '#text', attrs: {}, children: [], text: String(entry['#text']) };
  }
  if (entry['?xml'] !== undefined) {
    return { tag: '?xml', attrs: (entry[':@'] as Record<string, string>) ?? {}, children: [] };
  }
  for (const key of Object.keys(entry)) {
    if (key === ':@') continue;
    const rawChildren = entry[key];
    const attrs = (entry[':@'] as Record<string, string> | undefined) ?? {};
    const children: XmlNode[] = [];
    if (Array.isArray(rawChildren)) {
      for (const child of rawChildren as Array<Record<string, unknown>>) {
        const converted = convertEntry(child);
        if (converted) children.push(converted);
      }
    }
    return { tag: key, attrs: { ...attrs }, children };
  }
  return null;
}

export function serializeXml(nodes: XmlNode[]): string {
  let out = '';
  for (const node of nodes) out += serializeNode(node);
  return out;
}

export function serializeNode(node: XmlNode): string {
  if (node.tag === '#text') return escapeXml(node.text ?? '');
  if (node.tag === '?xml') return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  if (node.tag.startsWith('!')) return '';
  let attrs = '';
  for (const [key, value] of Object.entries(node.attrs)) {
    attrs += ` ${key}="${escapeXml(value)}"`;
  }
  if (node.children.length === 0) return `<${node.tag}${attrs}/>`;
  let inner = '';
  for (const child of node.children) inner += serializeNode(child);
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

export function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

export function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((child) => child.tag === tag);
}

export function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    findAll(child, tag, out);
  }
  return out;
}

export function firstDescendant(node: XmlNode, tag: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = firstDescendant(child, tag);
    if (found) return found;
  }
  return undefined;
}

export function findAncestorPath(root: XmlNode, target: XmlNode): XmlNode[] | null {
  for (const child of root.children) {
    if (child === target) return [];
    const sub = findAncestorPath(child, target);
    if (sub) return [child, ...sub];
  }
  return null;
}

export function removeChild(parent: XmlNode, child: XmlNode): boolean {
  const index = parent.children.indexOf(child);
  if (index === -1) return false;
  parent.children.splice(index, 1);
  return true;
}

export function insertAfter(parent: XmlNode, anchor: XmlNode, newNodes: XmlNode[]): void {
  const index = parent.children.indexOf(anchor);
  if (index === -1) parent.children.push(...newNodes);
  else parent.children.splice(index + 1, 0, ...newNodes);
}

export function cloneNode<T extends XmlNode>(node: T): T {
  return structuredClone(node);
}

export function getAttr(node: XmlNode, name: string): string | undefined {
  return node.attrs[name];
}

export function setAttr(node: XmlNode, name: string, value: string): void {
  node.attrs[name] = value;
}

// ---------------------------------------------------------------------------
// WordprocessingML specific helpers
// ---------------------------------------------------------------------------

export function textOf(node: XmlNode): string {
  if (node.tag === '#text') return node.text ?? '';
  if (node.tag === 'w:t') {
    return node.children.map((c) => (c.tag === '#text' ? (c.text ?? '') : '')).join('');
  }
  if (node.tag === 'w:tab') return '\t';
  if (node.tag === 'w:br' || node.tag === 'w:cr') return '\n';
  if (node.tag === 'w:instrText' || node.tag === 'w:delText') return '';
  return node.children.map(textOf).join('');
}

export function paragraphText(paragraph: XmlNode): string {
  return findAll(paragraph, 'w:t')
    .map((t) => t.children.map((c) => (c.tag === '#text' ? (c.text ?? '') : '')).join(''))
    .join('');
}

export function paragraphStyleId(paragraph: XmlNode): string | null {
  const pPr = findChild(paragraph, 'w:pPr');
  if (!pPr) return null;
  const style = findChild(pPr, 'w:pStyle');
  return style ? (style.attrs['w:val'] ?? null) : null;
}

export function paragraphOutlineLevel(paragraph: XmlNode): number | null {
  const pPr = findChild(paragraph, 'w:pPr');
  if (!pPr) return null;
  const outline = findChild(pPr, 'w:outlineLvl');
  if (!outline) return null;
  const val = Number(outline.attrs['w:val']);
  return Number.isFinite(val) ? val : null;
}

/** Paragraph alignment as Word writes it (`left`, `center`, `right`, `both`). */
export function paragraphAlignment(paragraph: XmlNode): string | null {
  const pPr = findChild(paragraph, 'w:pPr');
  if (!pPr) return null;
  const jc = findChild(pPr, 'w:jc');
  return jc?.attrs['w:val'] ?? null;
}

/** Nesting level of a numbered/bulleted paragraph, or null when it is not a list item. */
export function paragraphNumberingLevel(paragraph: XmlNode): number | null {
  const pPr = findChild(paragraph, 'w:pPr');
  const numPr = pPr ? findChild(pPr, 'w:numPr') : undefined;
  if (!numPr) return null;
  const ilvl = findChild(numPr, 'w:ilvl');
  const level = ilvl ? Number(ilvl.attrs['w:val']) : 0;
  return Number.isFinite(level) ? level : 0;
}

/** True when `w:b` is present and not explicitly turned off. */
export function runBold(run: XmlNode): boolean | null {
  const rPr = findChild(run, 'w:rPr');
  if (!rPr) return null;
  const bold = findChild(rPr, 'w:b');
  if (!bold) return null;
  const value = bold.attrs['w:val'];
  return !(value === '0' || value === 'false' || value === 'off');
}

/** Font size of a run's direct formatting, in half-points (Word's unit). */
export function runSizeHalfPoints(run: XmlNode): number | null {
  const rPr = findChild(run, 'w:rPr');
  if (!rPr) return null;
  const size = findChild(rPr, 'w:sz');
  if (!size) return null;
  const value = Number(size.attrs['w:val']);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isParagraph(node: XmlNode): boolean {
  return node.tag === 'w:p';
}

/**
 * Builds a real Word table (`<w:tbl>`) from generated cells.
 *
 * Written as XML nodes rather than a hand-made string so the existing
 * serializer handles escaping. Borders are explicit because a table without
 * `<w:tblBorders>` renders borderless, which reads as broken in a printed report.
 */
export function createTable(
  table: { columns: string[]; rows: string[][]; caption?: string | null },
  options: { runProps?: XmlNode | null } = {},
): XmlNode[] {
  const nodes: XmlNode[] = [];

  if (table.caption && table.caption.trim()) {
    nodes.push({
      tag: 'w:p',
      attrs: {},
      children: [{ tag: 'w:r', attrs: {}, children: [{ tag: 'w:t', attrs: {}, children: [{ tag: '#text', attrs: {}, children: [], text: table.caption.trim() }] }] }],
    });
  }

  const borders = {
    tag: 'w:tblBorders',
    attrs: {},
    children: ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => ({
      tag: `w:${side}`,
      attrs: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': '000000' },
      children: [],
    })),
  };

  const makeRow = (cells: string[], header: boolean): XmlNode => ({
    tag: 'w:tr',
    attrs: {},
    children: cells.map((cell) => ({
      tag: 'w:tc',
      attrs: {},
      children: [
        {
          tag: 'w:tcPr',
          attrs: {},
          children: header ? [{ tag: 'w:shd', attrs: { 'w:val': 'clear', 'w:fill': 'E8EDF2' }, children: [] }] : [],
        },
        createParagraph(cell, {
          runProps: header ? { tag: 'w:rPr', attrs: {}, children: [{ tag: 'w:b', attrs: {}, children: [] }] } : options.runProps ?? null,
        }),
      ],
    })),
  });

  const columnCount = Math.max(1, table.columns.length);
  nodes.push({
    tag: 'w:tbl',
    attrs: {},
    children: [
      {
        tag: 'w:tblPr',
        attrs: {},
        children: [
          { tag: 'w:tblW', attrs: { 'w:w': '5000', 'w:type': 'pct' }, children: [] },
          borders,
        ],
      },
      {
        tag: 'w:tblGrid',
        attrs: {},
        children: table.columns.map(() => ({ tag: 'w:gridCol', attrs: {}, children: [] })),
      },
      makeRow(table.columns, true),
      // Normalise every row to the header width: a short row makes Word drop
      // cells and shift the following ones, which looked like data corruption.
      ...table.rows.map((row) => {
        const cells = row.slice(0, columnCount);
        while (cells.length < columnCount) cells.push('');
        return makeRow(cells, false);
      }),
    ],
  });

  // An empty paragraph after the table keeps it from merging with the next
  // section's heading when Word continues the document.
  nodes.push({ tag: 'w:p', attrs: {}, children: [] });
  return nodes;
}

/** Reads pixel dimensions from a PNG, JPEG or GIF header. */
export function imagePixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR at offset 16 (width) and 20 (height).
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: "GIF8", logical screen descriptor at 6 (little-endian 16-bit).
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  // JPEG: walk the segments until a start-of-frame marker.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        return { width, height };
      }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

export function directParagraphs(container: XmlNode): XmlNode[] {
  return container.children.filter((c) => c.tag === 'w:p');
}

/**
 * Builds a centred, inline image paragraph for an already-registered media part.
 *
 * `relId` must exist in `word/_rels/document.xml.rels` and `partName` in
 * `[Content_Types].xml`, otherwise Word reports the file as corrupt — so the
 * caller is responsible for both, and this function only writes the drawing XML.
 * Dimensions are computed from the pixel size at 96 DPI and capped to the
 * printable width so a large screenshot does not overflow the margin.
 */
export function createImageParagraph(options: {
  relId: string;
  documentPrId: number;
  name: string;
  widthPx: number;
  heightPx: number;
  maxWidthEmu?: number;
}): XmlNode {
  const EMU_PER_PX = 9525; // 96 DPI
  const requested = Math.max(1, options.widthPx) * EMU_PER_PX;
  const maxWidth = options.maxWidthEmu ?? 5_486_400; // ~6 inches, A4 minus margins
  const scale = requested > maxWidth ? maxWidth / requested : 1;
  const cx = Math.round(requested * scale);
  const cy = Math.round(Math.max(1, options.heightPx) * EMU_PER_PX * scale);
  const safeName = options.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const id = options.documentPrId;

  const inlineXml =
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${safeName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${options.relId}"/></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"/></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

  const [paragraph] = parseXml(inlineXml);
  if (!paragraph) throw new Error('Unable to build image paragraph');
  return paragraph;
}

export function createTextRun(text: string, runProps?: XmlNode | null): XmlNode {
  const run: XmlNode = { tag: 'w:r', attrs: {}, children: [] };
  if (runProps) run.children.push(cloneNode(runProps));
  const parts = text.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) run.children.push({ tag: 'w:br', attrs: {}, children: [] });
    if (part.length === 0) return;
    run.children.push({
      tag: 'w:t',
      attrs: part !== part.trim() ? { 'xml:space': 'preserve' } : {},
      children: [{ tag: '#text', attrs: {}, children: [], text: part }],
    });
  });
  if (run.children.length === (runProps ? 1 : 0)) {
    run.children.push({
      tag: 'w:t',
      attrs: { 'xml:space': 'preserve' },
      children: [{ tag: '#text', attrs: {}, children: [], text: '' }],
    });
  }
  return run;
}

export function createParagraph(text: string, options: { paragraphProps?: XmlNode | null; runProps?: XmlNode | null } = {}): XmlNode {
  const paragraph: XmlNode = { tag: 'w:p', attrs: {}, children: [] };
  if (options.paragraphProps) paragraph.children.push(cloneNode(options.paragraphProps));
  const lines = text.split('\n');
  if (lines.length === 1) {
    paragraph.children.push(createTextRun(text, options.runProps ?? null));
  } else {
    lines.forEach((line, index) => {
      if (index > 0) {
        const brRun: XmlNode = { tag: 'w:r', attrs: {}, children: [] };
        if (options.runProps) brRun.children.push(cloneNode(options.runProps));
        brRun.children.push({ tag: 'w:br', attrs: {}, children: [] });
        paragraph.children.push(brRun);
      }
      paragraph.children.push(createTextRun(line, options.runProps ?? null));
    });
  }
  return paragraph;
}
