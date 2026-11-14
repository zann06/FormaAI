import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Select } from './Select';

/**
 * The Preview tab: real page images of the report as it will be exported.
 *
 * The editor only ever showed a textarea, so there was no way to tell whether the
 * cover page, logos, tables and page breaks came out right until a file had been
 * downloaded and opened in Word. This renders the assembled DOCX server-side
 * (LibreOffice -> PDF -> PNG) so the preview is the document itself.
 *
 * Rendering takes a few seconds the first time (LibreOffice has to lay the
 * document out), so the result is cached per content version on the server and a
 * clear "rendering" state is shown instead of an empty box.
 */

export interface PreviewPage {
  page: number;
  width: number;
  height: number;
  image: string;
}

export interface PreviewResponse {
  pages: PreviewPage[];
  pageCount: number;
  totalPages: number;
  truncated: boolean;
  renderedAt: string;
  /** 1-based number of the first page in `pages`; >1 for a windowed render. */
  firstPage?: number;
}

/**
 * How many pages are fetched in the first request.
 *
 * Rendering the whole document took ~20 s (LibreOffice conversion plus ~0.3 s per
 * page), so the user stared at "Rendering pages…" before seeing anything. Pages
 * 1–6 include the cover and the start of chapter one, which is what you look at
 * first, and they arrive in roughly half the time. The remaining pages are
 * fetched immediately afterwards and appended, so the list fills in while the
 * first page is already readable.
 */
const FIRST_BATCH = 6;

