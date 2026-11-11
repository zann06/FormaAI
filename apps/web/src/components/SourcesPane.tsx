import { useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { DocumentRecord, Job } from '../lib/types';
import { DocumentStatusBadge } from './StatusBadges';
import { ConfirmDialog } from './Dialog';
import { useToast } from '../lib/toast';
import { formatBytes, formatRelative } from '../lib/format';
import { SOURCE_EXTENSIONS, TEMPLATE_EXTENSIONS } from '@formaai/shared';

/**
 * Left pane: the template and source documents.
 *
 * Uploads are real multipart requests; the API enforces type and size limits, so
 * the client only pre-checks extensions to give faster feedback.
 */
export function SourcesPane({
  projectId,
  documents,
  loading,
  latestJobs,
  onChanged,
}: {
  projectId: string;
  documents: DocumentRecord[] | null;
  loading: boolean;
  latestJobs: Job[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const templateInput = useRef<HTMLInputElement>(null);

  const template = documents?.find((doc) => doc.kind === 'template');
  const sources = documents?.filter((doc) => doc.kind === 'source') ?? [];

  async function uploadFiles(files: File[], kind: 'template' | 'source') {
    if (files.length === 0) return;
    const allowed = kind === 'template' ? TEMPLATE_EXTENSIONS : SOURCE_EXTENSIONS;
    const rejected = files.filter((file) => !allowed.some((ext) => file.name.toLowerCase().endsWith(ext)));
    if (rejected.length > 0) {
      toast.error(
        `Unsupported file type: ${rejected.map((file) => file.name).join(', ')}. Allowed: ${allowed.join(', ')}`,
      );
      if (rejected.length === files.length) return;
    }
    const accepted = files.filter((file) => !rejected.includes(file));

    setUploading(true);
    let ok = 0;
    for (const file of accepted) {
      try {
        await api.upload(`/api/projects/${projectId}/documents`, file, kind);
        ok += 1;
      } catch (error) {
        toast.error(`${file.name}: ${errorMessage(error)}`);
      }
    }
    setUploading(false);
    if (ok > 0) {
      toast.success(`Uploaded ${ok} file${ok === 1 ? '' : 's'}. Processing started.`);
      onChanged();
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/projects/${projectId}/documents/${deleteTarget.id}`);
      toast.success(`Removed “${deleteTarget.originalName}”.`);
      setDeleteTarget(null);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  async function reextract(document: DocumentRecord) {
    try {
      await api.post(`/api/projects/${projectId}/documents/${document.id}/reextract`);
      toast.info(`Re-processing “${document.originalName}”.`);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const templates = files.filter((file) => file.name.toLowerCase().endsWith('.docx'));
    const hasTemplateAlready = Boolean(template);
    if (!hasTemplateAlready && templates.length > 0) {
      void uploadFiles([templates[0]!], 'template');
      void uploadFiles(
        files.filter((file) => file !== templates[0]),
        'source',
      );
    } else {
      void uploadFiles(files, 'source');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">Template &amp; sources</h2>
        {uploading && <span className="text-xs text-brand-700">Uploading…</span>}
      </div>

      <div
        className={`m-3 rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${
          dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-50/50'
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="text-ink-700">Drag files here</p>
        <p className="mt-1 text-xs text-ink-500">.docx template · .pdf, .docx, .txt sources</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {!template && (
            <button type="button" className="btn-secondary" onClick={() => templateInput.current?.click()}>
              Choose template
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => sourceInput.current?.click()}>
            Add sources
          </button>
        </div>
        <input
          ref={templateInput}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            void uploadFiles(Array.from(event.target.files ?? []), 'template');
            event.target.value = '';
          }}
        />
        <input
          ref={sourceInput}
          type="file"
          accept={SOURCE_EXTENSIONS.join(',')}
          multiple
          className="hidden"
          onChange={(event) => {
            void uploadFiles(Array.from(event.target.files ?? []), 'source');
            event.target.value = '';
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Template</h3>
        {loading && !documents && <div className="skeleton mx-1 h-12" />}
        {documents && !template && (
          <p className="px-1 text-sm text-ink-500">No template uploaded yet.</p>
        )}
        {template && (
          <DocumentRow document={template} projectId={projectId} onDelete={setDeleteTarget} onReextract={reextract} />
        )}

        <h3 className="mb-2 mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Sources ({sources.length})
        </h3>
        {documents && sources.length === 0 && (
          <p className="px-1 text-sm text-ink-500">No source documents yet. Add the files the report should cite.</p>
        )}
        <ul className="space-y-2">
          {sources.map((document) => (
            <li key={document.id}>
              <DocumentRow
                document={document}
                projectId={projectId}
                onDelete={setDeleteTarget}
                onReextract={reextract}
              />
            </li>
          ))}
        </ul>

        {latestJobs.length > 0 && (
          <>
            <h3 className="mb-2 mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Recent activity</h3>
            <ul className="space-y-1 text-xs text-ink-600">
              {latestJobs.slice(0, 6).map((job) => (
                <li key={job.id} className="flex items-center gap-2 px-1">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      job.status === 'failed'
                        ? 'bg-red-500'
                        : job.status === 'succeeded'
                          ? 'bg-emerald-500'
                          : 'bg-brand-500'
                    }`}
                    aria-hidden
                  />
                  <span className="truncate">{job.kind.replace(/_/g, ' ')}</span>
                  <span className="ml-auto shrink-0 text-ink-400">{job.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove document?"
        description={`“${deleteTarget?.originalName ?? ''}” will be deleted and its extracted text removed. Generated sections keep their text but lose this citation.`}
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function DocumentRow({
  document,
  projectId,
  onDelete,
  onReextract,
}: {
  document: DocumentRecord;
  projectId: string;
  onDelete: (document: DocumentRecord) => void;
  onReextract: (document: DocumentRecord) => void;
}) {
  const toast = useToast();
  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium text-ink-800" title={document.originalName}>
          {document.originalName}
        </p>
        <DocumentStatusBadge status={document.status} />
      </div>
      <p className="mt-0.5 text-xs text-ink-500">
        {formatBytes(document.sizeBytes)} · {formatRelative(document.createdAt)}
      </p>
      {document.extractionError && (
        <p className="mt-1 text-xs text-red-600">{document.extractionError}</p>
      )}
      <div className="mt-1.5 flex gap-3 text-xs">
        <button
          type="button"
          className="text-ink-500 hover:text-brand-700"
          onClick={() =>
            void api
              .download(`/api/projects/${projectId}/documents/${document.id}/download`, document.originalName)
              .catch((error) => toast.error(errorMessage(error)))
          }
        >
          Download
        </button>
        {document.status === 'failed' && (
          <button type="button" className="text-brand-700 hover:underline" onClick={() => onReextract(document)}>
            Retry extraction
          </button>
        )}
        <button type="button" className="text-ink-500 hover:text-red-600" onClick={() => onDelete(document)}>
          Remove
        </button>
      </div>
    </div>
  );
}
