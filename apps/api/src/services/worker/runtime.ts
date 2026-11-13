import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import { JobService } from '../jobs/index.js';
import { DocumentService } from '../documents/index.js';
import { TemplateService } from '../template/index.js';
import { FactService } from '../facts/index.js';
import { CredentialService } from '../credentials/index.js';
import { AuthService } from '../auth/index.js';
import { MappingService } from '../mapping/index.js';
import { GenerationService } from '../generation/index.js';
import { ExportService } from '../export/index.js';
import { UsageService } from '../usage/index.js';
import { extractDocx, extractImage, extractPdf, extractTxt } from '../extraction/index.js';
import type { OcrImageFormat } from '../extraction/index.js';
import { isOcrConfigured } from '../extraction/ocr.js';
import type { StorageAdapter } from '../storage/index.js';
import type { ProviderRegistry } from '@formaai/ai-providers';
import type { SafeLogger } from '../../lib/logger.js';
import { ApiErrorWithCode } from './errors.js';
import { runPipeline } from './pipeline.js';
import { AppError } from '../../lib/errors.js';

export interface WorkerServices {
  db: Database;
  config: AppConfig;
  storage: StorageAdapter;
  registry: ProviderRegistry;
  logger: SafeLogger;
  documents: DocumentService;
  template: TemplateService;
  facts: FactService;
  mapping: MappingService;
  generation: GenerationService;
  exports: ExportService;
  usage: UsageService;
  jobs: JobService;
  credentials: CredentialService;
}

export function createServices(input: {
  db: Database;
  config: AppConfig;
  storage: StorageAdapter;
  registry: ProviderRegistry;
  logger: SafeLogger;
}): WorkerServices {
  const { db, config, storage, registry, logger } = input;
  const jobs = new JobService(db, config.JOB_MAX_ATTEMPTS);
  const documents = new DocumentService(db, storage, {
    maxBytes: config.MAX_FILE_MB * 1024 * 1024,
    userQuotaBytes: config.USER_STORAGE_QUOTA_MB * 1024 * 1024,
  });
  const template = new TemplateService(db);
  const facts = new FactService(db);
  const usage = new UsageService(db);
  const credentials = new CredentialService(db, config, registry);
  const mapping = new MappingService(db, config, credentials, facts, registry);
  const generation = new GenerationService(db, config, credentials, mapping, usage, facts, registry);
  const exports = new ExportService(db, storage, config);
  return {
    db,
    config,
    storage,
    registry,
    logger,
    documents,
    template,
    facts,
    mapping,
    generation,
    exports,
    usage,
    jobs,
    credentials,
  };
}

export type AllServices = ReturnType<typeof createServices>;

/**
 * Maps a stored MIME type (falling back to the original filename) to the OCR
 * image format. Every extension the upload validator accepts has an entry, so
 * no accepted image can fall through to the text extractor and fail.
 */
function imageFormatFor(mimeType: string, originalName: string): OcrImageFormat {
  const byMime: Record<string, OcrImageFormat> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
    'image/gif': 'gif',
  };
  const fromMime = byMime[mimeType.toLowerCase()];
  if (fromMime) return fromMime;
  const extension = originalName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const byExtension: Record<string, OcrImageFormat> = {
    '.png': 'png',
    '.jpg': 'jpeg',
    '.jpeg': 'jpeg',
    '.webp': 'webp',
    '.tif': 'tiff',
    '.tiff': 'tiff',
    '.bmp': 'bmp',
    '.gif': 'gif',
  };
  return byExtension[extension] ?? 'png';
}

