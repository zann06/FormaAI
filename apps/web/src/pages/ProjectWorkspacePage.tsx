import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  TemplateAnalysis,
} from '../lib/types';
import { PageHeader, ErrorState, Spinner } from '../components/Feedback';
import { SourcesPane } from '../components/SourcesPane';
import { OutlinePane } from '../components/OutlinePane';
import { SectionEditor } from '../components/SectionEditor';
import { ExportPanel } from '../components/ExportPanel';
import { ScanPanel } from '../components/ScanPanel';
import { PreviewPane } from '../components/PreviewPane';
import { ChatPanel, type ProviderOption } from '../components/ChatPanel';
import { Drawer } from '../components/Drawer';
import { ProjectStatusBadge } from '../components/StatusBadges';
import { useToast } from '../lib/toast';
import { useJobPolling, type JobLike } from '../lib/useJobPolling';
import { classifySection, shouldKeepTemplateText } from '@formaai/shared';

type Tab = 'editor' | 'preview' | 'export';

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

/** Terminal-failure keys already reported to the user, so polling cannot spam toasts. */
const reportedJobFailures = new Set<string>();

const MODEL_KEY = (projectId: string) => `formaai:chat-model:${projectId}`;

/** The model last chosen for this project, so the picker does not reset on reload. */
function readStoredModel(projectId: string): string | null {
  try {
    return window.localStorage?.getItem(MODEL_KEY(projectId)) ?? null;
  } catch {
    return null;
  }
}

function writeStoredModel(projectId: string, credentialId: string): void {
  try {
    window.localStorage?.setItem(MODEL_KEY(projectId), credentialId);
  } catch {
    // Ignore: remembering the model is a convenience.
  }
}

function rememberReported(key: string): void {
  // A long-lived tab sees many jobs; keep the dedup set bounded.
  if (reportedJobFailures.size > 200) reportedJobFailures.clear();
  reportedJobFailures.add(key);
}

/** The most recent job of a kind, oldest-first list assumed to be newest-first. */
function latestJobOfKind(jobs: JobLike[], kind: string): JobLike | null {
  return jobs.find((job) => job.kind === kind) ?? null;
}

/**
 * A cheap, stable digest of section text, used to detect edits.
 *
 * FNV-1a: 4 bytes of state, one pass over the string, and good enough to notice
 * that text changed — which is all the preview token needs. Not a security hash,
 * so collisions only cost a missed refresh, never correctness of the document.
 */
