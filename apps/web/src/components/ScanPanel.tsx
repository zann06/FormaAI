import { useMemo } from 'react';
import type { JobLike } from '../lib/useJobPolling';

/**
 * The one-click "Scan & generate" card.
 *
 * The expected flow is: drop in a template and a source, press one button, get
 * a report. Everything before this card's introduction needed three separate
 * clicks and three progress bars, so the user had no single place to see how
 * far along the work was or what went wrong.
 *
 * This shows the four pipeline steps, their live status, and — when something
 * fails — exactly which step and why, instead of one opaque error.
 */

type StepName = 'analyze' | 'map' | 'draft' | 'export';

const STEP_LABELS: Record<StepName, string> = {
  analyze: 'Read the template outline',
  map: 'Match evidence to each section',
  draft: 'Write every section',
  export: 'Build the DOCX and PDF',
};

const STEP_ORDER: StepName[] = ['analyze', 'map', 'draft', 'export'];

interface PipelineStepResult {
  name: StepName;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
  message?: string;
}

/** Reads the structured step report the API stores on the job. */
export function readPipelineReport(job: JobLike | null): {
  steps: PipelineStepResult[];
  summary: string | null;
  exports: Array<{ format: string; exportId: string | null; status: string; message?: string }>;
} {
  const result = job?.result ?? {};
  const steps = Array.isArray(result.steps) ? (result.steps as PipelineStepResult[]) : [];
  const summary = typeof result.summary === 'string' ? result.summary : null;
  const exports = Array.isArray(result.exports)
    ? (result.exports as Array<{ format: string; exportId: string | null; status: string; message?: string }>)
    : [];
  return { steps, summary, exports };
}

/** Maps the worker's free-form `stage` text onto a pipeline step. */
function stepFromStage(stage: string | null | undefined): StepName | null {
  if (!stage) return null;
  const value = stage.toLowerCase();
  if (value.includes('analy')) return 'analyze';
  if (value.includes('map') || value.includes('retriev')) return 'map';
  if (value.includes('draft') || value.includes('generat')) return 'draft';
  if (value.includes('export') || value.includes('assembl') || value.includes('convert')) return 'export';
  return null;
}

