import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';

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
}

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

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const response = await api.get<PreviewResponse>(`/api/projects/${projectId}/preview`);
      // Ignore a stale response if a newer request started meanwhile.
      if (requestId.current !== id) return;
      setPreview(response);
    } catch (caught) {
      if (requestId.current !== id) return;
      const message = errorMessage(caught);
      // 501 means the server has no renderer; that is a setup fact, not a bug.
      if (/needs LibreOffice|preview needs/i.test(message)) setUnavailable(true);
      setError(message);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <div className="flex h-full flex-col" data-testid="preview-pane">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">Preview</h2>
          <p className="text-xs text-ink-500">
            {preview
              ? `Showing ${preview.pageCount} of ${preview.totalPages} page${preview.totalPages === 1 ? '' : 's'} — this is the exported file.`
              : 'How the exported DOCX/PDF will look.'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-xs text-ink-600">
            <span className="sr-only">Zoom</span>
            <select
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="rounded border border-ink-300 px-1.5 py-1 text-xs"
              data-testid="preview-zoom"
            >
              <option value={70}>70%</option>
              <option value={85}>85%</option>
              <option value={100}>100%</option>
              <option value={130}>130%</option>
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => void load()}
            disabled={loading}
            data-testid="preview-refresh"
          >
            {loading ? 'Rendering…' : 'Refresh'}
          </button>
          {onDownload && (
            <button type="button" className="btn-primary text-xs" onClick={onDownload}>
              Download
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-ink-100 p-3" data-testid="preview-scroll">
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
