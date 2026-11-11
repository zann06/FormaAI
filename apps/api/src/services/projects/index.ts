import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { projects, users, documents, exportArtifacts } from '../../db/schema.js';
import { notFound, conflict, AppError } from '../../lib/errors.js';
import type { AuthContext } from '../auth/index.js';
import type { StorageAdapter } from '../storage/index.js';
import type { ProjectCreateInput, ProjectUpdateInput } from '@formaai/shared';
import { MAX_PROJECTS_PER_USER } from '@formaai/shared';

export interface ProjectSummary {
  id: string;
  title: string;
  reportType: string | null;
  language: string;
  tone: string | null;
  audience: string | null;
  instructions: string | null;
  targetLength: string | null;
  status: string;
  templateReady: boolean;
  mappingReady: boolean;
  archivedAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
  documentCount: number;
  sourceCount: number;
}

export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
  ) {}

  /** Every query below is scoped by `ctx.userId` inside the SQL predicate. */
  async getOwned(ctx: AuthContext, projectId: string) {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Project not found');
    return row;
  }

  async list(ctx: AuthContext, options: { includeArchived?: boolean; search?: string } = {}): Promise<ProjectSummary[]> {
    const conditions = [eq(projects.userId, ctx.userId)];
    if (!options.includeArchived) conditions.push(isNull(projects.archivedAt));
    if (options.search) conditions.push(ilike(projects.title, `%${options.search}%`));

    const rows = await this.db
      .select({
        project: projects,
        documentCount: sql<number>`(
          select count(*)::int from ${documents} d
          where d.project_id = ${projects.id} and d.kind = 'template'
        )`,
        sourceCount: sql<number>`(
          select count(*)::int from ${documents} s
          where s.project_id = ${projects.id} and s.kind = 'source'
        )`,
      })
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.lastActivityAt))
      .limit(200);

    return rows.map(({ project, documentCount, sourceCount }) => ({
      id: project.id,
      title: project.title,
      reportType: project.reportType,
      language: project.language,
      tone: project.tone,
      audience: project.audience,
      instructions: project.instructions,
      targetLength: project.targetLength,
      status: project.status,
      templateReady: project.templateReady,
      mappingReady: project.mappingReady,
      archivedAt: project.archivedAt,
      lastActivityAt: project.lastActivityAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      documentCount: Number(documentCount ?? 0),
      sourceCount: Number(sourceCount ?? 0),
    }));
  }

  async create(ctx: AuthContext, input: ProjectCreateInput): Promise<ProjectSummary> {
    const [activeProjects] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.userId, ctx.userId), isNull(projects.archivedAt)));
    if (Number(activeProjects?.count ?? 0) >= MAX_PROJECTS_PER_USER) {
      throw new AppError('QUOTA_EXCEEDED', `You have reached the limit of ${MAX_PROJECTS_PER_USER} active projects`);
    }
    const [row] = await this.db
      .insert(projects)
      .values({
        userId: ctx.userId,
        title: input.title,
        reportType: input.reportType ?? null,
        language: input.language ?? 'en',
        tone: input.tone ?? null,
        audience: input.audience ?? null,
        instructions: input.instructions ?? null,
        targetLength: input.targetLength ?? null,
        status: 'draft',
      })
      .returning();
    if (!row) throw new AppError('INTERNAL', 'Could not create the project');
    return {
      ...row,
      documentCount: 0,
      sourceCount: 0,
    } as ProjectSummary;
  }

  async update(ctx: AuthContext, projectId: string, input: ProjectUpdateInput) {
    await this.getOwned(ctx, projectId);
    const [row] = await this.db
      .update(projects)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.reportType !== undefined ? { reportType: input.reportType } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.tone !== undefined ? { tone: input.tone } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.targetLength !== undefined ? { targetLength: input.targetLength } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .returning();
    return row!;
  }

  async archive(ctx: AuthContext, projectId: string) {
    await this.getOwned(ctx, projectId);
    const [row] = await this.db
      .update(projects)
      .set({ archivedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .returning();
    return row!;
  }

  async restore(ctx: AuthContext, projectId: string) {
    const [existing] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!existing) throw notFound('Project not found');
    if (!existing.archivedAt) throw conflict('Project is not archived');
    const [row] = await this.db
      .update(projects)
      .set({ archivedAt: null, status: 'draft', updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .returning();
    return row!;
  }

  /**
   * Deletes the project, its rows (via ON DELETE CASCADE) and its stored files.
   * Files are removed after the DB transaction commits; orphaned storage keys are
   * covered by the cleanup job if the process dies in between.
   */
  async delete(ctx: AuthContext, projectId: string): Promise<void> {
    await this.getOwned(ctx, projectId);
    const docs = await this.db
      .select({ storageKey: documents.storageKey, sizeBytes: documents.sizeBytes })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId)));

    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ storageUsedBytes: users.storageUsedBytes })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1);
      const freed = docs.reduce((sum, d) => sum + d.sizeBytes, 0);
      await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
      if (user) {
        await tx
          .update(users)
          .set({ storageUsedBytes: Math.max(0, user.storageUsedBytes - freed) })
          .where(eq(users.id, ctx.userId));
      }
    });

    for (const doc of docs) {
      await this.storage.delete(doc.storageKey).catch(() => undefined);
    }
  }

  async touch(ctx: AuthContext, projectId: string, patch: { templateReady?: boolean; mappingReady?: boolean; status?: string } = {}) {
    await this.db
      .update(projects)
      .set({ ...patch, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
  }

  /**
   * Deletes every stored file (source documents, templates and export
   * artifacts) belonging to the user. Used before account deletion so private
   * data never outlives the account. DB rows are removed by the cascade that
   * follows; failures to delete a single object are logged, not fatal.
   */
  async deleteAllFiles(ctx: AuthContext): Promise<{ deleted: number; failed: number }> {
    const docRows = await this.db
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.userId, ctx.userId));
    const artifactRows = await this.db
      .select({ storageKey: exportArtifacts.storageKey })
      .from(exportArtifacts)
      .where(eq(exportArtifacts.userId, ctx.userId));

    let deleted = 0;
    let failed = 0;
    for (const row of [...docRows, ...artifactRows]) {
      if (!row.storageKey) continue;
      try {
        await this.storage.delete(row.storageKey);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { deleted, failed };
  }
}
