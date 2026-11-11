import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../server-context.js';
import { parseParams, requireUser } from '../plugins/auth-helpers.js';
import { AppError, badRequest, notFound, validationError } from '../lib/errors.js';
import { JobService } from '../services/jobs/index.js';
import { SOURCE_EXTENSIONS } from '@formaai/shared';

const projectParams = z.object({ projectId: z.string().uuid() });
const documentParams = z.object({ projectId: z.string().uuid(), documentId: z.string().uuid() });

export async function registerDocumentRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const documents = ctx.documentService;
  const jobs = new JobService(ctx.db, ctx.config.JOB_MAX_ATTEMPTS);

  instance.get('/api/projects/:projectId/documents', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    return reply.send({ documents: await documents.list(user, projectId) });
  });

  instance.post('/api/projects/:projectId/documents', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, projectParams);
    const file = await readUpload(request, instance, ctx);
    const kind = file.kind;
    const doc = await documents.upload(user, projectId, file, kind);
    const job = await jobs.enqueue(user, {
      projectId,
      kind: kind === 'template' ? 'analyze_template' : 'extract_document',
      payload: { documentId: doc.id },
      documentId: doc.id,
    });
    return reply.status(201).send({ document: toDocumentResponse(doc), jobId: job.id });
  });

  instance.get('/api/projects/:projectId/documents/:documentId/download', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, documentId } = parseParams(request, documentParams);
    const doc = await documents.getOwnedForProject(user, projectId, documentId);
    const bytes = await documents.readBytesForDocument(documentId, user.userId);
    return reply
      .header('content-type', doc.mimeType)
      .header('content-disposition', `attachment; filename="${encodeURIComponent(doc.originalName)}"`)
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  });

  instance.delete('/api/projects/:projectId/documents/:documentId', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, documentId } = parseParams(request, documentParams);
    await documents.getOwnedForProject(user, projectId, documentId);
    await documents.delete(user, documentId);
    return reply.send({ ok: true });
  });

  instance.post('/api/projects/:projectId/documents/:documentId/reextract', async (request, reply) => {
    const user = requireUser(request);
    const { projectId, documentId } = parseParams(request, documentParams);
    const doc = await documents.getOwnedForProject(user, projectId, documentId);
    const job = await jobs.enqueue(user, {
      projectId,
      kind: doc.kind === 'template' ? 'analyze_template' : 'extract_document',
      payload: { documentId: doc.id },
      documentId: doc.id,
    });
    return reply.status(202).send({ jobId: job.id });
  });
}

async function readUpload(
  request: import('fastify').FastifyRequest,
  instance: FastifyInstance,
  ctx: ServerContext,
): Promise<{ filename: string; mimetype: string; buffer: Uint8Array; kind: 'template' | 'source' }> {
  if (!request.isMultipart()) {
    throw badRequest('Upload the file as multipart/form-data with a "file" field');
  }
  const part = await request.file();
  if (!part) throw badRequest('No file was provided');
  const kindField = part.fields?.kind;
  let kind: 'template' | 'source' = 'source';
  if (kindField && 'value' in kindField && typeof kindField.value === 'string') {
    if (kindField.value !== 'template' && kindField.value !== 'source') {
      throw badRequest('The "kind" field must be "template" or "source"');
    }
    kind = kindField.value;
  }
  const buffer = await part.toBuffer();
  if (buffer.byteLength > ctx.config.MAX_FILE_MB * 1024 * 1024) {
    throw new AppError('PAYLOAD_TOO_LARGE', `File exceeds the ${ctx.config.MAX_FILE_MB} MB limit`);
  }
  if (kind === 'source') {
    const ext = part.filename.toLowerCase().slice(part.filename.lastIndexOf('.'));
    if (!SOURCE_EXTENSIONS.includes(ext as (typeof SOURCE_EXTENSIONS)[number])) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported source file type. Supported: ${SOURCE_EXTENSIONS.join(', ')}`,
      );
    }
  }
  void instance;
  return { filename: part.filename, mimetype: part.mimetype, buffer: new Uint8Array(buffer), kind };
}

function toDocumentResponse(doc: Record<string, unknown>) {
  return {
    id: doc.id,
    kind: doc.kind,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

void validationError;
void notFound;
