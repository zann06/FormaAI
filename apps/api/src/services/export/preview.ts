/**
 * Page preview rendering.
 *
 * The workspace could only show the report as plain text in a textarea, so a user
 * had no way to see what the exported file would actually look like — cover page,
 * logo, tables, spacing. This renders real page images from the same DOCX that
 * export produces, so what you see in the Preview tab is the document, not an
 * approximation of it.
 *
 * Rendering happens server-side with LibreOffice (DOCX -> PDF) plus pdf.js and
 * canvas (PDF -> PNG). Nothing new is installed: both are already used for PDF
 * export and OCR normalisation.
 */
import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import { convertDocxToPdf, isPdfConverterConfigured } from './pdf.js';

export interface RenderedPage {
  /** 1-based page number, matching the exported document. */
  page: number;
  /** PNG bytes. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface PagePreview {
  pages: RenderedPage[];
  pageCount: number;
  /** Width in CSS pixels the page should be displayed at. */
  displayWidth: number;
  displayHeight: number;
  renderedAt: string;
}

/** A preview plus the true page count of the document (which may exceed `pageCount`). */
export type CachedPreview = PagePreview & { totalPages: number };

export type PreviewErrorCode =
  | 'PREVIEW_CONVERTER_MISSING'
  | 'PREVIEW_RENDER_FAILED'
  | 'PREVIEW_TOO_LARGE';

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

export interface RenderOptions {
  /** Cap on pages rendered; the UI offers "first N pages" beyond this. */
  maxPages?: number;
  /** Rendered page width in pixels. 1240 ≈ 150 DPI for an A4 page. */
  pageWidth?: number;
  /**
   * Where to cache rendered pages. Keyed by a content hash of the DOCX, so any
   * edit (or a different template) misses the cache and the user never sees a
   * stale page.
   */
  cache?: {
    get: (key: string) => Promise<CachedPreview | null>;
    set: (key: string, preview: CachedPreview) => Promise<void>;
  };
  /** Stable identity of the document being rendered, used as the cache key. */
  cacheKey?: string;
}

export const PREVIEW_LIMITS = {
  maxPages: 12,
  pageWidth: 1240,
} as const;

export function isPreviewAvailable(config: Pick<AppConfig, 'LIBREOFFICE_BIN' | 'CONVERTER_URL'>): boolean {
  return isPdfConverterConfigured(config);
}

/**
 * Renders the first pages of a DOCX into PNGs.
 *
 * A cover page plus body pages is what a user needs to judge the result; rendering
 * a 60-page report would take many seconds and produce megabytes of images, so the
 * caller gets the first `maxPages` and the total via `totalPages`.
 */
export async function renderDocxPreview(
  docx: Uint8Array,
  config: Pick<AppConfig, 'LIBREOFFICE_BIN' | 'CONVERTER_URL' | 'CONVERTER_TOKEN' | 'PDF_CONVERSION_TIMEOUT_MS'>,
  options: RenderOptions = {},
): Promise<PagePreview & { totalPages: number }> {
  const maxPages = options.maxPages ?? PREVIEW_LIMITS.maxPages;
  const pageWidth = options.pageWidth ?? PREVIEW_LIMITS.pageWidth;

  if (!isPreviewAvailable(config)) {
    throw new PreviewError(
      'PREVIEW_CONVERTER_MISSING',
      'Page preview needs LibreOffice (or a converter URL) on the server. The report text below is still accurate.',
    );
  }

  if (options.cache && options.cacheKey) {
    const cached = await options.cache.get(options.cacheKey).catch(() => null);
    if (cached) return { ...cached, totalPages: cached.pageCount };
  }

  let pdf: Uint8Array;
  try {
    pdf = (await convertDocxToPdf(docx, config)).bytes;
  } catch (error) {
    throw new PreviewError(
      'PREVIEW_RENDER_FAILED',
      `The document could not be converted for preview: ${(error as Error).message}`,
    );
  }

  let preview: PagePreview & { totalPages: number };
  try {
    preview = await rasterisePdf(pdf, { maxPages, pageWidth });
  } catch (error) {
    throw new PreviewError(
      'PREVIEW_RENDER_FAILED',
      `The preview pages could not be drawn: ${(error as Error).message}`,
    );
  }

  if (options.cache && options.cacheKey) {
    await options.cache.set(options.cacheKey, preview).catch(() => undefined);
  }
  return preview;
}

/**
 * Draws PDF pages to PNG with pdf.js.
 *
 * pdf.js needs a canvas implementation; `@napi-rs/canvas` is the one already used
 * to normalise images for OCR, so no extra native dependency is introduced.
 */
async function rasterisePdf(
  pdf: Uint8Array,
  options: { maxPages: number; pageWidth: number },
): Promise<PagePreview & { totalPages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');

  // Font handling options are browser-only and actively harmful here. Telling
  // pdf.js to draw text through CSS @font-face, or to fall back to platform
  // fonts, does not work under Node: there is no font stack, so every glyph
  // became a "notdef" box (□) even though the PDF had its fonts embedded.
  // Leaving those options unset makes pdf.js render the embedded fonts through
  // the canvas — which is what produces real, readable text.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
  }).promise;

  const pageCount = doc.numPages;
  const pagesToRender = Math.min(pageCount, options.maxPages);
  const pages: RenderedPage[] = [];
  let displayWidth = 0;
  let displayHeight = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      // Scale so the page is `pageWidth` px wide; height follows the aspect ratio
      // so A4 and Letter both render correctly.
      const scale = options.pageWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      // A white ground matters: PNG is transparent by default and a page rendered
      // onto transparency reads as black-on-dark in some browsers.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      pages.push({
        page: pageNumber,
        bytes: new Uint8Array(await canvas.encode('png')),
        width: canvas.width,
        height: canvas.height,
      });
      displayWidth = canvas.width;
      displayHeight = canvas.height;
    }
  } finally {
    await doc.destroy();
  }

  return {
    pages,
    pageCount: pages.length,
    totalPages: pageCount,
    displayWidth,
    displayHeight,
    renderedAt: new Date().toISOString(),
  };
}