export function ScanPanel({
  job,
  onStart,
  disabled,
  disabledReason,
  canExport,
  includeExports,
  onToggleExports,
  hasTemplate,
  hasSources,
  extractingCount,
  hasReadableSource,
}: {
  job: JobLike | null;
  onStart: () => void;
  disabled: boolean;
  disabledReason: string | null;
  canExport: boolean;
  includeExports: boolean;
  onToggleExports: (value: boolean) => void;
  hasTemplate: boolean;
  hasSources: boolean;
  extractingCount: number;
  /** At least one source finished extracting, so there is evidence to use. */
  hasReadableSource: boolean;
}) {
  const report = useMemo(() => readPipelineReport(job), [job]);
  const running = job?.status === 'running' || job?.status === 'queued';
  const failed = job?.status === 'failed';
  const succeeded = job?.status === 'succeeded';
  const currentStep = running ? stepFromStage(job?.stage) : null;

  // While running we only know the current stage; fill earlier steps as done.
  const progressIndex = currentStep ? STEP_ORDER.indexOf(currentStep) : -1;
  const progressPercent = running
    ? Math.max(6, Math.min(99, (job as unknown as { progress?: number })?.progress ?? 10))
    : succeeded
      ? 100
      : 0;

  const stepState = (name: StepName): PipelineStepResult['status'] | 'pending' | 'active' => {
    const recorded = report.steps.find((step) => step.name === name);
    if (recorded) return recorded.status;
    if (!running) return 'pending';
    if (currentStep === name) return 'active';
    const index = STEP_ORDER.indexOf(name);
    if (progressIndex >= 0 && index < progressIndex) return 'done';
    return 'pending';
  };

  const completedCount = report.steps.filter((step) => step.status === 'done').length;

  return (
    <section
      className="card mb-3 p-4"
      aria-label="Scan and generate"
      data-testid="scan-panel"
      data-status={job?.status ?? 'idle'}
      data-progress={progressPercent}
      data-step={job?.stage ?? ''}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900">Scan &amp; generate</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            One click reads your template, matches your sources to every section and writes the report.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={includeExports}
              onChange={(event) => onToggleExports(event.target.checked)}
              disabled={running || !canExport}
              className="h-3.5 w-3.5 rounded border-ink-300"
            />
            Also build DOCX + PDF
            {!canExport && <span className="text-ink-400">(needs template)</span>}
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={onStart}
            disabled={disabled || running}
            title={disabledReason ?? undefined}
            data-testid="scan-start"
          >
            {running ? 'Scanning…' : succeeded || failed ? 'Scan again' : 'Scan & generate'}
          </button>
        </div>
      </div>

      {disabledReason && !running && (
        <p className="mt-2 text-xs text-amber-800" data-testid="scan-blocked">
          {disabledReason}
        </p>
      )}

      {(running || report.steps.length > 0) && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                failed ? 'bg-red-500' : succeeded ? 'bg-emerald-500' : 'bg-brand-500'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <ol className="mt-2 grid gap-1 sm:grid-cols-2" data-testid="scan-steps">
            {STEP_ORDER.filter((name) => name !== 'export' || includeExports || report.steps.some((step) => step.name === 'export')).map(
              (name) => {
                const state = stepState(name);
                const recorded = report.steps.find((step) => step.name === name);
                const icon =
                  state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'skipped' ? '–' : state === 'active' ? '⟳' : '·';
                const tone =
                  state === 'done'
                    ? 'text-emerald-700'
                    : state === 'failed'
                      ? 'text-red-700'
                      : state === 'active'
                        ? 'text-brand-700'
                        : state === 'skipped'
                          ? 'text-amber-700'
                          : 'text-ink-400';
                return (
                  <li key={name} className={`flex items-start gap-1.5 text-xs ${tone}`} data-step-state={`${name}:${state}`}>
                    <span aria-hidden className={`mt-px inline-block w-3 text-center ${state === 'active' ? 'animate-spin' : ''}`}>
                      {icon}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium">{STEP_LABELS[name]}</span>
                      {recorded?.message && <span className="block text-ink-500">{recorded.message}</span>}
                    </span>
                  </li>
                );
              },
            )}
          </ol>
        </div>
      )}

      {running && job?.stage && (
        <p className="mt-2 text-xs text-brand-800" data-testid="scan-stage">
          {job.stage.replace(/^[a-z_]+:/i, (match) => match.replace(':', ' — '))}
        </p>
      )}

      {succeeded && report.summary && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" data-testid="scan-result">
          <strong>Done.</strong> {report.summary}
          {report.exports.length > 0 && (
            <span className="ml-1">
              Files ready: {report.exports.filter((entry) => entry.status === 'ready').map((entry) => entry.format.toUpperCase()).join(', ')}.
            </span>
          )}
        </div>
      )}

      {failed && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900" data-testid="scan-error">
          <strong>Scan stopped.</strong>{' '}
          {job?.errorMessage?.trim() || 'The pipeline failed without a message. Check the server logs.'}
          {report.summary && <span className="mt-1 block text-red-800">{report.summary}</span>}
        </div>
      )}

      {!running && report.steps.length === 0 && !hasTemplate && (
        <p className="mt-2 text-xs text-ink-500">
          Add your <strong>.docx</strong> template and at least one source (PDF, DOCX, TXT, image or .zip), then press Scan.
        </p>
      )}
      {!running && report.steps.length === 0 && hasTemplate && !hasSources && (
        <p className="mt-2 text-xs text-ink-500">Add at least one source so there is something to write from.</p>
      )}
      {!running && report.steps.length === 0 && hasTemplate && hasSources && !hasReadableSource && extractingCount === 0 && (
        <p className="mt-2 text-xs text-amber-800" data-testid="scan-no-text">
          None of your sources could be read, so a scan would have nothing to write from. Retry the failed source or add
          another file.
        </p>
      )}
      {extractingCount > 0 && (
        <p className="mt-2 text-xs text-ink-500">
          Reading {extractingCount} source file{extractingCount === 1 ? '' : 's'}… scanning will use them as soon as they finish.
        </p>
      )}
      {!running && completedCount > 0 && !succeeded && !failed && (
        <p className="mt-2 text-xs text-ink-500">{completedCount} step(s) completed.</p>
      )}
    </section>
  );
}