export function PreviewPane({
  projectId,
  refreshToken,
  onDownload,
  draftState,
}: {
  projectId: string;
  /** Changes whenever the report is regenerated, so the preview re-renders. */
  refreshToken: string | number;
  onDownload?: () => void;
  /**
   * How much of the report has actually been written.
   *
   * A template can already contain text (headings, boilerplate, even sample body
   * paragraphs), so the rendered pages look like a finished report even when
   * nothing was drafted. Saying so here prevents the conclusion "my sources were
   * ignored" when the real cause is "the scan has not run yet".
   */
  draftState?: { drafted: number; total: number } | null;
}) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [zoom, setZoom] = useState(100);
  const requestId = useRef(0);
  /**
   * True while a *background* refresh is in flight, i.e. one the user did not ask
   * for. Kept separate from `loading` so the page list is never replaced by a
   * "Rendering pages…" placeholder while typing: the previous pages stay on screen
   * and only a small badge changes.
   */
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(
    async (mode: 'manual' | 'auto' = 'manual') => {
      const id = ++requestId.current;
      // A manual refresh shows the loading placeholder; an automatic one only
      // shows the small "updating" badge, so the pages already on screen stay put
      // instead of flickering away every keystroke.
      if (mode === 'auto') setSyncing(true);
      else setLoading(true);
      setError(null);
      setUnavailable(false);
      try {
        // First batch: cover + opening pages, so something readable appears fast.
        const first = await api.get<PreviewResponse>(
          `/api/projects/${projectId}/preview?from=1&to=${FIRST_BATCH}`,
        );
        if (requestId.current !== id) return;
        setPreview(first);
        setLoading(false);

        // The rest of the document, appended as it arrives. Skipped when the
        // document is short or when the cap already covered it.
        if (first.totalPages > FIRST_BATCH) {
          setSyncing(true);
          const rest = await api.get<PreviewResponse>(
            `/api/projects/${projectId}/preview?from=${FIRST_BATCH + 1}&to=${first.totalPages}`,
          );
          if (requestId.current !== id) return;
          setPreview((current) => {
            if (!current) return rest;
            const seen = new Set(current.pages.map((page) => page.page));
            const merged = [...current.pages, ...rest.pages.filter((page) => !seen.has(page.page))].sort(
              (a, b) => a.page - b.page,
            );
            return { ...rest, pages: merged, pageCount: merged.length };
          });
        }
      } catch (caught) {
        if (requestId.current !== id) return;
        const message = errorMessage(caught);
        // 501 means the server has no renderer; that is a setup fact, not a bug.
        if (/needs LibreOffice|preview needs/i.test(message)) setUnavailable(true);
        setError(message);
      } finally {
        if (requestId.current === id) {
          setLoading(false);
          setSyncing(false);
        }
      }
    },
    [projectId],
  );

  // First load, and a manual "Refresh" click.
  useEffect(() => {
    void load('manual');
  }, [load]);

  /**
   * Re-render automatically after the report changes.
   *
   * The preview used to update only when the user pressed Refresh, so it was
   * routine to look at a page, fix a section, and still be shown the old text. The
   * debounce matters: `refreshToken` changes on every save, and rendering a 40-page
   * document takes seconds, so firing per change would queue renders and hammer the
   * server. 1200 ms is long enough to swallow a burst of edits and short enough to
   * feel live.
   */
  const firstToken = useRef(true);
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false;
      return;
    }
    const handle = window.setTimeout(() => void load('auto'), 1200);
    return () => window.clearTimeout(handle);
  }, [refreshToken, load]);

  return (
    <div className="flex h-full flex-col" data-testid="preview-pane">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink-900">Preview</h2>
            {(syncing || loading) && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700"
                data-testid="preview-live"
              >
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                Updating…
              </span>
            )}
            {!syncing && !loading && preview && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                data-testid="preview-current"
                title={`Rendered ${new Date(preview.renderedAt).toLocaleTimeString()}`}
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Live
              </span>
            )}
          </div>
          <p className="text-xs text-ink-500">
            {preview
              ? `Showing ${preview.pageCount} of ${preview.totalPages} page${preview.totalPages === 1 ? '' : 's'} — this is the exported file.`
              : 'How the exported DOCX/PDF will look.'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            size="sm"
            className="w-24"
            aria-label="Zoom"
            data-testid="preview-zoom"
            value={String(zoom)}
            onChange={(next) => setZoom(Number(next))}
            options={[
              { value: '70', label: '70%' },
              { value: '85', label: '85%' },
              { value: '100', label: '100%' },
              { value: '130', label: '130%' },
            ]}
          />
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void load('manual')}
            disabled={loading}
            data-testid="preview-refresh"
          >
            {loading ? 'Rendering…' : 'Refresh'}
          </button>
          {onDownload && (
            <button type="button" className="btn-primary btn-sm" onClick={onDownload}>
              Download
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-ink-100 p-3 scroll-slim" data-testid="preview-scroll">
        {draftState && draftState.total > 0 && draftState.drafted === 0 && (
          <div
            className="mx-auto mb-3 max-w-md rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            data-testid="preview-not-generated"
          >
            <p className="font-medium">This report has not been written yet.</p>
            <p className="mt-1">
              What you see below is your template with its original text — none of your{' '}
              {draftState.total} sections has been drafted. Press <strong>Scan &amp; generate</strong> above
              to fill them from your sources.
            </p>
          </div>
        )}
        {draftState && draftState.drafted > 0 && draftState.drafted < draftState.total && (
          <div
            className="mx-auto mb-3 max-w-md rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            data-testid="preview-partial"
          >
            {draftState.drafted} of {draftState.total} sections have been written. The rest still show the
            template's original text.
          </div>
        )}
        {loading && !preview && (
          <div className="flex h-full items-center justify-center text-sm text-ink-600" data-testid="preview-loading">
            Rendering pages… large reports take a few seconds.
          </div>
        )}

        {error && (
          <div className="mx-auto max-w-md rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="preview-error">
            <p className="font-medium">
              {unavailable ? 'Page preview is not available on this server.' : 'The preview could not be rendered.'}
            </p>
            <p className="mt-1">{error}</p>
            <p className="mt-1 text-amber-800">
              The report text in the <strong>Editor</strong> tab is unaffected, and export still works.
            </p>
          </div>
        )}

        {preview && preview.pages.length > 0 && (
          <div className="mx-auto flex w-fit flex-col items-center gap-3">
            {preview.pages.map((page) => (
              <figure key={page.page} className="shadow-md" data-testid={`preview-page-${page.page}`}>
                <img
                  src={page.image}
                  alt={`Page ${page.page} of the exported report`}
                  width={page.width}
                  height={page.height}
                  style={{ width: `${(page.width * zoom) / 100}px`, height: 'auto', display: 'block' }}
                  className="bg-white"
                />
                <figcaption className="bg-white px-2 py-1 text-center text-[10px] text-ink-500">
                  Page {page.page}
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        {preview && preview.truncated && (
          <p className="mx-auto mt-3 max-w-md text-center text-xs text-ink-600" data-testid="preview-truncated">
            Only the first {preview.pageCount} pages are shown. Download the file to see all {preview.totalPages} pages.
          </p>
        )}

        {!loading && !error && preview && preview.pages.length === 0 && (
          <p className="text-center text-xs text-ink-600">This document has no pages yet.</p>
        )}
      </div>
    </div>
  );
}
