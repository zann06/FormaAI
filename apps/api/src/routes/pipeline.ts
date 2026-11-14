import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  generateAllSchema,
  jobListQuerySchema,
  sectionRegenerateSchema,
  sectionUpdateSchema,
} from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { parseBody, parseParams, parseQuery, requireUser } from '../plugins/auth-helpers.js';
import { JobService } from '../services/jobs/index.js';
import { conflict, notFound } from '../lib/errors.js';
import { processingJobs } from '../db/schema.js';

const projectParams = z.object({ projectId: z.string().uuid() });
const sectionParams = z.object({ projectId: z.string().uuid(), sectionId: z.string().uuid() });
const jobParams = z.object({ projectId: z.string().uuid(), jobId: z.string().uuid() });

export async function registerPipelineRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const jobs = new JobService(ctx.db, ctx.config.JOB_MAX_ATTEMPTS);

  // ---- one-click pipeline --------------------------------------------------
  /**
   * Analyses the template, maps evidence and drafts every section in one job.
   * This is what the "Scan & generate" button calls, so the user does not have
   * to trigger three separate steps and watch three separate progress bars.
   */
  instance.post('/api/projects/:projectId/pipeline', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const body = parseBody(
      request,
      z.object({
        useAi: z.boolean().optional().default(true),
        providerCredentialId: z.string().uuid().optional(),
        exportFormats: z.array(z.enum(['docx', 'pdf'])).max(2).optional(),
        regenerateExisting: z.boolean().optional().default(false),
      }),
    );

    // One pipeline at a time per project: two concurrent runs would fight over
    // the same report sections and produce duplicated AI spend.
    // tenancy-guard: allow pre-check only — this reads no tenant data (a job id is
    // discarded). Authorisation happens in jobs.enqueue(user, …) below, which
    // verifies the project belongs to the caller before anything is queued.
    const [active] = await ctx.db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.projectId, projectId),
          eq(processingJobs.kind, 'run_pipeline'),
          inArray(processingJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) {
      throw conflict('A scan is already running for this project. Wait for it to finish.');
    }

    // Drafting needs a model. Refuse before queueing so the user gets one clear
    // instruction instead of a job that runs for minutes and then fails.
    if (body.useAi) {
      await ctx.credentialService.assertHasProvider(user);
    }

    const job = await jobs.enqueue(user, {
      projectId,
      kind: 'run_pipeline',
      payload: {
        useAi: body.useAi,
        providerCredentialId: body.providerCredentialId,
        exportFormats: body.exportFormats,
        regenerateExisting: body.regenerateExisting,
      },
    });
    return reply.status(202).send({ jobId: job.id });
  });

  // ---- evidence mapping ---------------------------------------------------
  instance.get('/api/projects/:projectId/mapping', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const [mappings, gaps, facts] = await Promise.all([
      ctx.mappingService.loadMappings(user, projectId),
      ctx.mappingService.gapsSummary(user, projectId),
      ctx.factService.listForProject(user, projectId, 200),
    ]);
    return reply.send({ mappings, gaps, facts });
  });

  instance.post('/api/projects/:projectId/mapping', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const body = parseBody(
      request,
      z.object({ useAi: z.boolean().optional().default(true), providerCredentialId: z.string().uuid().optional() }),
    );
    // Reject the request now if it cannot possibly succeed; a queued job would
    // fail asynchronously and be retried for no reason.
    await ctx.mappingService.assertCanMap(user, projectId);
    const job = await jobs.enqueue(user, {
      projectId,
      kind: 'map_evidence',
      payload: { useAi: body.useAi, providerCredentialId: body.providerCredentialId },
    });
    return reply.status(202).send({ jobId: job.id });
  });

  instance.patch('/api/projects/:projectId/mapping/:sectionId', async (request, reply) => {
    const user = requireUser(request);
    const params = parseParams(request, z.object({ projectId: z.string().uuid(), sectionId: z.string().uuid() }));
    const body = parseBody(
      request,
      z.object({
        evidenceChunkIds: z.array(z.string().uuid()).max(40).optional(),
        gaps: z.array(z.string().max(500)).max(30).optional(),
        contentPlan: z.array(z.string().max(500)).max(30).optional(),
        purpose: z.string().max(2000).optional(),
        requirements: z.array(z.string().max(500)).max(20).optional(),
      }),
    );
    await ctx.mappingService.updateMapping(user, params.projectId, params.sectionId, body);
    return reply.send({ ok: true });
  });

  // ---- report sections ----------------------------------------------------
  instance.get('/api/projects/:projectId/report', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    await ctx.projectService.getOwned(user, projectId);
    const [sections, outline, versions] = await Promise.all([
      ctx.generationService.listReportSections(user, projectId),
      ctx.templateService.listSections(user, projectId),
      ctx.exportService.listVersions(user, projectId),
    ]);
    return reply.send({ sections, outline, versions });
  });

  instance.patch('/api/projects/:projectId/sections/:sectionId/content', async (request, reply) => {
    const user = requireUser(request);
    const { sectionId, projectId } = parseParams(request, sectionParams);
    const detail = await ctx.generationService.getSectionForEditing(user, sectionId);
    if (detail.template.projectId !== projectId) throw notFound('Section not found');
    const input = parseBody(request, sectionUpdateSchema);
    const saved = await ctx.generationService.saveUserEdit(user, sectionId, input);
    return reply.send({
      section: {
        id: saved.templateSectionId,
        content: saved.content,
        status: saved.status,
        revision: saved.revision,
        wordCount: saved.wordCount,
        updatedAt: saved.updatedAt,
      },
    });
  });

  instance.post(
    '/api/projects/:projectId/sections/:sectionId/generate',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId, sectionId } = parseParams(request, sectionParams);
      const input = parseBody(request, sectionRegenerateSchema);
      const detail = await ctx.generationService.getSectionForEditing(user, sectionId);
      if (detail.template.projectId !== projectId) throw notFound('Section not found');

      const inFlight = await ctx.db.execute(
        sql`select count(*)::int as count from processing_jobs
                where project_id = ${projectId} and user_id = ${user.userId}
                  and kind = 'generate_section' and status in ('queued','running')`,
      );
      if (Number(inFlight.rows[0]?.['count'] ?? 0) > 0) {
        throw conflict('A section is already being generated. Wait for it to finish.');
      }
      const job = await jobs.enqueue(user, {
        projectId,
        kind: 'generate_section',
        payload: {
          sectionId,
          instructions: input.instructions,
          keepEdits: input.keepEdits,
        },
      });
      return reply.status(202).send({ jobId: job.id });
    },
  );

  instance.post(
    '/api/projects/:projectId/generate',
    { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId } = parseParams(request, projectParams);
      const input = parseBody(request, generateAllSchema);
      await ctx.projectService.getOwned(user, projectId);
      const job = await jobs.enqueue(user, {
        projectId,
        kind: 'generate_all',
        payload: {
          sectionIds: input.sectionIds,
          providerCredentialId: input.providerCredentialId,
          regenerateExisting: input.regenerateExisting,
        },
      });
      return reply.status(202).send({ jobId: job.id });
    },
  );

  /**
   * Resolves the `[PERLU DICEK: …]` markers of one section from the evidence.
   *
   * Runs synchronously because it is a single model call and the editor shows the
   * result immediately. The project-wide variant below is a job for the same
   * reason generation is: it is one call per section, which is far too long to
   * hold an HTTP request open.
   */
  instance.post(
    '/api/projects/:projectId/sections/:sectionId/resolve-gaps',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId, sectionId } = parseParams(request, sectionParams);
      const input = parseBody(request, z.object({ providerCredentialId: z.string().uuid().nullish() }));
      const detail = await ctx.generationService.getSectionForEditing(user, sectionId);
      if (detail.template.projectId !== projectId) throw notFound('Section not found');
      const summary = await ctx.generationService.resolveSectionGaps(user, projectId, sectionId, {
        providerCredentialId: input.providerCredentialId ?? undefined,
      });
      return reply.send({ summary });
    },
  );

  instance.post(
    '/api/projects/:projectId/resolve-gaps',
    { config: { rateLimit: { max: 12, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId } = parseParams(request, projectParams);
      const input = parseBody(
        request,
        z.object({
          sectionIds: z.array(z.string().uuid()).max(60).optional(),
          providerCredentialId: z.string().uuid().nullish(),
        }),
      );
      await ctx.projectService.getOwned(user, projectId);
      const job = await jobs.enqueue(user, {
        projectId,
        kind: 'resolve_gaps',
        payload: {
          sectionIds: input.sectionIds,
          providerCredentialId: input.providerCredentialId ?? undefined,
        },
      });
      return reply.status(202).send({ jobId: job.id });
    },
  );

  instance.post('/api/projects/:projectId/versions', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const body = parseBody(request, z.object({ label: z.string().trim().min(1).max(160) }));
    const version = await ctx.exportService.createVersionSnapshot(user, projectId, 'manual', body.label);
    return reply.status(201).send({ version: { id: version.id, versionNumber: version.versionNumber } });
  });

  instance.post('/api/projects/:projectId/versions/:versionId/restore', async (request, reply) => {
    const user = requireUser(request);
    const params = parseParams(request, z.object({ projectId: z.string().uuid(), versionId: z.string().uuid() }));
    return reply.send(await ctx.exportService.restoreVersion(user, params.projectId, params.versionId));
  });

  instance.get('/api/projects/:projectId/versions', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    return reply.send({ versions: await ctx.exportService.listVersions(user, projectId) });
  });

  // ---- jobs ---------------------------------------------------------------
  instance.get('/api/projects/:projectId/jobs', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    await ctx.projectService.getOwned(user, projectId);
    return reply.send({ jobs: await jobs.listForProject(user, projectId) });
  });

  instance.get('/api/jobs', async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(request, jobListQuerySchema);
    return reply.send({ jobs: await jobs.listForUser(user, query) });
  });

  instance.get('/api/projects/:projectId/jobs/:jobId', async (request, reply) => {
    const user = requireUser(request);
    const { jobId, projectId } = parseParams(request, jobParams);
    const job = await jobs.getOwned(user, jobId);
    if (job.projectId !== projectId) throw notFound('Job not found');
    return reply.send({ job });
  });

  instance.post('/api/projects/:projectId/jobs/:jobId/cancel', async (request, reply) => {
    const user = requireUser(request);
    const { jobId, projectId } = parseParams(request, jobParams);
    const job = await jobs.getOwned(user, jobId);
    if (job.projectId !== projectId) throw notFound('Job not found');
    return reply.send({ job: await jobs.cancel(user, jobId) });
  });

  instance.post('/api/projects/:projectId/jobs/:jobId/retry', async (request, reply) => {
    const user = requireUser(request);
    const { jobId, projectId } = parseParams(request, jobParams);
    const job = await jobs.getOwned(user, jobId);
    if (job.projectId !== projectId) throw notFound('Job not found');
    return reply.send({ job: await jobs.retry(user, jobId) });
  });
}
