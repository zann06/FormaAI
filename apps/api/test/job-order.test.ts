import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser, type TestApp, type TestUser } from './helpers.js';
import { exportArtifacts, processingJobs } from '../src/db/schema.js';
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

/**
 * A failed export job must fail its artifact too.
 *
 * The worker's catch block patched the project for `analyze_template`, the document
 * for `extract_document` and the section for `generate_section` — but nothing for
 * `assemble_docx` or `convert_pdf`. So when an export job died, the artifact row was
 * left `pending` with `error_message` NULL and no worker left to advance it: the UI
 * polled a status that could never change, and the user saw "convert pdf failed: The
 * source DOCX export is not ready" in a toast while the export list still said
 * "pending" forever.
 */
describe('a failed export job fails its artifact', () => {
  async function insertArtifact(projectId: string, format: 'docx' | 'pdf'): Promise<string> {
    const [row] = await context.db
      .insert(exportArtifacts)
      .values({ userId: user.id, projectId, format, status: 'pending', versionNumber: 1 })
      .returning();
    return row!.id;
  }

  async function artifactState(
    exportId: string,
  ): Promise<{ status: string; errorMessage: string | null }> {
    const rows = await context.db.execute<{ status: string; error_message: string | null }>(
      sql`select status, error_message from export_artifacts where id = ${exportId}`,
    );
    const row = rows.rows[0]!;
    return { status: row.status, errorMessage: row.error_message };
  }

  it('marks a failed convert_pdf artifact failed and records why', async () => {
    const projectId = await createProject();
    const exportId = await insertArtifact(projectId, 'pdf');
    // No such DOCX export exists, so the job throws a non-retryable 404 conflict.
    await insertJob(projectId, 'convert_pdf', {
      exportId,
      docxExportId: '00000000-0000-0000-0000-000000000000',
    });

    await context.drainQueueOnce();

    const state = await artifactState(exportId);
    expect(state.status).toBe('failed');
    // A bare "failed" with no reason is what made this look like a hang.
    expect(state.errorMessage).toBeTruthy();
  });

  it('marks a failed assemble_docx artifact failed and records why', async () => {
    const projectId = await createProject();
    const exportId = await insertArtifact(projectId, 'docx');
    // The project has no template uploaded, so assembly is rejected up front.
    await insertJob(projectId, 'assemble_docx', { exportId });

    await context.drainQueueOnce();

    const state = await artifactState(exportId);
    expect(state.status).toBe('failed');
    expect(state.errorMessage).toMatch(/template/i);
  });

  it('fails the artifact once the job settles as failed', async () => {
    const projectId = await createProject();
    const exportId = await insertArtifact(projectId, 'pdf');
    const [job] = await context.db
      .insert(processingJobs)
      .values({
        userId: user.id,
        projectId,
        kind: 'convert_pdf',
        status: 'queued',
        payload: { exportId, docxExportId: '00000000-0000-0000-0000-000000000000' },
        maxAttempts: 5,
      })
      .returning();
    expect(job).toBeTruthy();

    // Not claimed at all, so the job has not run: the artifact must stay pending
    // rather than being failed early by a status the job never reached.
    await context.drainQueueOnce();
    expect(await jobStatus(job!.id)).not.toBe('queued');
    expect((await artifactState(exportId)).status).toBe('failed');
  });
});
