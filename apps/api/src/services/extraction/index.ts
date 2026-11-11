/**
 * Source extraction adapters.
 *
 * Every adapter returns structured `ExtractedUnit[]` with provenance
 * (page / paragraph index / heading path). Adapters never throw for
 * "no text found" — they report it so the caller can mark the document as
 * failed instead of pretending extraction succeeded.
 */
import { analyzeDocumentXml, bodyItems, findChild, paragraphText, parseXml } from '@formaai/docx-engine';
import type { XmlNode } from '@formaai/docx-engine';

export interface ExtractedUnit {
  text: string;
  page: number | null;
  paragraphIndex: number | null;
  headingPath: string | null;
  sheet?: string | null;
  slide?: number | null;
}

export interface ExtractionResult {
  units: ExtractedUnit[];
  pageCount: number | null;
  method: 'pdf-text' | 'pdf-ocr' | 'docx' | 'txt' | 'ocr-http';
  warnings: string[];
  needsOcr: boolean;
}

export interface ExtractionLimits {
  maxPdfPages: number;
  ocrEnabled: boolean;
}

const MIN_USEFUL_CHARS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractionLimits,
): Promise<ExtractionResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const warnings: string[] = [];
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Extraction only needs glyph positions; bundled standard font data is not
    // required and its absence otherwise prints noisy warnings per document.
    verbosity: 0,
  }).promise;

  const pageCount = doc.numPages;
  if (pageCount > limits.maxPdfPages) {
    throw new Error(
      `The PDF has ${pageCount} pages which exceeds the limit of ${limits.maxPdfPages}. Split the file and upload the relevant parts.`,
    );
  }
  const units: ExtractedUnit[] = [];
  let totalChars = 0;
  let pagesWithoutText = 0;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    let lastY: number | null = null;
    for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) pageText += '\n';
      else if (pageText && !pageText.endsWith(' ')) pageText += ' ';
      pageText += item.str;
      lastY = y;
    }
    const cleaned = pageText.replace(/[ \t]+/g, ' ').trim();
    if (cleaned.length < MIN_USEFUL_CHARS_PER_PAGE) {
      pagesWithoutText += 1;
      if (limits.ocrEnabled) {
        const ocrText = await ocrPdfPage(page, pageNumber);
        if (ocrText) {
          units.push({ text: ocrText, page: pageNumber, paragraphIndex: null, headingPath: null });
          totalChars += ocrText.length;
          continue;
        }
      }
      if (cleaned.length > 0) units.push({ text: cleaned, page: pageNumber, paragraphIndex: null, headingPath: null });
      continue;
    }
    units.push({ text: cleaned, page: pageNumber, paragraphIndex: null, headingPath: null });
    totalChars += cleaned.length;
  }
  await doc.destroy();

  const needsOcr = pagesWithoutText > 0;
  if (needsOcr && !limits.ocrEnabled) {
    warnings.push(
      `${pagesWithoutText} of ${pageCount} page(s) contain no extractable text. This looks like a scanned PDF; configure OCR (TESSERACT_BIN or OCR_ENDPOINT) to read those pages.`,
    );
  }
  return {
    units,
    pageCount,
    method: limits.ocrEnabled && needsOcr ? 'pdf-ocr' : 'pdf-text',
    warnings,
    needsOcr,
  };
}

async function ocrPdfPage(page: unknown, pageNumber: number): Promise<string | null> {
  try {
    const { renderPageToPng, runOcr } = await import('./ocr.js');
    const png = await renderPageToPng(page as never);
    if (!png) return null;
    const text = await runOcr(png, `page-${pageNumber}`);
    return text && text.trim().length > 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

export async function extractDocx(bytes: Uint8Array, maxChars = 2_000_000): Promise<ExtractionResult> {
  const { readDocxPackage, xmlToString } = await import('@formaai/docx-engine');
  const pkg = readDocxPackage(bytes);
  const documentXml = xmlToString(pkg.files['word/document.xml']!);
  const stylesXml = pkg.files['word/styles.xml'] ? xmlToString(pkg.files['word/styles.xml']!) : null;
  const analysis = analyzeDocumentXml(documentXml, stylesXml, null);

  const [root] = parseXml(documentXml);
  const units: ExtractedUnit[] = [];
  const warnings: string[] = [];
  if (!root) throw new Error('Unable to parse the DOCX document part');

  const headingByParagraph = new Map<number, string>();
  for (const heading of analysis.headings) {
    anchorHeadingText.set(heading.paragraphIndex, heading.text);
  }

  const items = bodyItems(root);
  let currentHeading: string | null = null;
  let charBudget = maxChars;
  items.forEach((item, index) => {
    const anchor = anchorHeadingText.get(index);
    if (anchor) currentHeading = anchor;
    if (charBudget <= 0) return;
    if (item.kind === 'paragraph') {
      const text = paragraphText(item.node).trim();
      if (!text) return;
      units.push({
        text: text.slice(0, charBudget),
        page: null,
        paragraphIndex: index,
        headingPath: currentHeading,
      });
      charBudget -= text.length;
    } else {
      const rows = extractTableRows(item.node);
      for (const [rowIndex, row] of rows.entries()) {
        const text = row.join(' | ').trim();
        if (!text) continue;
        units.push({
          text: text.slice(0, charBudget),
          page: null,
          paragraphIndex: index,
          headingPath: currentHeading ? `${currentHeading} (table ${rowIndex + 1})` : `table row ${rowIndex + 1}`,
        });
        charBudget -= text.length;
      }
    }
  });
  anchorHeadingText.clear();

  if (charBudget <= 0) warnings.push('The document is very large; extraction was truncated to the configured limit.');

  return {
    units,
    pageCount: null,
    method: 'docx',
    warnings,
    needsOcr: false,
  };
}

// Per-call heading map (avoids a module-global that would leak between requests).
const anchorHeadingText = new Map<number, string>();

function extractTableRows(tableNode: XmlNode): string[][] {
  const rows = tableNode.children.filter((c) => c.tag === 'w:tr');
  return rows.map((row) =>
    row.children
      .filter((cell) => cell.tag === 'w:tc')
      .map((cell) =>
        findChild(cell, 'w:p')
          ? cell.children
              .filter((child) => child.tag === 'w:p')
              .map((p) => paragraphText(p).trim())
              .filter(Boolean)
              .join(' ')
          : '',
      ),
  );
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

export function extractTxt(bytes: Uint8Array, maxChars = 2_000_000): ExtractionResult {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const text = decoder.decode(bytes.subarray(0, Math.min(bytes.length, maxChars * 4)));
  const warnings: string[] = [];
  if (text.includes('\uFFFD')) warnings.push('Some characters could not be decoded as UTF-8 and were replaced.');
  const paragraphs = text.split(/\r?\n\s*\r?\n/);
  const units: ExtractedUnit[] = [];
  let offset = 0;
  let budget = maxChars;
  paragraphs.forEach((paragraph, index) => {
    const trimmed = paragraph.trim();
    const startOffset = text.indexOf(paragraph, offset);
    offset = startOffset + paragraph.length;
    if (trimmed && budget > 0) {
      units.push({
        text: trimmed.slice(0, budget),
        page: null,
        paragraphIndex: index,
        headingPath: null,
      });
      budget -= trimmed.length;
    }
  });
  if (budget <= 0) warnings.push('The text file is very large; extraction was truncated.');
  return { units, pageCount: null, method: 'txt', warnings, needsOcr: false };
}
