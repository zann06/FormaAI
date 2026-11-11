import { useState } from 'react';
import { api, errorMessage, ApiError } from '../lib/api';
import type { ExportArtifact } from '../lib/types';
import { Badge } from './StatusBadges';
import { useToast } from '../lib/toast';
import { formatBytes, formatRelative } from '../lib/format';

/** Export panel: request a DOCX/PDF, then download once it is ready. */
export function ExportPanel({
  projectId,
  exports,
  pdfAvailable,
  onChanged,
  hasContent,
}: {
  projectId: string;
  exports: ExportArtifact[] | null;
  pdfAvailable: boolean;
  onChanged: () => void;
  hasContent: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'docx' | 'pdf' | null>(null);

  async function startExport(format: 'docx' | 'pdf') {
    setBusy(format);
    try {
      await api.post(`/api/projects/${projectId}/exports`, { format });
      toast.info(`${format.toUpperCase()} export queued. It will appear here when ready.`);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PDF_CONVERTER_NOT_CONFIGURED') {
        toast.error('PDF conversion is not configured on this server. Export DOCX instead.');
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(null);
    }
  }

  async function download(artifact: ExportArtifact) {
    try {
      await api.download(
        `/api/projects/${projectId}/exports/${artifact.id}/download`,
        `report-v${artifact.versionNumber}.${artifact.format}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">Export</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void startExport('docx')}
            disabled={busy !== null || !hasContent}
          >
            {busy === 'docx' ? 'Queuing…' : 'Export editable DOCX'}
          </button>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => void startExport('pdf')}
            disabled={busy !== null || !hasContent || !pdfAvailable}
            title={pdfAvailable ? undefined : 'PDF conversion is not configured on this server'}
          >
            {busy === 'pdf' ? 'Queuing…' : 'Export PDF'}
          </button>
          {!pdfAvailable && (
            <p className="text-xs text-ink-500">
              PDF export is disabled because no converter is configured. DOCX export always works.
            </p>
          )}
          {!hasContent && (
            <p className="text-xs text-ink-500">Draft at least one section before exporting.</p>
          )}
        </div>

        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">History</h3>
        {(!exports || exports.length === 0) && <p className="text-sm text-ink-500">No exports yet.</p>}
        <ul className="space-y-2">
          {(exports ?? []).map((artifact) => (
            <li key={artifact.id} className="rounded-md border border-ink-200 bg-white p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink-800">
                  {artifact.format.toUpperCase()} · v{artifact.versionNumber}
                </span>
                <ExportStatusBadge status={artifact.status} />
              </div>
              <p className="mt-0.5 text-ink-500">
                {formatRelative(artifact.createdAt)}
                {artifact.sizeBytes ? ` · ${formatBytes(artifact.sizeBytes)}` : ''}
              </p>
              {artifact.errorMessage && <p className="mt-1 text-red-600">{artifact.errorMessage}</p>}
              {artifact.status === 'ready' && (
                <button
                  type="button"
                  className="mt-1.5 text-brand-700 hover:underline"
                  onClick={() => void download(artifact)}
                >
                  Download
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ExportStatusBadge({ status }: { status: ExportArtifact['status'] }) {
  const tone = status === 'ready' ? 'green' : status === 'failed' ? 'red' : 'blue';
  const label = status === 'ready' ? 'Ready' : status === 'failed' ? 'Failed' : 'Processing';
  return <Badge tone={tone}>{label}</Badge>;
}
