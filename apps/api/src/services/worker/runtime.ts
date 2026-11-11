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
import { extractDocx, extractPdf, extractTxt } from '../extraction/index.js';
import { isOcrConfigured } from '../extraction/ocr.js';
import type { StorageAdapter } from '../storage/index.js';
import type { ProviderRegistry } from '@formaai/ai-providers';
import type { SafeLogger } from '../../lib/logger.js';
import { ApiErrorWithCode } from './errors.js';

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

/** Runs one job to completion. Used by the worker loop and by tests. */
export async function executeJob(services: AllServices, jobId: string): Promise<void> {
  const { db, logger } = services;
  const { processingJobs } = await import('../../db/schema.js');
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
          await services.documents.markStatus(doc.id, ctx.userId, {
            status: 'failed',
            extractionError:
              result.warnings.join(' ') || 'No extractable text was found in this document.',
            extractionMethod: result.method,
          });
          throw new ApiErrorWithCode('EXTRACTION_EMPTY', 'No extractable text was found in this document.');
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
      case 'assemble_docx': {
        const payload = job.payload as { exportId: string };
        await markStage('assembling', 40);
        const result = await services.exports.assemble(ctx, payload.exportId);
        await markStage('done', 100);
        await db
          .update(processingJobs)
          .set({ result: { exportId: payload.exportId, fidelity: result.fidelity as unknown as Record<string, unknown> } })
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
    const willRetry = attempts < job.maxAttempts;
    await db
      .update(processingJobs)
      .set({
        status: willRetry ? 'queued' : 'failed',
        errorCode: code,
        errorMessage: message,
        attempts,
        finishedAt: willRetry ? null : new Date(),
        updatedAt: new Date(),
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
    logger.error('Job failed', { jobId, kind: job.kind, code, attempts });
    if (!willRetry) throw error;
  }
}
