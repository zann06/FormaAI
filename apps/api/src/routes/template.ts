import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { outlineReorderSchema, outlineSectionUpdateSchema } from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { parseBody, parseParams, requireUser } from '../plugins/auth-helpers.js';
import { notFound } from '../lib/errors.js';

const projectParams = z.object({ projectId: z.string().uuid() });
const sectionParams = z.object({ projectId: z.string().uuid(), sectionId: z.string().uuid() });

export async function registerTemplateRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const templates = ctx.templateService;

  instance.get('/api/projects/:projectId/template', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    await ctx.projectService.getOwned(user, projectId);
    const template = await ctx.documentService.getTemplate(user, projectId);
    const analysis = await templates.load(user, projectId);
    const latestJob = await templates.latestTemplateJob(user, projectId);
    if (!template && !analysis) return reply.send({ template: null, structure: null, sections: [] });
    return reply.send({
      template: template
        ? {
            id: template.id,
            originalName: template.originalName,
            sizeBytes: template.sizeBytes,
            status: template.status,
            extractionError: template.extractionError,
            metadata: template.metadata,
            createdAt: template.createdAt,
          }
        : null,
      structure: analysis?.structure ?? null,
      sections: analysis?.sections ?? [],
      latestJob: latestJob
        ? { id: latestJob.id, status: latestJob.status, stage: latestJob.stage, errorMessage: latestJob.errorMessage }
        : null,
    });
  });

  instance.get('/api/projects/:projectId/sections', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    await ctx.projectService.getOwned(user, projectId);
    return reply.send({ sections: await templates.listSections(user, projectId) });
  });

  instance.patch('/api/projects/:projectId/sections/:sectionId', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, sectionId } = parseParams(request, sectionParams);
    const input = parseBody(request, outlineSectionUpdateSchema);
    const section = await templates.updateSection(user, projectId, sectionId, input);
    return reply.send({ section });
  });

  instance.post('/api/projects/:projectId/sections/reorder', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const input = parseBody(request, outlineReorderSchema);
    await templates.reorder(user, projectId, input.order);
    return reply.send({ ok: true });
  });

  instance.post('/api/projects/:projectId/sections/manual', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const input = parseBody(
      request,
      z.object({
        heading: z.string().trim().min(1).max(400),
        level: z.number().int().min(1).max(9).default(1),
        paragraphIndex: z.number().int().min(0).default(0),
      }),
    );
    const section = await ctx.templateService.createManualSection(user, projectId, input);
    return reply.status(201).send({ section });
  });

  instance.get('/api/projects/:projectId/sections/:sectionId/detail', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, sectionId } = parseParams(request, sectionParams);
    const detail = await ctx.generationService.getSectionForEditing(user, sectionId);
    if (detail.template.projectId !== projectId) throw notFound('Section not found');
    const evidence = detail.mapping
      ? await ctx.documentService.chunksByIds(user, detail.mapping.evidenceChunkIds)
      : [];
    return reply.send({
      section: {
        id: detail.template.id,
        heading: detail.template.heading,
        headingOriginal: detail.template.headingOriginal,
        level: detail.template.level,
        sortOrder: detail.template.sortOrder,
        required: detail.template.required,
        excluded: detail.template.excluded,
        insertionStrategy: detail.template.insertionStrategy,
        placeholder: detail.template.placeholder,
        instructions: detail.template.instructions,
        tableCount: detail.template.tableCount,
        bodyPreview: detail.template.bodyPreview,
      },
      content: detail.report?.content ?? '',
      status: detail.report?.status ?? 'empty',
      revision: detail.report?.revision ?? 0,
      warnings: detail.report?.warnings ?? [],
      placeholders: detail.report?.placeholders ?? [],
      citedChunkIds: detail.report?.citedChunkIds ?? [],
      modelUsed: detail.report?.modelUsed ?? null,
      mapping: detail.mapping
        ? {
            purpose: detail.mapping.purpose,
            requirements: detail.mapping.requirements,
            gaps: detail.mapping.gaps,
            conflicts: detail.mapping.conflicts,
            contentPlan: detail.mapping.contentPlan,
            coverage: detail.mapping.coverage,
            producedBy: detail.mapping.producedBy,
          }
        : null,
      evidence: evidence.map((chunk) => ({
        id: chunk.id,
        documentName: chunk.documentName,
        page: chunk.page,
        paragraphIndex: chunk.paragraphIndex,
        text: chunk.text,
      })),
    });
  });
}
