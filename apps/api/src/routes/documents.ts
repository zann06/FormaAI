import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../server-context.js';
import { parseParams, requireUser } from '../plugins/auth-helpers.js';
import { AppError, badRequest, notFound, validationError } from '../lib/errors.js';
import { expandArchive } from '../lib/archive.js';
import { JobService } from '../services/jobs/index.js';
import { MIME_BY_EXTENSION, SOURCE_EXTENSIONS, extensionOf, isArchiveSourceExtension } from '@formaai/shared';

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

    // A ZIP is a container, not evidence. Unpack it and upload each supported
    // file inside it, so a student's "Dokumen Kasus.zip" works as-is.
    if (kind === 'source' && isArchiveSourceExtension(extensionOfPart(file.filename))) {
      const expansion = await expandArchive(file.buffer);
      const uploaded: Array<{ document: ReturnType<typeof toDocumentResponse>; jobId: string }> = [];
      const failed: Array<{ name: string; reason: string }> = [];
      for (const entry of expansion.entries) {
        try {
          const doc = await documents.upload(
            user,
            projectId,
            { filename: entry.name, mimetype: archiveEntryMime(entry.name), buffer: entry.bytes },
            'source',
          );
          const job = await jobs.enqueue(user, {
            projectId,
            kind: 'extract_document',
            payload: { documentId: doc.id },
            documentId: doc.id,
          });
          uploaded.push({ document: toDocumentResponse(doc), jobId: job.id });
        } catch (error) {
          failed.push({ name: entry.path, reason: errorMessageOf(error) });
        }
      }
      if (uploaded.length === 0) {
        throw badRequest(
          `None of the files in "${file.filename}" could be added: ${failed
            .slice(0, 3)
            .map((entry) => `${entry.name} (${entry.reason})`)
            .join('; ')}`,
        );
      }
      return reply.status(201).send({
        document: uploaded[0]!.document,
        jobId: uploaded[0]!.jobId,
        archive: {
          name: file.filename,
          added: uploaded.length,
          documents: uploaded.map((entry) => entry.document),
          skipped: [...expansion.skipped, ...failed.map((entry) => ({ path: entry.name, reason: entry.reason }))],
        },
      });
    }

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
  // Every text field lands in `request.body` regardless of where it appears in the
  // multipart stream (see `attachFieldsToBody` in the multipart registration).
  // Relying on `part.fields` instead meant a "kind" sent after the file was dropped
  // and the upload silently became a "source" — which is how a .docx template from
  // the chat was stored as plain evidence, leaving the project with no outline and a
  // disabled "Scan & generate" button.
  const body = (request.body ?? {}) as Record<string, unknown>;
  const filePart = body.file as
    | { filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer> }
    | undefined;
  if (!filePart || typeof filePart.toBuffer !== 'function') {
    throw badRequest('Upload the file as multipart/form-data with a "file" field');
  }
  const filename = filePart.filename ?? 'upload';
  const mimetype = filePart.mimetype ?? 'application/octet-stream';
  const buffer = await filePart.toBuffer();

  const rawKind = fieldValue(body, 'kind');
  let kind: 'template' | 'source' = 'source';
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    if (rawKind !== 'template' && rawKind !== 'source') {
      throw badRequest('The "kind" field must be "template" or "source"');
    }
    kind = rawKind;
  }
  if (buffer.byteLength > ctx.config.MAX_FILE_MB * 1024 * 1024) {
    throw new AppError('PAYLOAD_TOO_LARGE', `File exceeds the ${ctx.config.MAX_FILE_MB} MB limit`);
  }
  if (kind === 'source') {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    if (!SOURCE_EXTENSIONS.includes(ext as (typeof SOURCE_EXTENSIONS)[number])) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported source file type. Supported: ${SOURCE_EXTENSIONS.join(', ')}`,
      );
    }
  }
  void instance;
  return { filename, mimetype, buffer: new Uint8Array(buffer), kind };
}

/** Reads a multipart text field whether it arrived as a string or a value object. */
function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const field = fields[name] as { value?: unknown } | undefined;
  if (!field) return undefined;
  if (typeof field === 'string') return field;
  const value = field.value;
  if (typeof value === 'string') return value;
  // `attachFieldsToBody` may hand back a Buffer for a plain text field.
  if (value && typeof value === 'object' && 'toString' in value) return String(value);
  return undefined;
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

/** Extension of an uploaded part's filename, lowercased (``.zip``). */
function extensionOfPart(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index).toLowerCase();
}

/**
 * Declared MIME type for a file pulled out of an archive. It only has to be
 * *plausible* for the extension: validateUpload re-checks the real bytes.
 */
function archiveEntryMime(name: string): string {
  const candidates = MIME_BY_EXTENSION[extensionOf(name)];
  return candidates?.[0] ?? 'application/octet-stream';
}

function errorMessageOf(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

void extensionOf;
