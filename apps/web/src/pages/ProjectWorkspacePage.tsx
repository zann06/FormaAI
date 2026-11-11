import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type {
  DocumentRecord,
  ExportArtifact,
  Job,
  MappingSection,
  OutlineSection,
  Project,
  ReportSection,
  SectionDetail,
} from '../lib/types';
import { PageHeader, ErrorState, Spinner } from '../components/Feedback';
import { SourcesPane } from '../components/SourcesPane';
import { OutlinePane } from '../components/OutlinePane';
import { SectionEditor } from '../components/SectionEditor';
import { ExportPanel } from '../components/ExportPanel';
import { ProjectStatusBadge } from '../components/StatusBadges';
import { useToast } from '../lib/toast';
import { useJobPolling, type JobLike } from '../lib/useJobPolling';

type Tab = 'editor' | 'export';

const LAST_SECTION_KEY = (projectId: string) => `formaai:last-section:${projectId}`;

/** localStorage throws in some privacy modes; the workspace must still work. */
function readLastSection(projectId: string): string | null {
  try {
    return window.localStorage?.getItem(LAST_SECTION_KEY(projectId)) ?? null;
  } catch {
    return null;
  }
}

function writeLastSection(projectId: string, sectionId: string): void {
  try {
    window.localStorage?.setItem(LAST_SECTION_KEY(projectId), sectionId);
  } catch {
    // Ignore: remembering the last section is a convenience, not a requirement.
  }
}

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[] | null>(null);
  const [outline, setOutline] = useState<OutlineSection[] | null>(null);
  const [reports, setReports] = useState<ReportSection[] | null>(null);
  const [mappings, setMappings] = useState<MappingSection[] | null>(null);
  const [exports, setExports] = useState<ExportArtifact[] | null>(null);
  const [pdfAvailable, setPdfAvailable] = useState(false);
  const [jobs, setJobs] = useState<JobLike[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SectionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [tab, setTab] = useState<Tab>('editor');
  const [mapping, setMapping] = useState(false);

  const lastBusyCount = useRef(0);
  // Refs let the polling callback call the latest loaders without re-creating
  // the polling loop every time state changes.
  const loadAllRef = useRef<() => Promise<void>>(async () => undefined);
  const loadDetailRef = useRef<(sectionId: string) => Promise<void>>(async () => undefined);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const handleJobs = useCallback((next: JobLike[]) => {
    setJobs(next);
    const busy = next.filter((job) => job.status === 'queued' || job.status === 'running').length;
    // When background work finishes, refresh the data it produced.
    if (busy === 0 && lastBusyCount.current > 0) {
      void loadAllRef.current();
      if (selectedIdRef.current) void loadDetailRef.current(selectedIdRef.current);
    }
    lastBusyCount.current = busy;
  }, []);

  const polling = useJobPolling(projectId, handleJobs, Boolean(projectId));

  const loadAll = useCallback(async () => {
    if (!projectId) return;
    setProjectError(null);
    try {
      const [projectResponse, documentsResponse, templateResponse, reportResponse, mappingResponse, exportsResponse] =
        await Promise.all([
          api.get<{ project: Project }>(`/api/projects/${projectId}`),
          api.get<{ documents: DocumentRecord[] }>(`/api/projects/${projectId}/documents`),
          api.get<{ sections: OutlineSection[] }>(`/api/projects/${projectId}/sections`),
          api.get<{ sections: ReportSection[]; outline: OutlineSection[] }>(`/api/projects/${projectId}/report`),
          api.get<{ mappings: MappingSection[] }>(`/api/projects/${projectId}/mapping`).catch(() => ({ mappings: [] })),
          api
            .get<{ exports: ExportArtifact[]; pdfAvailable: boolean }>(`/api/projects/${projectId}/exports`)
            .catch(() => ({ exports: [], pdfAvailable: false })),
        ]);
      setProject(projectResponse.project);
      setDocuments(documentsResponse.documents);
      // `/report.outline` already reflects exclusions and ordering; prefer it.
      setOutline(reportResponse.outline.length > 0 ? reportResponse.outline : templateResponse.sections);
      setReports(reportResponse.sections);
      setMappings(mappingResponse.mappings);
      setExports(exportsResponse.exports);
      setPdfAvailable(exportsResponse.pdfAvailable);

      setSelectedId((current) => {
        if (current) return current;
        const saved = readLastSection(projectId);
        const available = reportResponse.outline.filter((section) => !section.excluded);
        if (saved && available.some((section) => section.id === saved)) return saved;
        return available[0]?.id ?? null;
      });
    } catch (error) {
      setProjectError(errorMessage(error));
    }
  }, [projectId]);

  const loadDetail = useCallback(
    async (sectionId: string) => {
      if (!projectId) return;
      setDetailLoading(true);
      try {
        const result = await api.get<SectionDetail>(`/api/projects/${projectId}/sections/${sectionId}/detail`);
        setDetail(result);
      } catch (error) {
        toast.error(errorMessage(error));
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId, toast],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Keep the polling callback's refs pointing at the latest closures.
  loadAllRef.current = loadAll;
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    writeLastSection(projectId, selectedId);
    void loadDetail(selectedId);
  }, [selectedId, projectId, loadDetail]);

  async function buildMapping() {
    setMapping(true);
    try {
      await api.post(`/api/projects/${projectId}/mapping`, { useAi: true });
      toast.info('Mapping evidence to sections…');
      polling.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setMapping(false);
    }
  }

  async function regenerate(instructions: string) {
    if (!selectedId) return;
    setRegenerating(true);
    try {
      await api.post(`/api/projects/${projectId}/sections/${selectedId}/generate`, {
        instructions: instructions || undefined,
        keepEdits: false,
      });
      toast.info('Generating this section…');
      polling.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      setRegenerating(false);
    }
  }

  async function regenerateAll() {
    try {
      await api.post(`/api/projects/${projectId}/generate`, { regenerateExisting: false });
      toast.info('Drafting all empty sections…');
      polling.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  // Clear the regenerating flag once the API stops reporting busy jobs.
  useEffect(() => {
    if (regenerating && !polling.active) setRegenerating(false);
  }, [polling.active, regenerating]);

  const busy = polling.active || mapping;
  const hasContent = (reports ?? []).some((report) => report.content.trim().length > 0);
  const hasTemplate = (documents ?? []).some((document) => document.kind === 'template');
  const hasSources = (documents ?? []).some((document) => document.kind === 'source');
  const hasMapping = (mappings ?? []).length > 0;

  if (projectError) {
    return (
      <div>
        <PageHeader title="Project" />
        <ErrorState message={projectError} onRetry={() => void loadAll()} />
        <p className="mt-4 text-sm">
          <Link to="/dashboard" className="text-brand-700 hover:underline">
            ← Back to projects
          </Link>
        </p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="card p-6">
        <Spinner label="Loading project…" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/dashboard" className="text-sm text-ink-500 hover:text-ink-800">
              ← Projects
            </Link>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-ink-900">{project.title}</h1>
            <ProjectStatusBadge status={project.status} />
            {busy && <span className="text-xs text-brand-700">Working…</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasTemplate && hasSources && (
            <button type="button" className="btn-secondary" onClick={() => void buildMapping()} disabled={busy}>
              {hasMapping ? 'Rebuild mapping' : 'Map evidence'}
            </button>
          )}
          <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5" role="tablist" aria-label="Workspace view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'editor'}
              className={`rounded px-3 py-1.5 text-sm ${tab === 'editor' ? 'bg-ink-100 font-medium text-ink-900' : 'text-ink-600'}`}
              onClick={() => setTab('editor')}
            >
              Editor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'export'}
              className={`rounded px-3 py-1.5 text-sm ${tab === 'export' ? 'bg-ink-100 font-medium text-ink-900' : 'text-ink-600'}`}
              onClick={() => setTab('export')}
            >
              Export
            </button>
          </div>
        </div>
      </div>

      {!hasTemplate && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800">
          Start by uploading your .docx template in the left pane. Its headings define the report structure.
        </div>
      )}
      {hasTemplate && !hasMapping && hasSources && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Your template and sources are ready. Choose <strong>Map evidence</strong> to match sources to each section
          before drafting.
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[260px_240px_1fr]">
        <section className="card overflow-hidden" aria-label="Template and sources">
          <SourcesPane
            projectId={projectId}
            documents={documents}
            loading={!documents}
            latestJobs={jobs as unknown as Job[]}
            onChanged={() => {
              void loadAll();
              polling.refresh();
            }}
          />
        </section>

        <section className="card overflow-hidden" aria-label="Report outline">
          <OutlinePane
            outline={outline}
            reports={reports}
            mappings={mappings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRegenerateAll={() => void regenerateAll()}
            busy={busy}
            hasMapping={hasMapping}
          />
        </section>

        <section className="card overflow-hidden" aria-label={tab === 'editor' ? 'Section editor' : 'Export'}>
          {tab === 'export' ? (
            <ExportPanel
              projectId={projectId}
              exports={exports}
              pdfAvailable={pdfAvailable}
              hasContent={hasContent}
              onChanged={() => {
                void loadAll();
                polling.refresh();
              }}
            />
          ) : selectedId ? (
            <SectionEditor
              projectId={projectId}
              sectionId={selectedId}
              detail={detailLoading ? null : detail}
              regenerating={regenerating}
              onSaved={(content) =>
                setReports((current) =>
                  (current ?? []).map((report) =>
                    report.sectionId === selectedId ? { ...report, content } : report,
                  ),
                )
              }
              onRegenerate={(instructions) => void regenerate(instructions)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-ink-500">
              Select a section from the outline to edit it, or upload a template to create the outline.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