/** Runs one job to completion. Used by the worker loop and by tests. */
export async function executeJob(services: AllServices, jobId: string): Promise<void> {
  const { db, logger } = services;
  const { processingJobs, projects } = await import('../../db/schema.js');
  const { and, eq } = await import('drizzle-orm');

  const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId)).limit(1);
  if (!job || job.status !== 'running') return;

  const ctx: AuthContext = { userId: job.userId, email: '', role: 'user' };
  const markStage = async (stage: string, progress: number) => {
    await db
      .update(processingJobs)
      .set({
        stage,
        progress,
        stageEvents: [...(job.stageEvents ?? []), { stage, at: new Date().toISOString(), progress }],
        updatedAt: new Date(),
      })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, 'running')));
  };

  try {
    switch (job.kind) {
      case 'extract_document': {
        const payload = job.payload as { documentId: string };
        await markStage('loading', 10);
        const doc = await services.documents.getOwned(ctx, payload.documentId);
        await services.documents.markStatus(doc.id, ctx.userId, { status: 'extracting' });
        const bytes = await services.storage.get(doc.storageKey);
        await markStage('extracting', 40);
        let result;
        if (doc.mimeType === 'application/pdf') {
          result = await extractPdf(bytes, { maxPdfPages: services.config.MAX_PDF_PAGES, ocrEnabled: isOcrConfigured() });
        } else if (doc.mimeType.includes('wordprocessingml')) {
          result = await extractDocx(bytes);
        } else if (doc.mimeType.startsWith('image/')) {
          result = await extractImage(bytes, imageFormatFor(doc.mimeType, doc.originalName), {
            ocrEnabled: isOcrConfigured(),
            nameHint: doc.originalName.replace(/\.[^.]+$/, '') || 'image',
          });
        } else {
          result = extractTxt(bytes);
        }
        await markStage('indexing', 75);
        const chunks = result.units
          .filter((unit) => unit.text.trim().length > 0)
          .map((unit) => ({
            text: unit.text,
            page: unit.page,
            paragraphIndex: unit.paragraphIndex,
            headingPath: unit.headingPath,
          }));
        if (chunks.length === 0) {
          const message =
            result.warnings.join(' ') || 'No extractable text was found in this document.';
          await services.documents.markStatus(doc.id, ctx.userId, {
            status: 'failed',
            extractionError: message,
            extractionMethod: result.method,
          });
          // An image without OCR is a configuration problem, not an empty file.
          // Say so explicitly so the user can fix it instead of guessing.
          throw new ApiErrorWithCode(
            result.needsOcr ? 'OCR_NOT_CONFIGURED' : 'EXTRACTION_EMPTY',
            message,
          );
        }
        await services.documents.replaceChunks(ctx, doc.projectId, doc.id, chunks);
        const wordCount = chunks.reduce((sum, chunk) => sum + chunk.text.split(/\s+/).filter(Boolean).length, 0);
        await services.documents.markStatus(doc.id, ctx.userId, {
          status: 'extracted',
          extractionMethod: result.method,
          extractionError: result.warnings.length ? result.warnings.join('\n').slice(0, 2000) : null,
          extractedAt: new Date(),
          pageCount: result.pageCount,
          wordCount,
          chunkCount: chunks.length,
          metadata: { warnings: result.warnings, needsOcr: result.needsOcr },
        });
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({ result: { chunks: chunks.length, pageCount: result.pageCount, method: result.method } })
          .where(eq(processingJobs.id, jobId));
        await services.facts.rebuildForProject(ctx, doc.projectId);
        break;
      }
      case 'analyze_template': {
        const payload = job.payload as { documentId: string };
        await markStage('parsing', 20);
        const result = await services.template.analyzeAndStore(ctx, job.projectId, payload.documentId);
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({ result: { sections: result.sections.length } })
          .where(eq(processingJobs.id, jobId));
        if (result.sections.length === 0) {
          logger.warn('Template has no detectable headings', { jobId, documentId: payload.documentId });
        }
        break;
      }
      case 'map_evidence': {
        const payload = job.payload as { useAi?: boolean; providerCredentialId?: string };
        await markStage('retrieving', 30);
        const result = await services.mapping.buildMappings(ctx, job.projectId, {
          useAi: payload.useAi ?? true,
          providerCredentialId: payload.providerCredentialId,
          jobId,
        });
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({
            result: {
              sections: result.mappings.length,
              producedBy: result.producedBy,
              note: result.note ?? null,
            },
            fallbackUsed: result.fallbackUsed,
          })
          .where(eq(processingJobs.id, jobId));
        break;
      }
      case 'generate_section': {
        const payload = job.payload as { sectionId: string; instructions?: string; providerCredentialId?: string; keepEdits?: boolean };
        await markStage('generating', 30);
        const result = await services.generation.generateSection(ctx, job.projectId, payload.sectionId, {
          instructions: payload.instructions,
          providerCredentialId: payload.providerCredentialId,
          keepEdits: payload.keepEdits,
          jobId,
        });
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({ result: { sectionId: result.sectionId, words: result.wordCount }, fallbackUsed: result.fallbackUsed })
          .where(eq(processingJobs.id, jobId));
        break;
      }
      case 'generate_all': {
        const payload = job.payload as { sectionIds?: string[]; providerCredentialId?: string; regenerateExisting?: boolean };
        const result = await services.generation.generateMany(
          ctx,
          job.projectId,
          {
            sectionIds: payload.sectionIds,
            providerCredentialId: payload.providerCredentialId,
            regenerateExisting: payload.regenerateExisting,
            jobId,
          },
          async (done, total, heading) => {
            await markStage(`generating: ${heading}`.slice(0, 60), Math.round((done / Math.max(1, total)) * 100));
          },
        );
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({ result: { generated: result.generated, failed: result.failed, details: result.results } })
          .where(eq(processingJobs.id, jobId));
        if (result.generated === 0 && result.failed > 0) {
          const firstError = result.results.find((r) => !r.ok)?.error ?? 'All sections failed';
          throw new ApiErrorWithCode('GENERATION_FAILED', firstError);
        }
        break;
      }
      case 'run_pipeline': {
        const payload = job.payload as {
          useAi?: boolean;
          providerCredentialId?: string;
          exportFormats?: Array<'docx' | 'pdf'>;
          regenerateExisting?: boolean;
        };
        await markStage('starting', 5);
        const outcome = await runPipeline(services, ctx, job.projectId, jobId, payload, markStage);
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({
            result: {
              summary: outcome.summary,
              steps: outcome.steps,
              sections: outcome.sections,
              drafted: outcome.drafted,
              failedSections: outcome.failedSections,
              exports: outcome.exports,
            },
          })
          .where(eq(processingJobs.id, jobId));
        // Surface a genuine failure instead of a green "succeeded" with no text.
        const failedStep = outcome.steps.find((step) => step.status === 'failed');
        if (failedStep) {
          throw new ApiErrorWithCode('PIPELINE_FAILED', `${failedStep.message}`, {
            summary: outcome.summary,
            steps: outcome.steps,
            exports: outcome.exports,
          });
        }
        break;
      }
      case 'assemble_docx': {
        const payload = job.payload as { exportId: string };
        await markStage('assembling', 40);
        const result = await services.exports.assemble(ctx, payload.exportId);
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({
            result: {
              exportId: payload.exportId,
              fidelity: result.fidelity as unknown as Record<string, unknown>,
              warnings: result.warnings,
              missingCoverFields: result.missingCoverFields,
            },
          })
          .where(eq(processingJobs.id, jobId));
        break;
      }
      case 'convert_pdf': {
        const payload = job.payload as { exportId: string; docxExportId: string };
        await markStage('converting', 50);
        await services.exports.convertToPdf(ctx, payload.exportId, payload.docxExportId);
        await markStage('done', 100);
        break;
      }
      case 'cleanup': {
        const auth = new AuthService(db, services.config);
        const removedSessions = await auth.purgeExpiredSessions();
        const removedExports = await services.exports.deleteExpired();
        await db
          .update(processingJobs)
          .set({ result: { removedSessions, removedExports } })
          .where(eq(processingJobs.id, jobId));
        break;
      }
      default:
        throw new ApiErrorWithCode('UNKNOWN_JOB', `Unknown job kind: ${job.kind}`);
    }
    await db
      .update(processingJobs)
      .set({ status: 'succeeded', progress: 100, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(processingJobs.id, jobId));
  } catch (error) {
    const code = error instanceof ApiErrorWithCode ? error.code : 'JOB_FAILED';
    const message = (error as Error).message.slice(0, 2000);
    const attempts = job.attempts + 1;
    // A rejected precondition (no sections, unsupported file, missing converter)
    // cannot fix itself between attempts. Retrying it only multiplied the
    // "failed" rows and made a single mistake look like a recurring crash.
    const retryable =
      !(error instanceof AppError) ||
      error.status >= 500 ||
      error.code === 'RATE_LIMITED' ||
      error.code === 'QUOTA_EXCEEDED';
    const willRetry = retryable && attempts < job.maxAttempts;
    await db
      .update(processingJobs)
      .set({
        status: willRetry ? 'queued' : 'failed',
        errorCode: code,
        errorMessage: message,
        attempts,
        finishedAt: willRetry ? null : new Date(),
        updatedAt: new Date(),
        // Keep any structured context the step reported, so the UI can list what
        // did and did not happen instead of showing one opaque line.
        ...(error instanceof ApiErrorWithCode && error.details
          ? { result: error.details as Record<string, unknown> }
          : {}),
      })
      .where(eq(processingJobs.id, jobId));
    if (job.kind === 'extract_document') {
      const payload = job.payload as { documentId: string };
      if (!willRetry) {
        await services.documents.markStatus(payload.documentId, job.userId, {
          status: 'failed',
          extractionError: message,
        });
      }
    }
    if (job.kind === 'analyze_template' && !willRetry) {
      // Uploading a template parks the project on "processing" while analysis
      // runs. If that analysis never succeeds, nothing else will move it, so the
      // project would show "Processing" forever. Mark it failed instead.
      await db
        .update(projects)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(and(eq(projects.id, job.projectId), eq(projects.userId, job.userId)));
    }
    if (job.kind === 'generate_section' && !willRetry) {
      // The single-section path used to leave the section empty with no reason
      // stored, exactly like the reported 5.2. Record the reason on the section so
      // the outline and the export both explain it.
      const payload = job.payload as { sectionId?: string };
      if (payload.sectionId) {
        try {
          await services.generation.recordDraftFailure(ctx, job.projectId, payload.sectionId, message);
        } catch {
          // Never mask the original job failure.
        }
      }
    }
    logger.error('Job failed', { jobId, kind: job.kind, code, attempts });
    if (!willRetry) throw error;
  }
}
