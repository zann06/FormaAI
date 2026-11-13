/**
 * The one-click pipeline job.
 *
 * Until now a user had to upload a template, wait, upload sources, wait, click
 * "Map evidence", wait, click "Draft all sections", wait, then go to the export
 * tab. That is a lot of waiting and clicking for a task whose expected shape is
 * "give me the report". This runs the whole chain as *one* job so the UI can
 * show a single progress bar and, on failure, one precise reason.
 *
 * Each step is skipped when it cannot run (for example, mapping needs a usable
 * outline, drafting needs a configured provider). Skips are reported in the
 * result rather than silently producing a half-empty report.
 */
import type { AuthContext } from '../auth/index.js';
import type { AllServices } from './runtime.js';

/**
 * Turns per-section failures into one actionable sentence.
 *
 * "38 could not be drafted" tells the user nothing they can act on. In the real
 * run every one of those 38 had the same cause — the daily AI request quota — and
 * that fact was recorded on each result and then thrown away. Grouping identical
 * reasons states a shared cause once.
 */
export function describeDraftFailures(results: Array<{ ok: boolean; error?: string }>): string {
  const reasons = new Map<string, number>();
  for (const result of results) {
    if (result.ok) continue;
    const reason = (result.error ?? 'unknown error').trim();
    if (reason.length === 0) continue;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  if (reasons.size === 0) return '';
  return ` Reason: ${[...reasons]
    .map(([reason, count]) => `${count} × ${reason.replace(/\.$/, '')}`)
    .join('; ')}.`;
}

export interface PipelineOptions {
  useAi?: boolean;
  providerCredentialId?: string;
  exportFormats?: Array<'docx' | 'pdf'>;
  regenerateExisting?: boolean;
}

export interface PipelineStep {
  name: 'analyze' | 'map' | 'draft' | 'export';
  status: 'done' | 'skipped' | 'failed';
  detail: string;
  /** Human-readable explanation shown in the UI. */
  message: string;
}

export interface PipelineOutcome {
  steps: PipelineStep[];
  sections: number;
  drafted: number;
  failedSections: number;
  exports: Array<{ format: 'docx' | 'pdf'; exportId: string | null; status: string; message?: string }>;
  /** Short, honest summary suitable for a toast. */
  summary: string;
}

export type MarkStage = (stage: string, progress: number) => Promise<void>;

export async function runPipeline(
  services: AllServices,
  ctx: AuthContext,
  projectId: string,
  jobId: string,
  options: PipelineOptions,
  markStage: MarkStage,
): Promise<PipelineOutcome> {
  const steps: PipelineStep[] = [];
  const exports: PipelineOutcome['exports'] = [];
  let sections = 0;
  let drafted = 0;
  let failedSections = 0;

  // ---- 1. Analyse the template -------------------------------------------
  await markStage('analyzing template', 10);
  const latestTemplate = await services.template.latestTemplateJob(ctx, projectId);
  let sectionRows = await services.template.listSections(ctx, projectId).catch(() => []);
  if (sectionRows.length === 0) {
    // No outline yet: run the analysis now instead of failing the whole chain.
    const templateDocumentId = latestTemplate?.documentId ?? null;
    if (templateDocumentId) {
      try {
        await services.template.analyzeAndStore(ctx, projectId, templateDocumentId);
        sectionRows = await services.template.listSections(ctx, projectId).catch(() => []);
      } catch (error) {
        steps.push({
          name: 'analyze',
          status: 'failed',
          detail: (error as Error).message.slice(0, 500),
          message: 'The template could not be analysed.',
        });
        return summarize('Template analysis failed, so nothing else could run.', steps, 0, 0, 0, exports);
      }
    }
  }
  sections = sectionRows.filter((section) => !section.excluded).length;
  if (sections === 0) {
    steps.push({
      name: 'analyze',
      status: 'failed',
      detail: 'no sections',
      message: 'No sections were detected in this template.',
    });
    return summarize(
      'No sections were detected in the template. Add sections in the outline and try again.',
      steps,
      0,
      0,
      0,
      exports,
    );
  }
  steps.push({
    name: 'analyze',
    status: 'done',
    detail: `${sections} sections`,
    message: `Outline ready with ${sections} section${sections === 1 ? '' : 's'}.`,
  });

  // ---- 2. Map evidence ----------------------------------------------------
  await markStage('mapping evidence', 25);
  const sources = await services.documents.list(ctx, projectId);
  const usableSources = sources.filter(
    (document) => document.kind === 'source' && document.status === 'extracted',
  );
  if (usableSources.length === 0) {
    steps.push({
      name: 'map',
      status: 'skipped',
      detail: 'no extracted sources',
      message: 'No source documents finished extracting, so there was nothing to map.',
    });
    steps.push({
      name: 'draft',
      status: 'skipped',
      detail: 'no evidence',
      message: 'Drafting was skipped because there was no evidence to draft from.',
    });
    return summarize(
      'Sources are still processing or failed. Nothing was drafted because there is no evidence yet.',
      steps,
      sections,
      0,
      0,
      exports,
    );
  }

  const mapping = await services.mapping.buildMappings(ctx, projectId, {
    useAi: options.useAi ?? true,
    providerCredentialId: options.providerCredentialId,
    jobId,
  });
  const mapped = mapping.mappings.filter((row) => (row.evidence?.length ?? 0) > 0).length;
  steps.push({
    name: 'map',
    status: 'done',
    detail: `${mapped}/${mapping.mappings.length} sections with evidence (${mapping.producedBy})`,
    message:
      mapped === 0
        ? 'Mapping ran but found no evidence that matched any section.'
        : `${mapped} of ${mapping.mappings.length} sections have supporting evidence.`,
  });

  // ---- 3. Draft every section --------------------------------------------
  await markStage('drafting sections', 40);
  const draft = await services.generation.generateMany(
    ctx,
    projectId,
    {
      providerCredentialId: options.providerCredentialId,
      regenerateExisting: options.regenerateExisting ?? false,
      jobId,
    },
    async (done, total) => {
      const percent = 40 + Math.round((done / Math.max(1, total)) * 40);
      await markStage(`drafting ${done}/${total}`, Math.min(percent, 80));
    },
  );
  drafted = draft.generated;
  failedSections = draft.failed;
  if (draft.generated === 0 && draft.failed > 0) {
    const firstError = draft.results.find((result) => !result.ok)?.error ?? 'All sections failed';
    steps.push({
      name: 'draft',
      status: 'failed',
      detail: firstError.slice(0, 500),
      message: `Drafting failed: ${firstError}`,
    });
    return summarize(`Drafting failed: ${firstError}`, steps, sections, 0, draft.failed, exports);
  }
  // Sections beyond the per-job cap were never attempted. Saying "Drafted 40
  // sections." while 4 were quietly dropped made a truncated report look finished.
  const deferredNote =
    draft.deferred.length > 0
      ? ` ${draft.deferred.length} more section${draft.deferred.length === 1 ? ' was' : 's were'} not attempted because this job is limited to ${draft.results.length} sections per run (${draft.deferred
          .map((section) => section.heading)
          .join(', ')}). Press Scan & generate again to continue.`
      : '';
  // Cover lines and rubric sheets keep the template's own text: saying they were
  // "drafted" would claim the generator wrote the cover, which it never did.
  const keptNote =
    draft.keptTemplateText.length > 0
      ? ` ${draft.keptTemplateText.length} section${draft.keptTemplateText.length === 1 ? ' is' : 's are'} template text (cover or form) and kept as-is.`
      : '';
  // Why the failures happened, not only how many.
  //
  // "38 could not be drafted" is unactionable: in the real run every one of those
  // 38 was the same cause (the daily AI request quota), and the user had no way to
  // see that. Identical reasons are grouped so one cause is stated once.
  const failureNote = describeDraftFailures(draft.results);
  steps.push({
    name: 'draft',
    status: draft.generated > 0 ? 'done' : 'skipped',
    detail: `${draft.generated} drafted, ${draft.failed} failed, ${draft.deferred.length} deferred, ${draft.keptTemplateText.length} kept as template`,
    message:
      draft.generated > 0
        ? `Drafted ${draft.generated} section${draft.generated === 1 ? '' : 's'}` +
          (draft.failed > 0 ? `, ${draft.failed} could not be drafted.${failureNote}` : '.') +
          keptNote +
          deferredNote
        : draft.deferred.length > 0
          ? `The section limit was reached before any section was drafted.${deferredNote}`
          : keptNote
            ? `Nothing needed drafting.${keptNote}`
            : 'Nothing needed drafting (all sections already had content).',
  });

  // ---- 4. Optional exports ------------------------------------------------
  const formats = options.exportFormats ?? [];
  if (formats.length > 0) {
    await markStage('exporting', 85);
    // A PDF is converted *from* a DOCX, so when both are requested build the
    // DOCX once and reuse it. Building one per format produced two identical
    // DOCX files in the export list, which looked like duplicated work.
    let sharedDocx: { id: string; assembled: boolean } | null = null;
    for (const format of formats) {
      try {
        if (format === 'docx') {
          const artifact = await services.exports.createExport(ctx, projectId, 'docx');
          await services.exports.assemble(ctx, artifact.id);
          sharedDocx = { id: artifact.id, assembled: true };
          exports.push({ format: 'docx', exportId: artifact.id, status: 'ready' });
        } else {
          if (!sharedDocx) {
            const docxArtifact = await services.exports.createExport(ctx, projectId, 'docx');
            await services.exports.assemble(ctx, docxArtifact.id);
            sharedDocx = { id: docxArtifact.id, assembled: true };
          }
          const pdfArtifact = await services.exports.createExport(ctx, projectId, 'pdf');
          await services.exports.convertToPdf(ctx, pdfArtifact.id, sharedDocx.id);
          exports.push({ format: 'pdf', exportId: pdfArtifact.id, status: 'ready' });
        }
      } catch (error) {
        exports.push({
          format,
          exportId: null,
          status: 'failed',
          message: (error as Error).message.slice(0, 300),
        });
      }
    }
    const ready = exports.filter((entry) => entry.status === 'ready');
    // An export that failed purely because some sections have no source is a
    // *note*, not a broken pipeline: the rest of the report is finished and the
    // user needs to know which sections to fill in, not that "the scan failed".
    const blockingMessage = exports[0]?.message ?? '';
    const onlyMissingSections = /still empty/i.test(blockingMessage);
    steps.push({
      name: 'export',
      status: ready.length > 0 ? 'done' : onlyMissingSections ? 'skipped' : 'failed',
      detail: exports.map((entry) => `${entry.format}:${entry.status}`).join(', '),
      message:
        ready.length > 0
          ? `Exported ${ready.map((entry) => entry.format.toUpperCase()).join(' and ')}.`
          : onlyMissingSections
            ? `Files were not built yet: ${blockingMessage}`
            : `Export failed: ${exports[0]?.message ?? 'unknown error'}`,
    });
  }

  // Sections with no evidence keep an explicit placeholder. Report them as a
  // note so the summary never implies a complete report when a few sections are
  // still waiting for source material.
  const unmapped = mapping.mappings.filter((row) => (row.evidence?.length ?? 0) === 0).length;

  // A section can map fine and still contain a gap marker, because the model
  // flagged a value nothing could supply (a reading nobody recorded, a date). The
  // marker is exported verbatim, so a report could claim "44 of 44 drafted" while
  // the shipped file still asks to be completed.
  const unfilled = draft.unfilledDetails;

  // Derived figures are different: the report did the work, but a computed number
  // should still be checked before submission. Say so without calling it a gap.
  const computed = draft.computedDetails;

  return summarize(
    `Drafted ${drafted} of ${sections} section${sections === 1 ? '' : 's'} from ${usableSources.length} source${
      usableSources.length === 1 ? '' : 's'
    }.` +
      (unmapped > 0
        ? ` ${unmapped} section${unmapped === 1 ? '' : 's'} had no matching source material and ${unmapped === 1 ? 'is' : 'are'} left with a [MISSING] note — add evidence or mark ${unmapped === 1 ? 'it' : 'them'} not required.`
        : '') +
      (computed > 0
        ? ` ${computed} figure${computed === 1 ? '' : 's'} ${computed === 1 ? 'was' : 'were'} computed by the assistant and ${computed === 1 ? 'is' : 'are'} tagged "(dihitung)" — verify ${computed === 1 ? 'it' : 'them'} against your own working.`
        : '') +
      (unfilled > 0
        ? ` ${unfilled} value${unfilled === 1 ? '' : 's'} could not be derived and ${unfilled === 1 ? 'is' : 'are'} marked [PERLU DICEK] in the document — fill ${unfilled === 1 ? 'it' : 'them'} before submitting.`
        : ''),
    steps,
    sections,
    drafted,
    failedSections,
    exports,
  );
}

function summarize(
  summary: string,
  steps: PipelineStep[],
  sections: number,
  drafted: number,
  failedSections: number,
  exports: PipelineOutcome['exports'],
): PipelineOutcome {
  return { steps, sections, drafted, failedSections, exports, summary };
}
