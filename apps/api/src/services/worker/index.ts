import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { processingJobs } from '../../db/schema.js';
import type { SafeLogger } from '../../lib/logger.js';
import { executeJob, type AllServices } from './runtime.js';

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs?: number;
  logger: SafeLogger;
}

/**
 * Persistent, database-backed job worker.
 *
 * Jobs are claimed with `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`
 * so several API instances can share one queue safely. Cancelled or deleted jobs
 * are skipped. Completed stage outputs live in their own tables, so re-running a
 * job never loses previous work.
 */
export class JobWorker {
  private running = false;
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly services: AllServices,
    private readonly db: Database,
    private readonly options: WorkerOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.logger.info('Job worker started', { concurrency: this.options.concurrency });
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + 15_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Drains the queue once — used by tests so they never wait on a timer. */
  async runOnce(maxJobs = 25): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxJobs; i += 1) {
      const job = await this.claim();
      if (!job) break;
      await this.execute(job.id);
      processed += 1;
    }
    return processed;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    try {
      while (this.running && this.active < this.options.concurrency) {
        const job = await this.claim();
        if (!job) break;
        void this.execute(job.id);
      }
    } catch (error) {
      this.options.logger.error('Worker loop error', { error: (error as Error).message });
    }
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async execute(jobId: string): Promise<void> {
    this.active += 1;
    try {
      await executeJob(this.services, jobId);
    } catch (error) {
      this.options.logger.error('Job execution error', { jobId, error: (error as Error).message });
    } finally {
      this.active -= 1;
      if (this.running && this.active < this.options.concurrency) {
        // pick up newly queued work promptly
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.loop(), 25);
        this.timer.unref?.();
      }
    }
  }

  private async claim(): Promise<{ id: string } | null> {
    // A job whose payload names a `dependsOnJobId` may only start once that job
    // has succeeded. The dependency was written into the payload but never read,
    // so the PDF job was claimed in the same tick as the DOCX job it converts and
    // failed immediately with "The source DOCX export is not ready" — which left
    // every PDF artifact `pending` and made the preview fall back to stale pages.
    //
    // The dependency is resolved with a LEFT JOIN rather than an EXISTS subquery:
    // `FOR UPDATE SKIP LOCKED` cannot lock rows when the same table is re-read
    // through a correlated subquery, and the claim silently matched nothing —
    // which looked exactly like "the dependency is not ready yet".
    const result = await this.db.execute<{ id: string }>(sql`
      update processing_jobs j
      set status = 'running',
          attempts = j.attempts,
          locked_at = now(),
          started_at = coalesce(j.started_at, now()),
          updated_at = now()
      where j.id = (
        select candidate.id
        from processing_jobs candidate
        left join processing_jobs dependency
          on dependency.id::text = candidate.payload ->> 'dependsOnJobId'
        where candidate.status = 'queued'
          and (
            candidate.payload ->> 'dependsOnJobId' is null
            or dependency.status = 'succeeded'
          )
        order by candidate.created_at asc
        for update of candidate skip locked
        limit 1
      )
      returning j.id
    `);
    const row = result.rows[0];
    return row ? { id: row.id } : null;
  }

  async recoverStaleJobs(staleAfterMs = 10 * 60 * 1000): Promise<void> {    const { JobService } = await import('../jobs/index.js');
    const jobs = new JobService(this.db, this.services.config.JOB_MAX_ATTEMPTS);
    const result = await jobs.recoverStaleJobs(staleAfterMs);
    if (result.requeued || result.failed) {
      this.options.logger.warn('Recovered interrupted jobs', result);
    }
  }
}

void processingJobs;
