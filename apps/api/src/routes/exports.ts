import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exportRequestSchema, safeFilename } from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { parseBody, parseParams, requireUser } from '../plugins/auth-helpers.js';
import { JobService, type JobPayloads } from '../services/jobs/index.js';
import { conflict, notFound } from '../lib/errors.js';
import { isPdfConverterConfigured } from '../services/export/pdf.js';
import { isPreviewAvailable, PREVIEW_LIMITS, PreviewError } from '../services/export/preview.js';

const projectParams = z.object({ projectId: z.string().uuid() });
const exportParams = z.object({ projectId: z.string().uuid(), exportId: z.string().uuid() });

export async function registerExportRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const exportsService = ctx.exportService;
  const jobs = new JobService(ctx.db, ctx.config.JOB_MAX_ATTEMPTS);

  instance.get('/api/projects/:projectId/exports', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    return reply.send({
      exports: await exportsService.listExports(user, projectId),
      pdfAvailable: isPdfConverterConfigured(ctx.config),
      retentionDays: ctx.config.EXPORT_RETENTION_DAYS,
    });
  });

  instance.post(
    '/api/projects/:projectId/exports',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId } = parseParams(request, projectParams);
      const input = parseBody(request, exportRequestSchema);

      // Snapshot the current report so exports are reproducible and versioned.
      const version = await exportsService.createVersionSnapshot(
        user,
        projectId,
        'export',
        `Export ${input.format.toUpperCase()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      );

      const started = await exportsService.startExport(
        user,
        projectId,
        input.format,
        version.id,
        async (kind, payload) => {
          if (kind === 'assemble_docx') {
            const job = await jobs.enqueue(user, { projectId, kind, payload: payload as JobPayloads['assemble_docx'] });
            return job.id;
          }
          const job = await jobs.enqueue(user, { projectId, kind, payload: payload as JobPayloads['convert_pdf'] });
          return job.id;
        },
      );

      return reply.status(202).send({ ...started, versionId: version.id, format: input.format });
    },
  );

  /**
   * Renders the first pages of the report as PNG images so the workspace can show
   * what the exported file actually looks like (cover page, logo, tables).
   *
   * Returns JSON with data URLs rather than separate image requests: a preview is
   * 1–12 pages, caching each one separately would need a token scheme, and the
   * client wants them all at once to lay out the scroll view.
   */
  instance.get(
    '/api/projects/:projectId/preview',
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { projectId } = parseParams(request, projectParams);

      // Ownership first: answering "preview needs LibreOffice" before checking the
      // project belongs to this user would leak that the id exists.
      await ctx.projectService.getOwned(user, projectId);

      if (!isPreviewAvailable(ctx.config)) {
        // A clear, actionable answer instead of a 500 when the image lacks LibreOffice.
        return reply.status(501).send({
          error: {
            code: 'PREVIEW_UNAVAILABLE',
            message:
              'Page preview needs LibreOffice on the server. The report text is still available in the editor, and DOCX export still works.',
          },
        });
      }

      try {
        const preview = await exportsService.renderPreview(user, projectId, {
          maxPages: PREVIEW_LIMITS.maxPages,
        });
        return reply.send({
          pages: preview.pages.map((page) => ({
            page: page.page,
            width: page.width,
            height: page.height,
            // PNG data URL: the browser can draw it with no extra round trip.
            image: `data:image/png;base64,${Buffer.from(page.bytes).toString('base64')}`,
          })),
          pageCount: preview.pageCount,
          totalPages: preview.totalPages,
          truncated: preview.totalPages > preview.pageCount,
          renderedAt: preview.renderedAt,
        });
      } catch (error) {
        if (error instanceof PreviewError) {
          return reply.status(409).send({
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
  );

  instance.get('/api/projects/:projectId/exports/:exportId/download', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, exportId } = parseParams(request, exportParams);
    const project = await ctx.projectService.getOwned(user, projectId);
    const { artifact, bytes } = await exportsService.getExportForDownload(user, exportId);
    if (artifact.projectId !== project.id) throw notFound('Export not found');
    const filename =
      artifact.format === 'docx'
        ? `${safeFilename(project.title)}-v${artifact.versionNumber}.docx`
        : `${safeFilename(project.title)}-v${artifact.versionNumber}.pdf`;
    const contentType =
      artifact.format === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';
    return reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });

  /** Converts an already-assembled DOCX export into a PDF (idempotent entry point). */
  instance.post('/api/projects/:projectId/exports/:exportId/convert-pdf', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, exportId } = parseParams(request, exportParams);
    await ctx.projectService.getOwned(user, projectId);
    const source = await exportsService.getOwnedExport(user, exportId);
    if (source.projectId !== projectId) throw notFound('Export not found');
    if (source.format !== 'docx') throw conflict('Only DOCX exports can be converted to PDF');
    if (source.status !== 'ready') throw conflict('The DOCX export is not ready yet');
    const pdfArtifact = await exportsService.createExport(user, projectId, 'pdf');
    const job = await jobs.enqueue(user, {
      projectId,
      kind: 'convert_pdf',
      payload: { exportId: pdfArtifact.id, docxExportId: source.id },
    });
    return reply.status(202).send({ exportId: pdfArtifact.id, jobId: job.id });
  });
}
