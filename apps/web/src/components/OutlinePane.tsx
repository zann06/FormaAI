import { useMemo, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import type { MappingSection, OutlineSection, ReportSection } from '../lib/types';
import { CoverageBadge, SectionStatusBadge } from './StatusBadges';
import { useToast } from '../lib/toast';

/**
 * Middle pane: the template outline with per-section coverage.
 *
 * Selecting a section opens it in the editor. Section order and headings come
 * from the template, so this never invents structure. Because heading detection
 * is partly heuristic (campus templates rarely use Word heading styles), the
 * user can add sections that were missed and remove ones that were inferred
 * incorrectly.
 */
export function OutlinePane({
  projectId,
  outline,
  reports,
  mappings,
  selectedId,
  onSelect,
  onRegenerateAll,
  onChanged,
  busy,
  hasMapping,
  hasTemplate,
}: {
  projectId: string;
  outline: OutlineSection[] | null;
  reports: ReportSection[] | null;
  mappings: MappingSection[] | null;
  selectedId: string | null;
  onSelect: (sectionId: string) => void;
  onRegenerateAll: () => void;
  onChanged: () => void;
  busy: boolean;
  hasMapping: boolean;
  hasTemplate: boolean;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newHeading, setNewHeading] = useState('');
  const [newLevel, setNewLevel] = useState(1);
  const [saving, setSaving] = useState(false);

  const reportBySection = useMemo(() => {
    const map = new Map<string, ReportSection>();
    for (const report of reports ?? []) map.set(report.sectionId, report);
    return map;
  }, [reports]);

  const mappingBySection = useMemo(() => {
    const map = new Map<string, MappingSection>();
    for (const mapping of mappings ?? []) map.set(mapping.sectionId, mapping);
    return map;
  }, [mappings]);

  const visible = (outline ?? []).filter((section) => !section.excluded);
  const excluded = (outline ?? []).filter((section) => section.excluded);
  const generatedCount = visible.filter((section) => (reportBySection.get(section.id)?.content ?? '').trim()).length;

  async function addSection(event: FormEvent) {
    event.preventDefault();
    const heading = newHeading.trim();
    if (!heading) return;
    setSaving(true);
    try {
      await api.post(`/api/projects/${projectId}/sections/manual`, {
        heading,
        level: newLevel,
        paragraphIndex: 0,
      });
      toast.success(`Added section “${heading}”.`);
      setNewHeading('');
      setNewLevel(1);
      setAdding(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function setExcluded(sectionId: string, value: boolean) {
    try {
      await api.patch(`/api/projects/${projectId}/sections/${sectionId}`, { excluded: value });
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function restoreAll() {
    try {
      await Promise.all(
        excluded.map((section) =>
          api.patch(`/api/projects/${projectId}/sections/${section.id}`, { excluded: false }),
        ),
      );
      toast.success('Sections restored.');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">Outline</h2>
          <span className="text-xs text-ink-500">
            {generatedCount}/{visible.length} drafted
          </span>
        </div>
        {hasMapping && (
          <button
            type="button"
            className="btn-secondary mt-2 w-full text-xs"
            onClick={onRegenerateAll}
            disabled={busy || visible.length === 0}
          >
            Draft all sections
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Report outline">
        {!outline && <p className="p-2 text-sm text-ink-500">Loading outline…</p>}
        {outline && visible.length === 0 && (
          <div className="space-y-2 p-2 text-sm text-ink-500">
            <p>
              {hasTemplate
                ? 'No sections were detected in this template.'
                : 'Upload a .docx template in the left panel — its headings become the report sections.'}
            </p>
            <p className="text-xs">
              FormaAI looks for Word heading styles, outline levels, chapter numbering (BAB I, 1.1, ...) and
              heading-like formatting (bold, larger or centred short lines). If this template has none of those,
              use <strong>Add section</strong> below to build the outline by hand.
            </p>
          </div>
        )}
        <ul className="space-y-1">
          {visible.map((section) => {
            const report = reportBySection.get(section.id);
            const mapping = mappingBySection.get(section.id);
            const selected = section.id === selectedId;
            return (
              <li key={section.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(section.id)}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`Open section ${section.heading}`}
                  className={`w-full rounded-md py-2 pl-2.5 pr-7 text-left transition-colors ${
                    selected ? 'bg-brand-50 ring-1 ring-brand-200' : 'hover:bg-ink-100'
                  }`}
                  style={{ paddingLeft: `${Math.min(section.level - 1, 3) * 12 + 10}px` }}
                >
                  <span className={`block truncate text-sm ${section.level <= 1 ? 'font-semibold' : ''} text-ink-800`}>
                    {section.heading}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {report?.status && <SectionStatusBadge status={report.status} />}
                    {mapping && <CoverageBadge coverage={mapping.coverage} />}
                    {report?.warnings && report.warnings.length > 0 && (
                      <span className="badge bg-amber-50 text-amber-800">{report.warnings.length} note(s)</span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete section ${section.heading}`}
                  title="Remove this section from the outline"
                  className="absolute right-1 top-1 rounded px-1 text-xs text-ink-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                  onClick={() => void setExcluded(section.id, true)}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>

        {excluded.length > 0 && (
          <div className="mt-2 flex items-center justify-between px-2 text-xs text-ink-500">
            <span>
              {excluded.length} section{excluded.length === 1 ? '' : 's'} removed
            </span>
            <button type="button" className="text-brand-700 hover:underline" onClick={() => void restoreAll()}>
              Restore
            </button>
          </div>
        )}
      </nav>

      <div className="border-t border-ink-200 p-2">
        {adding ? (
          <form onSubmit={addSection} className="space-y-2">
            <input
              className="input w-full text-sm"
              placeholder="Section title"
              aria-label="New section title"
              value={newHeading}
              onChange={(event) => setNewHeading(event.target.value)}
              maxLength={400}
              autoFocus
            />
            <label className="block">
              <span className="text-xs text-ink-500">Level</span>
              <select
                aria-label="New section level"
                className="input mt-1 w-full text-xs"
                value={newLevel}
                onChange={(event) => setNewLevel(Number(event.target.value))}
              >
                <option value={1}>1 — chapter</option>
                <option value={2}>2 — sub-chapter</option>
                <option value={3}>3 — sub-sub-chapter</option>
              </select>
            </label>
            <div className="flex gap-2">
              <button type="submit" className="btn-primary text-xs" disabled={saving || !newHeading.trim()}>
                {saving ? 'Adding…' : 'Add section'}
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn-secondary w-full text-xs"
            onClick={() => setAdding(true)}
            disabled={!hasTemplate}
            title={hasTemplate ? undefined : 'Upload a template first'}
          >
            + Add section
          </button>
        )}
      </div>
    </div>
  );
}