function hashContent(text: string): string {
  if (text.length === 0) return '0';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
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
  const [templateJob, setTemplateJob] = useState<TemplateAnalysis['latestJob']>(null);
  // Drafting is impossible without an AI provider; null = not loaded yet.
  const [providerCount, setProviderCount] = useState<number | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SectionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [tab, setTab] = useState<Tab>('editor');
  const [mapping, setMapping] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [includeExports, setIncludeExports] = useState(true);
  const [startedScanJobId, setStartedScanJobId] = useState<string | null>(null);
  // The workspace is chat + preview; everything else opens as a drawer.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const lastBusyCount = useRef(0);
  // Refs let the polling callback call the latest loaders without re-creating
  // the polling loop every time state changes.
  const loadAllRef = useRef<() => Promise<void>>(async () => undefined);
  const loadDetailRef = useRef<(sectionId: string) => Promise<void>>(async () => undefined);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const handleJobs = useCallback(
    (next: JobLike[]) => {
      setJobs(next);
      // A failed evidence mapping used to fail silently: the only trace was the
      // word "failed" in Recent activity, so users could not tell why nothing
      // was mapped. Report each failed job once, with the server's reason.
      for (const job of next) {
        if (job.status !== 'failed') continue;
        const key = `${job.id}:${job.finishedAt ?? ''}`;
        if (reportedJobFailures.has(key)) continue;
        rememberReported(key);
        const label = (job.kind ?? 'job').replace(/_/g, ' ');
        const reason =
          job.errorMessage?.trim() ||
          'The job failed without a message. Check the server logs for details.';
        toast.error(`${label} failed: ${reason}`);
      }
      const busy = next.filter((job) => job.status === 'queued' || job.status === 'running').length;
      // When background work finishes, refresh the data it produced.
      if (busy === 0 && lastBusyCount.current > 0) {
        void loadAllRef.current();
        if (selectedIdRef.current) void loadDetailRef.current(selectedIdRef.current);
      }
      lastBusyCount.current = busy;
    },
    [toast],
  );

  const polling = useJobPolling(projectId, handleJobs, Boolean(projectId));

  const loadAll = useCallback(async () => {
    if (!projectId) return;
    setProjectError(null);
    try {
      const [projectResponse, documentsResponse, templateResponse, templateDetailResponse, reportResponse, mappingResponse, exportsResponse, credentialsResponse] =
        await Promise.all([
          api.get<{ project: Project }>(`/api/projects/${projectId}`),
          api.get<{ documents: DocumentRecord[] }>(`/api/projects/${projectId}/documents`),
          api.get<{ sections: OutlineSection[] }>(`/api/projects/${projectId}/sections`),
          // The template analysis carries the latest analyze_template job, which is
          // where "no headings detected" shows up. Without it a failed template
          // looks identical to one that is still processing.
          api
            .get<TemplateAnalysis>(`/api/projects/${projectId}/template`)
            .catch(() => ({ template: null, structure: null, sections: [], latestJob: null })),
          api.get<{ sections: ReportSection[]; outline: OutlineSection[] }>(`/api/projects/${projectId}/report`),
          api.get<{ mappings: MappingSection[] }>(`/api/projects/${projectId}/mapping`).catch(() => ({ mappings: [] })),
          api
            .get<{ exports: ExportArtifact[]; pdfAvailable: boolean }>(`/api/projects/${projectId}/exports`)
            .catch(() => ({ exports: [], pdfAvailable: false })),
          // Drafting needs an AI provider. Without one the pipeline fails at the
          // draft step, which used to look like "my sources were ignored".
          api
            .get<{ credentials: Array<{ id: string; displayName: string; providerType: string; model: string; isDefault: boolean }> }>(
              '/api/provider-credentials',
            )
            .catch(() => ({ credentials: [] })),
        ]);
      setProject(projectResponse.project);
      setDocuments(documentsResponse.documents);
      setProviderCount(credentialsResponse.credentials.length);
      setProviders(
        credentialsResponse.credentials.map((credential) => ({
          id: credential.id,
          displayName: credential.displayName,
          providerType: credential.providerType,
          model: credential.model,
          isDefault: credential.isDefault,
        })),
      );
      setSelectedProviderId((current) => {
        if (current && credentialsResponse.credentials.some((credential) => credential.id === current)) return current;
        const stored = readStoredModel(projectId);
        if (stored && credentialsResponse.credentials.some((credential) => credential.id === stored)) return stored;
        return (
          credentialsResponse.credentials.find((credential) => credential.isDefault)?.id ??
          credentialsResponse.credentials[0]?.id ??
          null
        );
      });
      // `/report.outline` already reflects exclusions and ordering; prefer it.
      setOutline(reportResponse.outline.length > 0 ? reportResponse.outline : templateResponse.sections);
      setReports(reportResponse.sections);
      setMappings(mappingResponse.mappings);
      setExports(exportsResponse.exports);
      setPdfAvailable(exportsResponse.pdfAvailable);
      setTemplateJob(templateDetailResponse.latestJob ?? null);

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

  /**
   * One-click flow: analyse the template, map evidence and draft every section,
   * optionally producing DOCX/PDF. Runs as a single server-side job so the user
   * sees one progress bar and one failure reason.
   */
  async function startScan() {
    setScanning(true);
    try {
      const wantsFiles = includeExports && hasTemplate && hasSections;
      const response = await api.post<{ jobId: string }>(`/api/projects/${projectId}/pipeline`, {
        useAi: true,
        // The model chosen in the chat picker follows the request, so switching
        // model is not a cosmetic change.
        providerCredentialId: selectedProviderId ?? undefined,
        exportFormats: wantsFiles ? ['docx', 'pdf'] : undefined,
      });
      setStartedScanJobId(response.jobId);
      toast.info(wantsFiles ? 'Scanning, drafting and building files…' : 'Scanning and drafting…');
      polling.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setScanning(false);
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

  /**
   * Runs the pipeline for the chat and waits for it to finish, so the assistant
   * can report the real per-step outcome inline instead of saying "started".
   *
   * Waiting is deliberate: the value of showing feedback in the chat is that the
   * reply contains the actual result, not a promise to check later.
   */
  const runPipelineForChat = useCallback(async () => {
    try {
      const response = await api.post<{ jobId: string }>(`/api/projects/${projectId}/pipeline`, {
        useAi: true,
        providerCredentialId: selectedProviderId ?? undefined,
        exportFormats: includeExports && hasTemplate ? ['docx', 'pdf'] : undefined,
      });
      setStartedScanJobId(response.jobId);
      polling.refresh();

      // Poll the job until it settles. The pipeline drafts every section, which
      // is minutes on a 44-section report, so cap the wait and report honestly.
      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const job = await api.get<{
          job: { status: string; result?: { summary?: string; steps?: Array<{ name: string; status: string; message?: string }> }; errorMessage?: string | null };
        }>(`/api/projects/${projectId}/jobs/${response.jobId}`);
        const status = job.job?.status;
        if (status !== 'succeeded' && status !== 'failed') continue;
        if (status === 'failed') {
          return {
            summary: job.job.errorMessage?.trim() || 'The job failed without a message.',
            steps: [{ name: 'pipeline', status: 'failed', message: job.job.errorMessage?.trim() || 'The job failed.' }],
          };
        }
        return {
          summary: String(job.job.result?.summary ?? ''),
          steps: job.job.result?.steps ?? [],
        };
      }
      return { summary: 'The run is still going after 20 minutes.', steps: [] };
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    }
  }, [projectId, selectedProviderId, includeExports, hasTemplate, polling, toast]);

  /** Creates a real export file for the chat and reports what happened. */
  const exportForChat = useCallback(
    async (format: 'docx' | 'pdf') => {
      try {
        const response = await api.post<{ jobId: string }>(`/api/projects/${projectId}/exports`, { format });
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const job = await api.get<{
            job: {
              status: string;
              errorMessage?: string | null;
              result?: { missingCoverFields?: string[]; warnings?: string[] };
            };
          }>(`/api/projects/${projectId}/jobs/${response.jobId}`);
          const status = job.job?.status;
          if (status !== 'succeeded' && status !== 'failed') continue;
          if (status === 'failed') {
            return { ok: false, message: job.job.errorMessage?.trim() || `The ${format.toUpperCase()} job failed.` };
          }
          return {
            ok: true,
            message: `The ${format.toUpperCase()} file was built and saved.`,
            missingCoverFields: job.job.result?.missingCoverFields ?? [],
          };
        }
        return { ok: false, message: `The ${format.toUpperCase()} export did not finish in time.` };
      } catch (error) {
        // The 409 for empty required sections carries the section names, which is
        // exactly what the user needs to see in the chat.
        return { ok: false, message: errorMessage(error) };
      }
    },
    [projectId],
  );

  const hasMapping = (mappings ?? []).length > 0;
  const visibleSections = (outline ?? []).filter((section) => !section.excluded);
  const hasSections = visibleSections.length > 0;

  // The two reasons "Map evidence" cannot work yet. Both used to be silent: the
  // button failed and the outline stayed empty with no explanation.
  const latestTemplateJob = useMemo(
    () => templateJob ?? latestJobOfKind(jobs, 'analyze_template'),
    [templateJob, jobs],
  );
  const latestMappingJob = useMemo(() => latestJobOfKind(jobs, 'map_evidence'), [jobs]);
  const mappingFailed = latestMappingJob?.status === 'failed';
  const templateStillProcessing =
    hasTemplate && !hasSections && latestTemplateJob !== null &&
    (latestTemplateJob.status === 'queued' || latestTemplateJob.status === 'running');
  const templateProducedNoSections =
    hasTemplate && !hasSections && latestTemplateJob?.status === 'succeeded';
  const templateExtractionFailed = hasTemplate && !hasSections && latestTemplateJob?.status === 'failed';
  const noSourcesWithText = hasSources ? !(documents ?? []).some((doc) => doc.kind === 'source' && doc.status === 'extracted') : false;
  const inFlightMapping = latestMappingJob?.status === 'queued' || latestMappingJob?.status === 'running';

  // The newest pipeline run: prefer the job we just started, so a stale older
  // run cannot make a fresh scan look finished.
  const latestScanJob = useMemo(() => {
    const scanJobs = jobs.filter((job) => job.kind === 'run_pipeline');
    if (startedScanJobId) {
      const started = scanJobs.find((job) => job.id === startedScanJobId);
      if (started) return started;
    }
    return latestJobOfKind(jobs, 'run_pipeline');
  }, [jobs, startedScanJobId]);
  const scanRunning =
    latestScanJob?.status === 'queued' || latestScanJob?.status === 'running';
  const extractingCount = (documents ?? []).filter(
    (document) => document.kind === 'source' && (document.status === 'queued' || document.status === 'extracting'),
  ).length;
  const hasSourcesWithText = (documents ?? []).some(
    (document) => document.kind === 'source' && document.status === 'extracted',
  );
  // Scanning can work with a template plus *any* uploaded source: the pipeline
  // itself waits for nothing, it reports when there is no readable evidence.
  // A provider is a hard requirement: without one the pipeline fails at the draft
  // step, and the user used to see "my sources were ignored" instead of a cause.
  const scanBlockedReason = !hasTemplate
    ? 'Upload a .docx template first — its headings define the report structure.'
    : !hasSources
      ? 'Add at least one source document (PDF, DOCX, TXT, image or .zip).'
      : providerCount === 0
        ? 'Add an AI provider in Settings → AI providers. Drafting cannot run without one, even though your sources are ready.'
        : null;

  // "Has the report been written yet?" — a template that already contains text
  // looks finished in the Preview tab, which made an ungenerated project look
  // like a project whose sources were silently dropped.
  const draftedCount = (reports ?? []).filter((report) => (report.content ?? '').trim().length > 0).length;
  const totalSections = (outline ?? []).filter((section) => !section.excluded).length;
  const neverGenerated = totalSections > 0 && draftedCount === 0;

  // While a scan runs, the old manual step banners ("Map evidence…") would be
  // noise: the scan panel already shows each step. Hide them during a scan.
  const showManualHints = !scanRunning && !scanning;

  /**
   * Sections that genuinely still need text.
   *
   * A cover line or a rubric sheet has no stored body *by design* — its content is
   * the template's own — so counting it as "empty" would tell the user to fix
   * something that is already correct.
   */
  const emptyHeadings = useMemo(() => {
    const reportBySection = new Map((reports ?? []).map((report) => [report.sectionId, report.content ?? '']));
    const visible = (outline ?? []).filter((section) => !section.excluded);
    const firstOrder = visible.reduce((min, section) => Math.min(min, section.sortOrder ?? 0), Number.MAX_SAFE_INTEGER);
    return visible
      .filter((section) => !reportBySection.get(section.id)?.trim())
      .filter((section) => {
        const kind = classifySection({
          heading: section.heading,
          level: section.level ?? 1,
          nearStart: (section.sortOrder ?? 0) - firstOrder < 8,
          isTitleStyle: /^(title|subtitle|coverpage|cover)$/i.test(section.styleId ?? ''),
        });
        return !shouldKeepTemplateText(kind);
      })
      .map((section) => section.heading);
  }, [outline, reports]);

  /**
   * The single most important thing the user should do next.
   *
   * Showing every conditional banner at once buried the important one in noise,
   * which is how a missing provider went unnoticed: the page said "press Scan"
   * while pressing Scan could only fail.
   */
  const actionRequired: 'no-provider' | 'scan' | null =
    !showManualHints || !hasSections || !hasSources || scanRunning || inFlightMapping
      ? null
      : providerCount === 0
        ? 'no-provider'
        : neverGenerated || (!hasMapping && !mappingFailed)
          ? 'scan'
          : null;

  // Changing this re-fetches the preview. Derived from report content so an edit
  // or a new scan invalidates it, while a plain tab switch does not re-render.
  //
  // The section content is hashed rather than measured by length: a length-only
  // token missed every edit that happened to keep the same character count — a
  // corrected typo, a changed number, a swapped word — so the preview silently kept
  // showing the old text for exactly the small fixes it is most useful for.
  const previewToken = useMemo(
    () =>
      (reports ?? [])
        .map((report) => `${report.sectionId}:${hashContent(report.content ?? '')}`)
        .join('|') +
      `#${latestScanJob?.id ?? ''}:${latestScanJob?.status ?? ''}:${latestScanJob?.finishedAt ?? ''}`,
    [reports, latestScanJob],
  );

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
          {/* Mapping needs an outline, sources and readable source text. Offering the
              button before that produced jobs that always failed. */}
          {hasSections && hasSources && !inFlightMapping && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void buildMapping()}
              disabled={busy}
              title={
                noSourcesWithText
                  ? 'No source has been read yet, so mapping would find no evidence.'
                  : undefined
              }
            >
              {hasMapping ? 'Rebuild mapping' : 'Map evidence'}
            </button>
          )}
          <div className="inline-flex rounded-md border border-ink-200 bg-white p-0.5" role="tablist" aria-label="Workspace view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              className={`rounded px-3 py-1.5 text-sm ${tab === 'preview' ? 'bg-ink-100 font-medium text-ink-900' : 'text-ink-600'}`}
              onClick={() => setTab('preview')}
            >
              Preview
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

      <ScanPanel
        job={latestScanJob}
        onStart={() => void startScan()}
        disabled={scanBlockedReason !== null || scanning}
        disabledReason={scanBlockedReason}
        canExport={hasTemplate && hasSections}
        includeExports={includeExports}
        onToggleExports={setIncludeExports}
        hasTemplate={hasTemplate}
        hasSources={hasSources}
        extractingCount={extractingCount}
        hasReadableSource={hasSourcesWithText}
      />

      {!hasTemplate && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800">
          Start by uploading your .docx template in the left pane. Its headings define the report structure.
        </div>
      )}

      {templateStillProcessing && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800">
          Analysing the template — the outline appears here as soon as its headings are read.
        </div>
      )}

      {templateProducedNoSections && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <strong>No sections were found in your template.</strong> FormaAI looked for Word heading styles,
          outline levels, chapter numbering (BAB I, 1.1, ...) and heading-like formatting (bold, larger or
          centred short lines). If the document has none of these, add the sections manually from the outline,
          or re-upload a version whose chapter titles use <em>Heading 1</em> / <em>Heading 2</em>.
        </div>
      )}

      {templateExtractionFailed && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">
          <strong>Template analysis failed.</strong>{' '}
          {latestTemplateJob?.errorMessage?.trim() ||
            'The document could not be read. Download it to check it opens correctly, then upload it again.'}
        </div>
      )}

      {/* Map evidence is only offered once an outline exists; explain why. */}
      {hasTemplate && !hasSections && !templateStillProcessing && !templateProducedNoSections && !templateExtractionFailed && (
        <div className="mb-3 rounded-md border border-ink-200 bg-ink-50 px-4 py-2 text-sm text-ink-700">
          <strong>Map evidence</strong> becomes available once the template has produced an outline.
        </div>
      )}

      {hasSections && !hasSources && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Add at least one source document (PDF, DOCX, TXT or an image) so there is something to map onto the outline.
        </div>
      )}

      {showManualHints && hasSections && hasSources && noSourcesWithText && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Your sources exist but none has been read yet, so mapping would find no evidence. Wait for extraction to
          finish, or use <strong>Retry extraction</strong> on any source that failed.
        </div>
      )}

      {actionRequired === 'no-provider' && (
        <div
          className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900"
          data-testid="banner-no-provider"
        >
          <strong>No AI provider is configured.</strong> Your template and sources are ready, but drafting
          cannot run without a model. Add your own provider and API key in{' '}
          <Link to="/settings/providers" className="font-medium underline">
            Settings → AI providers
          </Link>
          , then press Scan &amp; generate.
        </div>
      )}

      {actionRequired === 'scan' && (
        <div
          className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
          data-testid="banner-scan"
        >
          {hasMapping
            ? 'Your sources are matched to the outline, but no section has been written yet.'
            : 'Your template and sources are ready.'}{' '}
          Press <strong>Scan &amp; generate</strong> above to read the template, match sources to each
          section and draft the whole report in one go.
        </div>
      )}

      {showManualHints && hasSections && hasSources && !hasMapping && !mappingFailed && !inFlightMapping && providerCount !== 0 && !neverGenerated && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Press <strong>Scan &amp; generate</strong> above to read the template, match sources to each section and
          draft the whole report in one go.
        </div>
      )}

      {inFlightMapping && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-800">
          Mapping evidence to sections… this continues in the background, you can keep working.
        </div>
      )}

      {mappingFailed && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <strong>Mapping evidence failed.</strong>{' '}
              {latestMappingJob?.errorMessage?.trim() ||
                'The job failed without a message. Check the server logs for details.'}
            </div>
            <button
              type="button"
              className="btn-secondary shrink-0 text-xs"
              onClick={() => void buildMapping()}
              disabled={busy || !hasSections}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[minmax(340px,420px)_1fr]">
        <ChatPanel
          projectId={projectId}
          providers={providers}
          context={{
            hasTemplate,
            hasSources,
            hasProvider: providerCount !== 0,
            drafted: draftedCount,
            total: totalSections,
            emptyHeadings,
            headings: (outline ?? []).map((section) => section.heading),
            instructions: project?.instructions ?? null,
            busy,
            pdfAvailable,
            exportReady: (exports ?? []).some((entry) => entry.status === 'ready'),
          }}
          selectedProviderId={selectedProviderId}
          onSelectProvider={(credentialId) => {
            setSelectedProviderId(credentialId);
            writeStoredModel(projectId, credentialId);
          }}
          onOpenSettings={() => navigate('/settings/providers')}
          onOpenSources={() => setSourcesOpen(true)}
          onOpenOutline={() => setOutlineOpen(true)}
          onRunPipeline={runPipelineForChat}
          onExport={exportForChat}
          onChanged={() => {
            void loadAll();
            polling.refresh();
          }}
        />

        <section
          className="card overflow-hidden"
          aria-label={tab === 'export' ? 'Export' : 'Document preview'}
        >
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
          ) : (
            <PreviewPane
              projectId={projectId}
              refreshToken={previewToken}
              onDownload={() => setTab('export')}
              draftState={{ drafted: draftedCount, total: totalSections }}
            />
          )}
        </section>
      </div>

      {/* Everything that is not conversation or the document lives in a drawer. */}
      <Drawer
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        title="Sources"
        description="Files this report is written from. Archives are expanded automatically."
        width="w-full max-w-xl"
      >
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
      </Drawer>

      <Drawer
        open={outlineOpen}
        onClose={() => setOutlineOpen(false)}
        title="Outline"
        description="Pick a section to read or edit what was written for it."
        width="w-full max-w-2xl"
      >
        <OutlinePane
          projectId={projectId}
          outline={outline}
          reports={reports}
          mappings={mappings}
          selectedId={selectedId}
          onSelect={(sectionId) => {
            setSelectedId(sectionId);
            // Selecting a section is a request to edit it, so show the editor
            // beside the outline inside the same drawer rather than hiding it.
          }}
          onRegenerateAll={() => void regenerateAll()}
          onChanged={() => void loadAll()}
          busy={busy}
          hasMapping={hasMapping}
          hasTemplate={hasTemplate}
        />
        {selectedId && (
          <div className="border-t border-ink-200" aria-label="Section editor" role="region">
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
          </div>
        )}
      </Drawer>
    </div>
  );
}
