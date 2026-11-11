import { useMemo } from 'react';
import type { MappingSection, OutlineSection, ReportSection } from '../lib/types';
import { CoverageBadge, SectionStatusBadge } from './StatusBadges';

/**
 * Middle pane: the template outline with per-section coverage.
 *
 * Selecting a section opens it in the editor. Section order and headings come
 * from the template, so this never invents structure.
 */
export function OutlinePane({
  outline,
  reports,
  mappings,
  selectedId,
  onSelect,
  onRegenerateAll,
  busy,
  hasMapping,
}: {
  outline: OutlineSection[] | null;
  reports: ReportSection[] | null;
  mappings: MappingSection[] | null;
  selectedId: string | null;
  onSelect: (sectionId: string) => void;
  onRegenerateAll: () => void;
  busy: boolean;
  hasMapping: boolean;
}) {
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
  const generatedCount = visible.filter((section) => (reportBySection.get(section.id)?.content ?? '').trim()).length;

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
          <p className="p-2 text-sm text-ink-500">
            Upload a .docx template to build the outline. Its headings become the report sections.
          </p>
        )}
        <ul className="space-y-1">
          {visible.map((section) => {
            const report = reportBySection.get(section.id);
            const mapping = mappingBySection.get(section.id);
            const selected = section.id === selectedId;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => onSelect(section.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
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
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
