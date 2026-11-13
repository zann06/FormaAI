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
import { createHash } from 'node:crypto';
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
  /** 1-based number of the first page in `pages`; >1 for a windowed render. */
  firstPage?: number;
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
   * Render only this 1-based, inclusive page window.
   *
   * The whole preview takes ~20 s (LibreOffice ~8 s, then rasterising ~0.3 s per
   * page). Rendering the first window alone gets a readable page on screen in a
   * fraction of that time, and the workspace asks for the remaining pages in the
   * background. `from` is clamped into the document.
   */
  fromPage?: number;
  toPage?: number;
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
  /**
   * How many pages are rasterised per preview request.
   *
   * This was 12, which is shorter than a real assignment: a 46-page report showed
   * only its cover and front matter, so the user could not check the chapters they
   * actually needed to review. Rendering is ~0.1 s per page, so 40 covers the bulk
   * of a typical report while keeping the JSON payload in the low megabytes. The
   * response is a data URL per page, so this cannot be unbounded.
   */
  maxPages: 40,
  pageWidth: 1240,
} as const;

export function isPreviewAvailable(config: Pick<AppConfig, 'LIBREOFFICE_BIN' | 'CONVERTER_URL'>): boolean {
  return isPdfConverterConfigured(config);
}

/**
 * Converted PDFs, keyed by the SHA-256 of the DOCX they came from.
 *
 * Only the *conversion* is cached, never the rendered pages: a PDF keyed on the
 * exact document bytes cannot be stale, so this is safe where an input-keyed page
 * cache was not. Two entries is enough — the first batch and the follow-up batch of
 * the same document — and it keeps a little memory free for the second report a
 * user opens without opening in the same minute.
 */
const pdfCache = new Map<string, Uint8Array>();
const PDF_CACHE_LIMIT = 2;

function rememberPdf(key: string, pdf: Uint8Array) {
  if (pdfCache.size >= PDF_CACHE_LIMIT) {
    // Insertion order: drop the oldest conversion first.
    const oldest = pdfCache.keys().next().value;
    if (oldest) pdfCache.delete(oldest);
  }
  pdfCache.set(key, pdf);
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
    // `totalPages` is the real document length and must survive the cache. Storing
    // only `pageCount` made every cached preview claim the document was exactly
    // `maxPages` long, so a 46-page report showed "12 of 12 pages".
    if (cached) return { ...cached, totalPages: cached.totalPages ?? cached.pageCount };
  }

  let pdf: Uint8Array;
  const convertStarted = Date.now();
  // Cache the *converted PDF*, keyed on the document bytes.
  //
  // The preview is fetched in two batches (pages 1–6, then the rest) so a page
  // appears before the whole 45-page document is drawn. Each request used to run
  // LibreOffice from scratch: profiling showed 12–17 s of conversion per batch, so
  // the user waited twice for the same work while rasterising 6 pages took only
  // 2.8 s. Keying on a hash of the DOCX means an edited document can never be
  // served a stale PDF, which is the failure mode a time-based cache would have.
  const cacheKey = createHash('sha256').update(docx).digest('hex');
  const cachedPdf = pdfCache.get(cacheKey);
  if (cachedPdf) {
    pdf = cachedPdf;
  } else {
    try {
      pdf = (await convertDocxToPdf(docx, config)).bytes;
    } catch (error) {
      throw new PreviewError(
        'PREVIEW_RENDER_FAILED',
        `The document could not be converted for preview: ${(error as Error).message}`,
      );
    }
    rememberPdf(cacheKey, pdf);
  }
  const convertMs = Date.now() - convertStarted;
  if (cachedPdf) console.info(`[preview] docx->pdf served from cache (${convertMs}ms)`);

  let preview: PagePreview & { totalPages: number };
  const rasterStarted = Date.now();
  try {
    preview = await rasterisePdf(pdf, {
      maxPages,
      pageWidth,
      fromPage: options.fromPage,
      toPage: options.toPage,
    });
  } catch (error) {
    throw new PreviewError(
      'PREVIEW_RENDER_FAILED',
      `The preview pages could not be drawn: ${(error as Error).message}`,
    );
  }
  const rasterMs = Date.now() - rasterStarted;
  // Preview is the slowest route in the app; without this split, "the preview is
  // slow" is unactionable because either LibreOffice or the raster loop could be
  // the cause and they need opposite fixes.
  console.info(
    `[preview] docx->pdf ${convertMs}ms, raster ${preview.pageCount} pages ${rasterMs}ms, total ${convertMs + rasterMs}ms`,
  );

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
  options: { maxPages: number; pageWidth: number; fromPage?: number; toPage?: number },
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
  // A windowed request ("pages 13–45") must still report the true document
  // length, otherwise the UI would think a 45-page report ends at page 40.
  const lowerBound = Math.max(1, options.fromPage ?? 1);
  const upperBound = Math.min(pageCount, options.toPage ?? pageCount, options.maxPages);
  const pages: RenderedPage[] = [];
  let displayWidth = 0;
  let displayHeight = 0;

  try {
    for (let pageNumber = lowerBound; pageNumber <= upperBound; pageNumber += 1) {
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
    firstPage: pages[0]?.page ?? 1,
  };
}
