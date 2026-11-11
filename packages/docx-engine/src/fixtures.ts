/**
 * Minimal deterministic DOCX writer used to generate test fixtures.
 *
 * This is NOT used by the application at runtime — only by tests and the
 * fixture generator. It produces genuinely Word-compatible .docx packages with
 * styles, numbering, headers/footers, tables (incl. nested), images and section
 * breaks so the engine can be tested against representative structures.
 */
import { zipSync, type Zippable } from 'fflate';
import { escapeXml } from './xml.js';

export interface FixtureParagraph {
  text: string;
  styleId?: string;
  bold?: boolean;
  italic?: boolean;
  /** Placeholder tokens are written as separate runs to emulate Word's run splitting. */
  splitRuns?: boolean;
  pageBreakBefore?: boolean;
  outlineLevel?: number;
}

export interface FixtureTable {
  rows: string[][];
  /** Index of row that contains a nested table instead of a cell text. */
  nested?: FixtureTable;
}

export interface FixtureOptions {
  title?: string;
  body: Array<FixtureParagraph | { table: FixtureTable } | { pageBreak: true } | { sectionBreak: true }>;
  headerText?: string;
  footerText?: string;
  images?: number;
  customStyles?: Array<{ id: string; name: string; outlineLevel?: number; size?: number; bold?: boolean }>;
}

const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

function pPr(p: FixtureParagraph): string {
  const parts: string[] = [];
  if (p.styleId) parts.push(`<w:pStyle w:val="${p.styleId}"/>`);
  if (p.pageBreakBefore) parts.push('<w:pageBreakBefore/>');
  if (p.outlineLevel !== undefined) parts.push(`<w:outlineLvl w:val="${p.outlineLevel}"/>`);
  return parts.length ? `<w:pPr>${parts.join('')}</w:pPr>` : '';
}

function rPr(p: FixtureParagraph): string {
  const parts: string[] = [];
  if (p.bold) parts.push('<w:b/>');
  if (p.italic) parts.push('<w:i/>');
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function paragraph(p: FixtureParagraph): string {
  if (p.splitRuns && p.text.includes('{{')) {
    // split the placeholder across two runs, like Word often does
    const index = p.text.indexOf('{{') + 3;
    const first = p.text.slice(0, index);
    const second = p.text.slice(index);
    return `<w:p>${pPr(p)}<w:r>${rPr(p)}<w:t xml:space="preserve">${escapeXml(first)}</w:t></w:r><w:r>${rPr(p)}<w:t xml:space="preserve">${escapeXml(second)}</w:t></w:r></w:p>`;
  }
  return `<w:p>${pPr(p)}<w:r>${rPr(p)}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`;
}

function table(t: FixtureTable): string {
  const rows = t.rows
    .map((cells) => {
      const cellXml = cells
        .map((cell) => {
          if (cell === '__NESTED__' && t.nested) {
            return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${table(t.nested)}</w:tc>`;
          }
          return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
        })
        .join('');
      return `<w:tr>${cellXml}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
}

function imageRun(index: number, relId: string): string {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="990000" cy="990000"/><wp:docPr id="${index}" name="Picture ${index}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="990000" cy="990000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function buildFixtureDocx(options: FixtureOptions): Uint8Array {
  const bodyXml: string[] = [];
  for (const item of options.body) {
    if ('table' in item) bodyXml.push(table(item.table));
    else if ('pageBreak' in item) bodyXml.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if ('sectionBreak' in item)
      bodyXml.push(
        '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:pPr></w:p>',
      );
    else bodyXml.push(paragraph(item));
  }
  const imageCount = options.images ?? 0;
  const imageXml: string[] = [];
  const imageRels: string[] = [];
  const media: Record<string, Uint8Array> = {};
  for (let i = 0; i < imageCount; i += 1) {
    const relId = `rIdImg${i + 1}`;
    imageXml.push(imageRun(i + 1, relId));
    imageRels.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`,
    );
    media[`word/media/image${i + 1}.png`] = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'));
  }
  bodyXml.push(...imageXml);

  const hasHeader = !!options.headerText;
  const hasFooter = !!options.footerText;
  const headerRef = hasHeader ? '<w:headerReference w:type="default" r:id="rIdHdr1"/>' : '';
  const footerRef = hasFooter ? '<w:footerReference w:type="default" r:id="rIdFtr1"/>' : '';

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${bodyXml.join('')}<w:sectPr>${headerRef}${footerRef}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const customStyles = (options.customStyles ?? [])
    .map(
      (s) =>
        `<w:style w:type="paragraph" w:styleId="${s.id}"><w:name w:val="${escapeXml(s.name)}"/><w:basedOn w:val="Normal"/><w:pPr>${s.outlineLevel !== undefined ? `<w:outlineLvl w:val="${s.outlineLevel}"/>` : ''}</w:pPr><w:rPr>${s.bold ? '<w:b/>' : ''}${s.size ? `<w:sz w:val="${s.size}"/>` : ''}</w:rPr></w:style>`,
    )
    .join('');

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>${customStyles}</w:styles>`;

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  const relationships = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`,
    ...imageRels,
    ...(hasHeader
      ? [`<Relationship Id="rIdHdr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`]
      : []),
    ...(hasFooter
      ? [`<Relationship Id="rIdFtr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`]
      : []),
  ].join('');

  const files: Zippable = {
    '[Content_Types].xml': str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}${hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}</Types>`),
    '_rels/.rels': str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'word/document.xml': str(documentXml),
    'word/_rels/document.xml.rels': str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`),
    'word/styles.xml': str(stylesXml),
    'word/numbering.xml': str(numberingXml),
    'docProps/core.xml': str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(options.title ?? '')}</dc:title><dc:creator>FormaAI fixtures</dc:creator></cp:coreProperties>`),
    ...media,
  };
  if (hasHeader) {
    files['word/header1.xml'] = str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}><w:p><w:r><w:t xml:space="preserve">${escapeXml(options.headerText!)}</w:t></w:r></w:p></w:hdr>`);
  }
  if (hasFooter) {
    files['word/footer1.xml'] = str(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${NS}><w:p><w:r><w:t xml:space="preserve">${escapeXml(options.footerText!)}</w:t></w:r></w:p></w:ftr>`);
  }
  return zipSync(files, { level: 6 });
}

function str(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** A simple text-only PDF writer (no images) for source-extraction fixtures. */
export function buildFixturePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageObjects: string[] = [];
  const contentObjects: string[] = [];
  // 1: Catalog, 2: Pages, then per page: page object + content stream
  const kids: string[] = [];
  pages.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const lines = text.split('\n');
    const stream = `BT /F1 12 Tf 14 TL 50 780 Td ${lines
      .map((line) => `(${line.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`)
      .join(' ')} ET`;
    pageObjects.push(
      `${pageId} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contentId} 0 R >>endobj`,
    );
    contentObjects.push(`${contentId} 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream endobj`);
  });
  objects.push(`1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj`);
  objects.push(`2 0 obj<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>endobj`);
  objects.push(...pageObjects, ...contentObjects);
  objects.push(`5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
