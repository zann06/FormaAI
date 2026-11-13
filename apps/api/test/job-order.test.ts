import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { processingJobs } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

/**
 * A PDF export is two jobs: assemble the DOCX, then convert it. The convert job
 * carried a `dependsOnJobId` in its payload, but the worker's claim query never read
 * it, so both jobs were claimed in the same tick and the PDF failed instantly with
 * "The source DOCX export is not ready".
 *
 * Nothing noticed because the DOCX still succeeded and the download route fell back
 * to an older PDF on disk — so exports looked fine in the UI while every fresh PDF
 * artifact sat `pending`, and the preview kept serving stale pages.
 */
let context: TestApp;
let user: TestUser;

beforeAll(async () => {
  context = await createTestApp();
  user = await signUpUser(context.app, 'job-order');
});

// The worker claims the OLDEST queued job regardless of test, so each test starts
// from an empty queue. Without this, a job left over from the previous test is
// claimed instead and the assertions below look like a bug in the claim query.
beforeEach(async () => {
  await context.db.execute(sql`delete from processing_jobs`);
});

afterAll(async () => {
  await context.close();
});

/** Creates a project so job rows have a valid foreign key. */
async function createProject(): Promise<string> {
  const created = await user.client.post('/api/projects', { title: 'Job ordering', reportType: 'laporan' });
  expect(created.status).toBe(201);
  return created.body.project.id as string;
}

async function insertJob(projectId: string, kind: string, payload: Record<string, unknown>, status = 'queued') {
  const [row] = await context.db
    .insert(processingJobs)
    .values({ userId: user.id, projectId, kind, status, payload, maxAttempts: 3 })
    .returning();
  return row!;
}

async function jobStatus(jobId: string): Promise<string> {
  const rows = await context.db.execute<{ status: string }>(
    sql`select status from processing_jobs where id = ${jobId}`,
  );
  return rows.rows[0]!.status;
}

describe('job claim respects dependsOnJobId', () => {
  it('does not start a job whose dependency has not succeeded', async () => {
    const projectId = await createProject();
    const blocker = await insertJob(projectId, 'assemble_docx', { exportId: 'x' }, 'running');
    const dependent = await insertJob(projectId, 'convert_pdf', {
      exportId: 'y',
      docxExportId: 'x',
      dependsOnJobId: blocker.id,
    });

    // Nothing is claimable: the only queued job waits on a dependency that has not
    // finished. Before the fix this job started immediately and failed.
    const claimed = await context.drainQueueOnce();
    expect(claimed).toBe(0);
    expect(await jobStatus(dependent.id)).toBe('queued');
  });

  it('starts the dependent job once the dependency has succeeded', async () => {
    const projectId = await createProject();
    const ready = await insertJob(projectId, 'assemble_docx', { exportId: 'x' }, 'succeeded');
    const dependent = await insertJob(projectId, 'convert_pdf', {
      exportId: 'y',
      docxExportId: 'x',
      dependsOnJobId: ready.id,
    });

    // It must be CLAIMED. What happens next depends on the job itself (here it
    // records a failure because the fake export does not exist, and a retryable
    // failure is re-queued), so assert on `attempts`, which only increases once the
    // job has actually run — not on the final status.
    const claimed = await context.drainQueueOnce();
    expect(claimed).toBe(1);
    const rows = await context.db.execute<{ attempts: number }>(
      sql`select attempts from processing_jobs where id = ${dependent.id}`,
    );
    expect(rows.rows[0]!.attempts).toBeGreaterThan(0);
  });

  it('still runs jobs that declare no dependency', async () => {
    const projectId = await createProject();
    const independent = await insertJob(projectId, 'cleanup', { kind: 'sessions' });

    const claimed = await context.drainQueueOnce();
    expect(claimed).toBe(1);
    expect(await jobStatus(independent.id)).not.toBe('queued');
  });

  it('skips a blocked job and claims the next runnable one', async () => {
    const projectId = await createProject();
    // Inserted FIRST, so it is the oldest — and must still be skipped.
    const blocked = await insertJob(projectId, 'convert_pdf', {
      exportId: 'y',
      docxExportId: 'x',
      dependsOnJobId: '00000000-0000-0000-0000-000000000000',
    });
    const runnable = await insertJob(projectId, 'cleanup', { kind: 'sessions' });

    await context.drainQueueOnce();
    expect(await jobStatus(runnable.id)).not.toBe('queued');
    expect(await jobStatus(blocked.id)).toBe('queued');
  });
});
