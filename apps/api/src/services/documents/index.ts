import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { documents, extractedChunks, projects, users } from '../../db/schema.js';
import type { StorageAdapter } from '../storage/index.js';
import type { AuthContext } from '../auth/index.js';
import { AppError, conflict, notFound, quotaExceeded } from '../../lib/errors.js';
import { validateUpload } from '../../lib/upload-validation.js';
import { buildStorageKey } from '../storage/index.js';
import { sha256Hex } from '../../lib/crypto.js';
import { MAX_DOCUMENTS_PER_PROJECT } from '@formaai/shared';

export interface DocumentSummary {
  id: string;
  kind: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  pageCount: number | null;
  wordCount: number | null;
  chunkCount: number;
  extractionMethod: string | null;
  extractionError: string | null;
  extractedAt: Date | null;
  createdAt: Date;
}

export class DocumentService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    private readonly limits: { maxBytes: number; userQuotaBytes: number },
  ) {}

  async getOwned(ctx: AuthContext, documentId: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Document not found');
    return row;
  }

  async getOwnedForProject(ctx: AuthContext, projectId: string, documentId: string) {
    const row = await this.getOwned(ctx, documentId);
    if (row.projectId !== projectId) throw notFound('Document not found');
    return row;
  }

  private async assertProjectOwned(ctx: AuthContext, projectId: string) {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Project not found');
  }

  async list(ctx: AuthContext, projectId: string): Promise<DocumentSummary[]> {
    await this.assertProjectOwned(ctx, projectId);
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId)))
      .orderBy(asc(documents.kind), asc(documents.createdAt));
    return rows.map(toSummary);
  }

  async getTemplate(ctx: AuthContext, projectId: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.kind, 'template')),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Validates and stores an uploaded file.
   *
   * The template is replaceable, but replacing it deletes the previous template
   * row (cascading sections) — the endpoint refuses when generation already
   * started, so a user never silently loses work.
   */
  async upload(
    ctx: AuthContext,
    projectId: string,
    file: { filename: string; mimetype: string; buffer: Uint8Array },
    kind: 'template' | 'source',
  ) {
    await this.assertProjectOwned(ctx, projectId);
    const validated = validateUpload(file.filename, file.mimetype, file.buffer, {
      kind,
      maxBytes: this.limits.maxBytes,
    });

    const [user] = await this.db
      .select({ storageUsedBytes: users.storageUsedBytes })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    const used = user?.storageUsedBytes ?? 0;
    if (used + validated.sizeBytes > this.limits.userQuotaBytes) {
      throw quotaExceeded(
        `Storage quota exceeded. Used ${Math.round(used / 1048576)} MB of ${Math.round(this.limits.userQuotaBytes / 1048576)} MB.`,
      );
    }

    if (kind === 'source') {
      const [sourceCount] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(
          and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.kind, 'source')),
        );
      if (Number(sourceCount?.count ?? 0) >= MAX_DOCUMENTS_PER_PROJECT) {
        throw conflict(`This project already has the maximum of ${MAX_DOCUMENTS_PER_PROJECT} source documents`);
      }
    }

    let previousTemplate: { id: string; storageKey: string; sizeBytes: number } | null = null;
    if (kind === 'template') {
      const existing = await this.getTemplate(ctx, projectId);
      if (existing) {
        const generated = await this.hasGeneratedContent(ctx, projectId);
        if (generated) {
          throw conflict(
            'This project already has generated sections. Delete the report content before replacing the template.',
          );
        }
        previousTemplate = { id: existing.id, storageKey: existing.storageKey, sizeBytes: existing.sizeBytes };
      }
    }

    const storageKey = buildStorageKey(ctx.userId, projectId, file.filename);
    await this.storage.put(storageKey, validated.bytes, validated.mimeType);
    const checksum = sha256Hex(validated.bytes);

    try {
      const created = await this.db.transaction(async (tx) => {
        if (previousTemplate) {
          await tx.delete(documents).where(and(eq(documents.id, previousTemplate.id), eq(documents.userId, ctx.userId)));
        }
        const [row] = await tx
          .insert(documents)
          .values({
            userId: ctx.userId,
            projectId,
            kind,
            originalName: file.filename.slice(0, 300),
            storageKey,
            mimeType: validated.mimeType,
            sizeBytes: validated.sizeBytes,
            checksum,
            status: 'uploaded',
          })
          .returning();
        const delta = validated.sizeBytes - (previousTemplate?.sizeBytes ?? 0);
        await tx
          .update(users)
          .set({ storageUsedBytes: Math.max(0, used + delta) })
          .where(eq(users.id, ctx.userId));
        await tx
          .update(projects)
          .set({
            lastActivityAt: new Date(),
            updatedAt: new Date(),
            ...(kind === 'template' ? { templateReady: false, status: 'processing' } : {}),
          })
          .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
        return row!;
      });
      if (previousTemplate) await this.storage.delete(previousTemplate.storageKey).catch(() => undefined);
      return created;
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  private async hasGeneratedContent(ctx: AuthContext, projectId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.status, 'extracted')))
      .limit(1);
    return rows.length > 0;
  }

  async delete(ctx: AuthContext, documentId: string): Promise<void> {
    const doc = await this.getOwned(ctx, documentId);
    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ storageUsedBytes: users.storageUsedBytes })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1);
      await tx.delete(documents).where(and(eq(documents.id, documentId), eq(documents.userId, ctx.userId)));
      if (user) {
        await tx
          .update(users)
          .set({ storageUsedBytes: Math.max(0, user.storageUsedBytes - doc.sizeBytes) })
          .where(eq(users.id, ctx.userId));
      }
      if (doc.kind === 'template') {
        await tx
          .update(projects)
          .set({ templateReady: false, mappingReady: false, updatedAt: new Date() })
          .where(and(eq(projects.id, doc.projectId), eq(projects.userId, ctx.userId)));
      }
    });
    await this.storage.delete(doc.storageKey).catch(() => undefined);
  }

  async readBytes(ctx: AuthContext, documentId: string): Promise<{ doc: typeof documents.$inferSelect; bytes: Uint8Array }> {
    const doc = await this.getOwned(ctx, documentId);
    const bytes = await this.storage.get(doc.storageKey);
    return { doc, bytes };
  }

  async readBytesForDocument(documentId: string, userId: string): Promise<Uint8Array> {
    const [doc] = await this.db
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1);
    if (!doc) throw notFound('Document not found');
    return this.storage.get(doc.storageKey);
  }

  async markStatus(
    documentId: string,
    userId: string,
    patch: Partial<{
      status: string;
      pageCount: number | null;
      wordCount: number | null;
      chunkCount: number;
      extractionMethod: string | null;
      extractionError: string | null;
      extractedAt: Date | null;
      metadata: Record<string, unknown>;
    }>,
  ) {
    await this.db
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
  }

  async replaceChunks(
    ctx: AuthContext,
    projectId: string,
    documentId: string,
    chunks: Array<{
      text: string;
      page?: number | null;
      paragraphIndex?: number | null;
      startOffset?: number | null;
      endOffset?: number | null;
      headingPath?: string | null;
      sheet?: string | null;
      slide?: number | null;
    }>,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.delete(extractedChunks).where(
        and(eq(extractedChunks.documentId, documentId), eq(extractedChunks.userId, ctx.userId)),
      );
      if (chunks.length === 0) return;
      const values = chunks.map((chunk, ordinal) => ({
        userId: ctx.userId,
        projectId,
        documentId,
        ordinal,
        text: chunk.text,
        page: chunk.page ?? null,
        paragraphIndex: chunk.paragraphIndex ?? null,
        startOffset: chunk.startOffset ?? null,
        endOffset: chunk.endOffset ?? null,
        headingPath: chunk.headingPath ?? null,
        sheet: chunk.sheet ?? null,
        slide: chunk.slide ?? null,
      }));
      for (let i = 0; i < values.length; i += 200) {
        // tenancy-guard: allow every row above sets userId: ctx.userId explicitly
        await tx.insert(extractedChunks).values(values.slice(i, i + 200));
      }
    });
  }

  async chunksForProject(ctx: AuthContext, projectId: string) {
    return this.db
      .select({
        id: extractedChunks.id,
        documentId: extractedChunks.documentId,
        ordinal: extractedChunks.ordinal,
        text: extractedChunks.text,
        page: extractedChunks.page,
        paragraphIndex: extractedChunks.paragraphIndex,
        headingPath: extractedChunks.headingPath,
        documentName: documents.originalName,
      })
      .from(extractedChunks)
      .innerJoin(documents, eq(documents.id, extractedChunks.documentId))
      .where(and(eq(extractedChunks.projectId, projectId), eq(extractedChunks.userId, ctx.userId)))
      .orderBy(asc(documents.createdAt), asc(extractedChunks.ordinal));
  }

  async chunksByIds(ctx: AuthContext, ids: string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select({
        id: extractedChunks.id,
        documentId: extractedChunks.documentId,
        text: extractedChunks.text,
        page: extractedChunks.page,
        paragraphIndex: extractedChunks.paragraphIndex,
        documentName: documents.originalName,
      })
      .from(extractedChunks)
      .innerJoin(documents, eq(documents.id, extractedChunks.documentId))
      .where(and(inArray(extractedChunks.id, ids), eq(extractedChunks.userId, ctx.userId)));
  }

  assertCanDownload(doc: { sizeBytes: number }) {
    if (doc.sizeBytes > this.limits.maxBytes * 4) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'Document is too large to stream');
    }
  }
}

function toSummary(row: typeof documents.$inferSelect): DocumentSummary {
  return {
    id: row.id,
    kind: row.kind,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    pageCount: row.pageCount,
    wordCount: row.wordCount,
    chunkCount: row.chunkCount,
    extractionMethod: row.extractionMethod,
    extractionError: row.extractionError,
    extractedAt: row.extractedAt,
    createdAt: row.createdAt,
  };
}

