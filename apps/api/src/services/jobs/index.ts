import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { processingJobs, projects } from '../../db/schema.js';
import type { AuthContext } from '../auth/index.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';

export type JobKindRow = typeof processingJobs.$inferSelect;

export interface JobPayloads {
  extract_document: { documentId: string };
  analyze_template: { documentId: string };
  map_evidence: { useAi?: boolean; providerCredentialId?: string };
  generate_section: { sectionId: string; instructions?: string; providerCredentialId?: string; keepEdits?: boolean };
  generate_all: { sectionIds?: string[]; providerCredentialId?: string; regenerateExisting?: boolean };
  /**
   * One-click flow: analyse the template, map evidence and draft every section
   * in a single job. Runs as one job so the user sees one progress bar and one
   * failure reason instead of a scatter of per-step jobs.
   */
  run_pipeline: {
    useAi?: boolean;
    providerCredentialId?: string;
    /** Also produce DOCX/PDF exports when drafting finishes. */
    exportFormats?: Array<'docx' | 'pdf'>;
    regenerateExisting?: boolean;
  };
  assemble_docx: { exportId: string };
  convert_pdf: { exportId: string; docxExportId: string; dependsOnJobId?: string };
  cleanup: { kind: 'sessions' | 'exports' | 'credentials' };
}

export class JobService {
  constructor(
    private readonly db: Database,
    private readonly maxAttempts: number,
  ) {}

  async enqueue<K extends keyof JobPayloads>(
    ctx: AuthContext,
    input: {
      projectId: string;
      kind: K;
      payload: JobPayloads[K];
      documentId?: string;
    },
  ) {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!project) throw notFound('Project not found');

    const [job] = await this.db
      .insert(processingJobs)
      .values({
        userId: ctx.userId,
        projectId: input.projectId,
        documentId: input.documentId ?? null,
        kind: input.kind,
        status: 'queued',
        payload: input.payload as Record<string, unknown>,
        maxAttempts: this.maxAttempts,
      })
      .returning();
    if (!job) throw new AppError('INTERNAL', 'Could not queue the job');
    return job;
  }

  async getOwned(ctx: AuthContext, jobId: string) {
    const [row] = await this.db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Job not found');
    return row;
  }

  async listForProject(ctx: AuthContext, projectId: string, limit = 50) {
    return this.db
      .select({
        id: processingJobs.id,
        kind: processingJobs.kind,
        status: processingJobs.status,
        stage: processingJobs.stage,
        progress: processingJobs.progress,
        attempts: processingJobs.attempts,
        errorCode: processingJobs.errorCode,
        errorMessage: processingJobs.errorMessage,
        fallbackUsed: processingJobs.fallbackUsed,
        createdAt: processingJobs.createdAt,
        startedAt: processingJobs.startedAt,
        finishedAt: processingJobs.finishedAt,
        documentId: processingJobs.documentId,
      })
      .from(processingJobs)
      .where(and(eq(processingJobs.projectId, projectId), eq(processingJobs.userId, ctx.userId)))
      .orderBy(sql`${processingJobs.createdAt} desc`)
      .limit(limit);
  }

  async listForUser(ctx: AuthContext, options: { kind?: string; status?: string; limit?: number } = {}) {
    const conditions = [eq(processingJobs.userId, ctx.userId)];
    if (options.kind) conditions.push(eq(processingJobs.kind, options.kind));
    if (options.status) conditions.push(eq(processingJobs.status, options.status));
    return this.db
      .select()
      .from(processingJobs)
      .where(and(...conditions))
      .orderBy(sql`${processingJobs.createdAt} desc`)
      .limit(options.limit ?? 30);
  }

  async cancel(ctx: AuthContext, jobId: string) {
    const job = await this.getOwned(ctx, jobId);
    if (job.status === 'succeeded' || job.status === 'failed') {
      throw conflict('This job has already finished');
    }
    const [row] = await this.db
      .update(processingJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.userId, ctx.userId)))
      .returning();
    return row!;
  }

  async retry(ctx: AuthContext, jobId: string) {
    const job = await this.getOwned(ctx, jobId);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw conflict('Only failed or cancelled jobs can be retried');
    }
    if (job.kind === 'convert_pdf' || job.kind === 'assemble_docx') {
      // Exports are re-created rather than retried to avoid duplicate artifacts
      throw conflict('Create a new export instead of retrying this job');
    }
    const [row] = await this.db
      .update(processingJobs)
      .set({
        status: 'queued',
        attempts: 0,
        errorCode: null,
        errorMessage: null,
        stage: null,
        progress: 0,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.userId, ctx.userId)))
      .returning();
    return row!;
  }

  /**
   * Marks jobs that were left `running` by a crashed process as queued again so a
   * restarted worker picks them up. Jobs already out of attempts fail.
   */
  async recoverStaleJobs(staleAfterMs = 10 * 60 * 1000): Promise<{ requeued: number; failed: number }> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stale = await this.db
      .update(processingJobs)
      .set({ status: 'queued', lockedAt: null, updatedAt: new Date(), stage: 'recovered' })
      .where(and(eq(processingJobs.status, 'running'), lt(processingJobs.lockedAt, cutoff)))
      .returning({ id: processingJobs.id, attempts: processingJobs.attempts, maxAttempts: processingJobs.maxAttempts });

    const exhausted = stale.filter((job) => job.attempts >= job.maxAttempts).map((job) => job.id);
    if (exhausted.length > 0) {
      // tenancy-guard: allow system recovery — ids come from the stale-job query above
      await this.db
        .update(processingJobs)
        .set({
          status: 'failed',
          errorCode: 'WORKER_RESTART',
          errorMessage: 'The worker stopped while this job was running and it exhausted its retries.',
          finishedAt: new Date(),
        })
        .where(sql`${processingJobs.id} = any(${sql.raw(`array['${exhausted.join("','")}']::uuid[]`)})`);
    }
    return { requeued: stale.length - exhausted.length, failed: exhausted.length };
  }
}
