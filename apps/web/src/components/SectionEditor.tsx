import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { SectionDetail } from '../lib/types';
import { CoverageBadge, SectionStatusBadge } from './StatusBadges';
import { SkeletonLines } from './Feedback';
import { useToast } from '../lib/toast';

/**
 * Right pane: edit a single section.
 *
 * Content is saved on blur and via an explicit button; autosave is debounced and
 * only fires when the text actually changed, so idle editing never writes.
 */
export function SectionEditor({
  projectId,
  sectionId,
  detail,
  onSaved,
  onRegenerate,
  regenerating,
}: {
  projectId: string;
  sectionId: string;
  detail: SectionDetail | null;
  onSaved: (content: string) => void;
  onRegenerate: (instructions: string) => void;
  regenerating: boolean;
}) {
  const toast = useToast();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [showEvidence, setShowEvidence] = useState(true);
  const savedRef = useRef('');
  const debounce = useRef<number | null>(null);

  // Reset local state whenever a different section (or a fresh server copy) loads.
  useEffect(() => {
    const next = detail?.content ?? '';
    setContent(next);
    savedRef.current = next;
    setDirty(false);
    setInstructions('');
  }, [detail?.section.id, detail?.revision, detail?.content]);

  const wordCount = useMemo(() => (content.trim() ? content.trim().split(/\s+/).length : 0), [content]);

  async function save(showToast = true) {
    if (content === savedRef.current) return;
    setSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}/sections/${sectionId}/content`, { content });
      savedRef.current = content;
      setDirty(false);
      onSaved(content);
      if (showToast) toast.success('Section saved.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function onChange(value: string) {
    setContent(value);
    setDirty(value !== savedRef.current);
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void save(false), 2000);
  }

  useEffect(
    () => () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    },
    [],
  );

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-md">
          <SkeletonLines count={6} />
        </div>
      </div>
    );
  }

  const section = detail.section;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-200 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-ink-900">{section.heading}</h2>
          <SectionStatusBadge status={detail.status} />
          {detail.mapping && <CoverageBadge coverage={detail.mapping.coverage} />}
          {saving && <span className="text-xs text-brand-700">Saving…</span>}
          {dirty && !saving && <span className="text-xs text-amber-700">Unsaved changes</span>}
        </div>
        {detail.mapping?.purpose && <p className="mt-1 text-sm text-ink-600">{detail.mapping.purpose}</p>}
      </div>

      <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col overflow-y-auto px-6 py-4">
          {(detail.warnings.length > 0 || detail.placeholders.length > 0) && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Review needed</p>
              {detail.warnings.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {detail.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
              {detail.placeholders.length > 0 && (
                <p className="mt-1 text-xs">
                  Placeholders to fill: {detail.placeholders.join(', ')}
                </p>
              )}
            </div>
          )}

          <label htmlFor="section-content" className="sr-only">
            Section content
          </label>
          <textarea
            id="section-content"
            className="input min-h-80 flex-1 resize-none font-[inherit] leading-relaxed"
            value={content}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => void save(false)}
            placeholder="This section has not been drafted yet. Generate it, or write it yourself."
          />
          <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
            <span>{wordCount} words</span>
            <span>
              {detail.modelUsed ? `Generated with ${detail.modelUsed}` : 'No model used yet'}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => void save(true)} disabled={saving || !dirty}>
              Save
            </button>
            <div className="flex flex-1 items-center gap-2">
              <label htmlFor="regen-instructions" className="sr-only">
                Regeneration instructions
              </label>
              <input
                id="regen-instructions"
                className="input flex-1"
                placeholder="Optional: how should this section change?"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={2000}
              />
              <button
                type="button"
                className="btn-primary shrink-0"
                onClick={() => onRegenerate(instructions.trim())}
                disabled={regenerating}
              >
                {regenerating ? 'Generating…' : content.trim() ? 'Regenerate' : 'Generate'}
              </button>
            </div>
          </div>
        </div>

        <aside className="overflow-y-auto border-t border-ink-200 bg-ink-50/50 px-4 py-4 lg:border-l lg:border-t-0">
          {detail.mapping && (
            <div className="mb-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Requirements</h3>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-ink-700">
                {detail.mapping.requirements.length === 0 && <li className="list-none text-ink-500">None set.</li>}
                {detail.mapping.requirements.map((requirement, index) => (
                  <li key={index}>{requirement}</li>
                ))}
              </ul>
              {detail.mapping.gaps.length > 0 && (
                <>
                  <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-amber-700">Gaps</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-amber-800">
                    {detail.mapping.gaps.map((gap, index) => (
                      <li key={index}>{gap}</li>
                    ))}
                  </ul>
                </>
              )}
              {detail.mapping.conflicts.length > 0 && (
                <>
                  <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-red-700">Conflicts</h3>
                  <ul className="mt-1 space-y-1 text-sm text-red-800">
                    {detail.mapping.conflicts.map((conflict, index) => (
                      <li key={index}>
                        {conflict.label}:{' '}
                        {conflict.values.map((value) => `${value.value} (${value.documentName})`).join(' vs ')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Evidence ({detail.evidence.length})
            </h3>
            <button
              type="button"
              className="text-xs text-ink-500 hover:text-ink-800"
              onClick={() => setShowEvidence((value) => !value)}
              aria-expanded={showEvidence}
            >
              {showEvidence ? 'Hide' : 'Show'}
            </button>
          </div>
          {showEvidence && (
            <ul className="mt-2 space-y-2">
              {detail.evidence.length === 0 && (
                <li className="text-sm text-ink-500">
                  No evidence mapped to this section yet. Add source documents and build the mapping.
                </li>
              )}
              {detail.evidence.map((item) => (
                <li key={item.id} className="rounded-md border border-ink-200 bg-white p-2 text-xs text-ink-700">
                  <p className="font-medium text-ink-800">
                    {item.documentName}
                    {item.page ? ` · p.${item.page}` : ''}
                  </p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-ink-600">{item.text}</p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
