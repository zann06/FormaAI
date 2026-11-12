import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import {
  documents,
  exportArtifacts,
  projects,
  reportSections,
  reportVersions,
  templateSections,
} from '../../db/schema.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import type { StorageAdapter } from '../storage/index.js';
import { assembleDocx, readDocxPackage, xmlToString } from '@formaai/docx-engine';
import { analyzeDocumentXml } from '@formaai/docx-engine';
import { sha256Hex } from '../../lib/crypto.js';
import { convertDocxToPdf, isPdfConverterConfigured, validatePdf } from './pdf.js';
import { renderDocxPreview } from './preview.js';
import { buildStorageKey } from '../storage/index.js';
import { safeFilename } from '@formaai/shared';
import { classifySection, shouldKeepTemplateText } from '@formaai/shared';

export interface AssemblyInput {
  ctx: AuthContext;
  projectId: string;
  jobId?: string;
}

/**
 * True when the stored content is nothing but a "[MISSING: ...]" marker.
 *
 * Generation writes such a marker when no evidence could be mapped, so that the
 * gap is visible instead of inventing text. Treating that marker as "empty" for
 * the required-section check keeps a handful of unsupported sections (cover
 * pages, appendices) from blocking an otherwise finished report.
 */
export function isPlaceholderOnly(content: string | null | undefined): boolean {
  if (!content) return false;
  const stripped = content.replace(/\[MISSING:[^\]]*\]/gi, '').trim();
  return stripped.length === 0 && /\[MISSING:/i.test(content);
}

export class ExportService {
  /**
   * In-memory page-preview cache, keyed by the hash of the assembled DOCX.
   *
   * Rendering takes ~10 s because LibreOffice has to start and lay the document
   * out. Without a cache every visit to the Preview tab would pay that cost again.
   * Keyed by content, so editing a section produces a different DOCX and therefore
   * a fresh render — the cache can never serve stale pages.
   */
  private readonly previewCache = new Map<string, Awaited<ReturnType<typeof renderDocxPreview>>>();
  private static readonly PREVIEW_CACHE_LIMIT = 12;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    private readonly config: AppConfig,
  ) {}

  private readonly previewCacheAdapter = {
    get: async (key: string) => this.previewCache.get(key) ?? null,
    set: async (key: string, value: Awaited<ReturnType<typeof renderDocxPreview>>) => {
      // Bounded LRU-ish eviction: previews are large (hundreds of KB per page).
      if (this.previewCache.size >= ExportService.PREVIEW_CACHE_LIMIT) {
        const oldest = this.previewCache.keys().next().value;
        if (oldest) this.previewCache.delete(oldest);
      }
      this.previewCache.set(key, value);
    },
  };

  async assertProject(ctx: AuthContext, projectId: string) {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!project) throw notFound('Project not found');
    return project;
  }

  async createExport(ctx: AuthContext, projectId: string, format: 'docx' | 'pdf') {
    const project = await this.assertProject(ctx, projectId);
    if (format === 'pdf' && !isPdfConverterConfigured(this.config)) {
      throw new AppError(
        'PDF_CONVERTER_NOT_CONFIGURED',
        'PDF export is not available on this instance: no LibreOffice binary or converter URL is configured. DOCX export still works.',
      );
    }
    const sections = await this.db
      .select({ status: reportSections.status, content: reportSections.content })
      .from(reportSections)
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)));
    if (sections.length === 0) throw conflict('Generate at least one section before exporting');
    const emptyRequired = await this.db
      .select({
        heading: templateSections.heading,
        level: templateSections.level,
        sortOrder: templateSections.sortOrder,
        styleId: templateSections.styleId,
        content: reportSections.content,
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .where(
        and(
          eq(templateSections.projectId, projectId),
          eq(templateSections.userId, ctx.userId),
          eq(templateSections.required, true),
          eq(templateSections.excluded, false),
          sql`(coalesce(${reportSections.content}, '') = '')`,
        ),
      );
    // A [MISSING: ...] placeholder means "no evidence was mapped here". That is
    // worth warning about, but it must not block the whole export: on a real
    // campus template a handful of cover-page or appendix sections have no source
    // material, and refusing to export left 40 finished sections trapped behind
    // them. The placeholder stays visible in the document so the gap is obvious.
    const firstSortOrder = emptyRequired.reduce((min, row) => Math.min(min, row.sortOrder), Number.MAX_SAFE_INTEGER);
    const emptyHeadings = emptyRequired
      .filter((section) => !isPlaceholderOnly(section.content))
      // Cover lines and rubric sheets are intentionally left with no stored body:
      // their text already exists in the template, so "empty" here is correct and
      // blocking on it would make every campus cover page unexportable.
      .filter(
        (section) =>
          !shouldKeepTemplateText(
            classifySection({
              heading: section.heading,
              level: section.level,
              nearStart: section.sortOrder - firstSortOrder < 8,
              // Same signal the generator uses, so the two can never disagree
              // about which sections are deliberately left to the template.
              isTitleStyle: /^(title|subtitle|coverpage|cover)$/i.test(section.styleId ?? ''),
            }),
          ),
      )
      .map((section) => section.heading);
    if (emptyHeadings.length > 0) {
      throw conflict(
        `These required sections are still empty: ${emptyHeadings
          .slice(0, 5)
          .map((heading) => heading)
          .join(', ')}. Generate or write them, or mark them as not required in the outline.`,
      );
    }
    const [todaysExports] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(exportArtifacts)
      .where(
        and(
          eq(exportArtifacts.userId, ctx.userId),
          sql`${exportArtifacts.createdAt} >= date_trunc('day', now())`,
        ),
      );
    if (Number(todaysExports?.count ?? 0) >= this.config.DAILY_EXPORT_QUOTA) {
      throw new AppError('QUOTA_EXCEEDED', `Daily export limit reached (${this.config.DAILY_EXPORT_QUOTA}).`);
    }

    const [versionNumber] = await this.db
      .select({ max: sql<number>`coalesce(max(${exportArtifacts.versionNumber}), 0)::int` })
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.projectId, projectId), eq(exportArtifacts.userId, ctx.userId)));
    const nextVersion = Number(versionNumber?.max ?? 0) + 1;

    const [artifact] = await this.db
      .insert(exportArtifacts)
      .values({
        userId: ctx.userId,
        projectId,
        format,
        status: 'pending',
        versionNumber: nextVersion,
        expiresAt: new Date(Date.now() + this.config.EXPORT_RETENTION_DAYS * 86400000),
      })
      .returning();
    void project;
    return artifact!;
  }

  /**
   * Builds the DOCX from a copy of the original template and stores it.
   * Only DOM-level text insertion is performed; everything else is byte-copied.
   */
  async assemble(ctx: AuthContext, exportId: string): Promise<{ artifactId: string; fidelity: unknown }> {
    const [artifact] = await this.db
      .select()
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)))
      .limit(1);
    if (!artifact) throw notFound('Export not found');
    if (artifact.format !== 'docx' && artifact.format !== 'pdf') throw conflict('Unsupported export format');

    const [template] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.projectId, artifact.projectId),
          eq(documents.userId, ctx.userId),
          eq(documents.kind, 'template'),
        ),
      )
      .limit(1);
    if (!template) throw conflict('Upload a DOCX template before exporting');

    const rows = await this.db
      .select({
        sectionId: templateSections.id,
        heading: templateSections.heading,
        paragraphIndex: templateSections.paragraphIndex,
        strategy: templateSections.insertionStrategy,
        placeholder: templateSections.placeholder,
        excluded: templateSections.excluded,
        bodyPreview: templateSections.bodyPreview,
        content: reportSections.content,
        status: reportSections.status,
        tableData: reportSections.tableData,
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .where(and(eq(templateSections.projectId, artifact.projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(templateSections.sortOrder);

    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, artifact.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);

    const templateBytes = await this.storage.get(template.storageKey);
    const result = assembleDocx(templateBytes, {
      globalPlaceholders: {
        report_title: project?.title ?? '',
        report_type: project?.reportType ?? '',
        generated_date: new Date().toISOString().slice(0, 10),
      },
      sections: rows.map((row) => ({
        sectionId: row.sectionId,
        headingText: row.heading,
        paragraphIndex: row.paragraphIndex,
        insertionStrategy: row.strategy as 'placeholder' | 'after_heading' | 'manual',
        placeholder: row.placeholder,
        content: row.content ?? '',
        table: row.tableData ?? null,
        skip: row.excluded,
      })),
    });

    const storageKey = buildStorageKey(ctx.userId, artifact.projectId, `${safeFilename(project?.title ?? 'report')}.docx`);
    await this.storage.put(storageKey, result.buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const checksum = sha256Hex(result.buffer);

    // Re-open the produced package and compare structure before marking success.
    const reopened = readDocxPackage(result.buffer);
    const docXml = xmlToString(reopened.files['word/document.xml']!);
    const stylesXml = reopened.files['word/styles.xml'] ? xmlToString(reopened.files['word/styles.xml']!) : null;
    const verification = analyzeDocumentXml(docXml, stylesXml, null);
    const warnings = [...result.fidelity.warnings];
    if (verification.headings.length !== result.fidelity.templateHeadings) {
      warnings.push('Structural verification failed: heading count changed.');
    }

    const [updated] = await this.db
      .update(exportArtifacts)
      .set({
        storageKey,
        sizeBytes: result.buffer.byteLength,
        checksum,
        status: 'ready',
        fidelityReport: result.fidelity as unknown as Record<string, unknown>,
        warnings,
        updatedAt: new Date(),
      })
      .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)))
      .returning();

    return { artifactId: updated!.id, fidelity: result.fidelity };
  }

  /**
   * Builds the DOCX that the export WOULD produce right now, without recording an
   * export artifact or consuming the daily quota, then renders its first pages as
   * PNGs.
   *
   * This reuses `assemble`'s inputs so the preview cannot drift from the real
   * export: same template, same sections, same insertion strategy.
   */
  async renderPreview(
    ctx: AuthContext,
    projectId: string,
    options: { maxPages?: number } = {},
  ): Promise<Awaited<ReturnType<typeof renderDocxPreview>>> {
    const project = await this.assertProject(ctx, projectId);

    const [template] = await this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.kind, 'template')),
      )
      .limit(1);
    if (!template) throw conflict('Upload a DOCX template before previewing the report');

    const rows = await this.db
      .select({
        sectionId: templateSections.id,
        heading: templateSections.heading,
        paragraphIndex: templateSections.paragraphIndex,
        strategy: templateSections.insertionStrategy,
        placeholder: templateSections.placeholder,
        excluded: templateSections.excluded,
        content: reportSections.content,
        tableData: reportSections.tableData,
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(templateSections.sortOrder);

    const templateBytes = await this.storage.get(template.storageKey);
    const assembled = assembleDocx(templateBytes, {
      globalPlaceholders: {
        report_title: project.title ?? '',
        report_type: project.reportType ?? '',
        generated_date: new Date().toISOString().slice(0, 10),
      },
      sections: rows.map((row) => ({
        sectionId: row.sectionId,
        headingText: row.heading,
        paragraphIndex: row.paragraphIndex,
        insertionStrategy: row.strategy as 'placeholder' | 'after_heading' | 'manual',
        placeholder: row.placeholder,
        content: row.content ?? '',
        table: row.tableData ?? null,
        skip: row.excluded,
      })),
    });

    return renderDocxPreview(assembled.buffer, this.config, {
      maxPages: options.maxPages,
      // Key on the *inputs*, not the output bytes: assembling stamps the current
      // date into the document, so identical content still yields different bytes
      // and a byte hash would always miss.
      cacheKey: sha256Hex(
        JSON.stringify({
          title: project.title ?? '',
          template: template.storageKey,
          sections: rows.map((row) => [row.sectionId, row.excluded, row.content ?? '']),
        }),
      ),
      cache: this.previewCacheAdapter,
    });
  }

  async convertToPdf(ctx: AuthContext, exportId: string, docxExportId: string) {
    const [artifact] = await this.db
      .select()
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)))
      .limit(1);
    if (!artifact) throw notFound('Export not found');
    const [docxArtifact] = await this.db
      .select()
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.id, docxExportId), eq(exportArtifacts.userId, ctx.userId)))
      .limit(1);
    if (!docxArtifact?.storageKey) throw conflict('The source DOCX export is not ready');

    const docxBytes = await this.storage.get(docxArtifact.storageKey);
    let pdfBytes: Uint8Array;
    try {
      const conversion = await convertDocxToPdf(docxBytes, this.config);
      pdfBytes = conversion.bytes;
    } catch (error) {
      await this.db
        .update(exportArtifacts)
        .set({ status: 'failed', errorMessage: (error as Error).message.slice(0, 1000), updatedAt: new Date() })
        .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)));
      throw error;
    }
    const validation = await validatePdf(pdfBytes);
    if (validation.pageCount === 0 || validation.textChars === 0) {
      const message =
        validation.pageCount === 0
          ? 'The PDF converter produced an empty document'
          : 'The PDF has no extractable text; it may have been rendered incorrectly';
      await this.db
        .update(exportArtifacts)
        .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
        .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)));
      throw new AppError('PROVIDER_ERROR', message);
    }

    const [project] = await this.db
      .select({ title: projects.title })
      .from(projects)
      .where(and(eq(projects.id, artifact.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    const storageKey = buildStorageKey(ctx.userId, artifact.projectId, `${safeFilename(project?.title ?? 'report')}.pdf`);
    await this.storage.put(storageKey, pdfBytes, 'application/pdf');

    const [updated] = await this.db
      .update(exportArtifacts)
      .set({
        storageKey,
        sizeBytes: pdfBytes.byteLength,
        checksum: sha256Hex(pdfBytes),
        status: 'ready',
        warnings: [`PDF generated from the final DOCX (${validation.pageCount} page(s)).`],
        updatedAt: new Date(),
      })
      .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)))
      .returning();
    return updated!;
  }

  /**
   * Starts an export. DOCX assembles from the template directly. PDF first
   * assembles a DOCX artifact and then converts it, so the PDF is always
   * derived from the same bytes a DOCX export would produce.
   *
   * Returns the artifact the caller should poll, plus the queued job chain.
   */
  async startExport(
    ctx: AuthContext,
    projectId: string,
    format: 'docx' | 'pdf',
    versionId: string | null,
    enqueue: (kind: 'assemble_docx' | 'convert_pdf', payload: Record<string, unknown>) => Promise<string>,
  ): Promise<{ exportId: string; jobId: string; docxExportId: string | null; pdfExportId: string | null }> {
    if (format === 'docx') {
      const artifact = await this.createExport(ctx, projectId, 'docx');
      if (versionId) {
        await this.db
          .update(exportArtifacts)
          .set({ versionId })
          .where(and(eq(exportArtifacts.id, artifact.id), eq(exportArtifacts.userId, ctx.userId)));
      }
      const jobId = await enqueue('assemble_docx', { exportId: artifact.id });
      return { exportId: artifact.id, jobId, docxExportId: null, pdfExportId: null };
    }

    // PDF: the intermediate DOCX is a real, downloadable artifact.
    const docxArtifact = await this.createExport(ctx, projectId, 'docx');
    if (versionId) {
      await this.db
        .update(exportArtifacts)
        .set({ versionId })
        .where(and(eq(exportArtifacts.id, docxArtifact.id), eq(exportArtifacts.userId, ctx.userId)));
    }
    const pdfArtifact = await this.createExport(ctx, projectId, 'pdf');
    if (versionId) {
      await this.db
        .update(exportArtifacts)
        .set({ versionId })
        .where(and(eq(exportArtifacts.id, pdfArtifact.id), eq(exportArtifacts.userId, ctx.userId)));
    }
    const assembleJobId = await enqueue('assemble_docx', { exportId: docxArtifact.id });
    await enqueue('convert_pdf', {
      exportId: pdfArtifact.id,
      docxExportId: docxArtifact.id,
      dependsOnJobId: assembleJobId,
    });
    return {
      exportId: docxArtifact.id,
      jobId: assembleJobId,
      docxExportId: docxArtifact.id,
      pdfExportId: pdfArtifact.id,
    };
  }

  async listExports(ctx: AuthContext, projectId: string) {    await this.assertProject(ctx, projectId);
    return this.db
      .select({
        id: exportArtifacts.id,
        format: exportArtifacts.format,
        status: exportArtifacts.status,
        versionNumber: exportArtifacts.versionNumber,
        sizeBytes: exportArtifacts.sizeBytes,
        checksum: exportArtifacts.checksum,
        warnings: exportArtifacts.warnings,
        fidelityReport: exportArtifacts.fidelityReport,
        errorMessage: exportArtifacts.errorMessage,
        createdAt: exportArtifacts.createdAt,
      })
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.projectId, projectId), eq(exportArtifacts.userId, ctx.userId)))
      .orderBy(desc(exportArtifacts.createdAt))
      .limit(50);
  }

  /** Loads an export artifact owned by the caller (404 otherwise). */
  async getOwnedExport(ctx: AuthContext, exportId: string) {
    const [artifact] = await this.db
      .select()
      .from(exportArtifacts)
      .where(and(eq(exportArtifacts.id, exportId), eq(exportArtifacts.userId, ctx.userId)))
      .limit(1);
    if (!artifact) throw notFound('Export not found');
    return artifact;
  }

  async getExportForDownload(ctx: AuthContext, exportId: string) {
    const artifact = await this.getOwnedExport(ctx, exportId);
    if (artifact.status !== 'ready' || !artifact.storageKey) throw conflict('This export is not ready yet');
    const [project] = await this.db
      .select({ title: projects.title })
      .from(projects)
      .where(and(eq(projects.id, artifact.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    const bytes = await this.storage.get(artifact.storageKey);
    const filename = `${safeFilename(project?.title ?? 'report')}-v${artifact.versionNumber}.${artifact.format}`;
    return { artifact, bytes, filename };
  }

  async createVersionSnapshot(ctx: AuthContext, projectId: string, kind: 'export' | 'manual' | 'restore', label: string) {
    await this.assertProject(ctx, projectId);
    const sections = await this.db
      .select({
        sectionId: reportSections.templateSectionId,
        heading: templateSections.heading,
        content: reportSections.content,
        status: reportSections.status,
        revision: reportSections.revision,
        warnings: reportSections.warnings,
      })
      .from(reportSections)
      .innerJoin(templateSections, eq(templateSections.id, reportSections.templateSectionId))
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)))
      .orderBy(templateSections.sortOrder);

    const [row] = await this.db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ max: sql<number>`coalesce(max(${reportVersions.versionNumber}), 0)::int` })
        .from(reportVersions)
        .where(and(eq(reportVersions.projectId, projectId), eq(reportVersions.userId, ctx.userId)));
      return tx
        .insert(reportVersions)
        .values({
          userId: ctx.userId,
          projectId,
          versionNumber: Number(maxRow?.max ?? 0) + 1,
          label: label.slice(0, 160),
          kind,
          snapshot: { sections, createdAt: new Date().toISOString() },
        })
        .returning();
    });
    return row!;
  }

  async listVersions(ctx: AuthContext, projectId: string) {
    await this.assertProject(ctx, projectId);
    return this.db
      .select({
        id: reportVersions.id,
        versionNumber: reportVersions.versionNumber,
        label: reportVersions.label,
        kind: reportVersions.kind,
        createdAt: reportVersions.createdAt,
      })
      .from(reportVersions)
      .where(and(eq(reportVersions.projectId, projectId), eq(reportVersions.userId, ctx.userId)))
      .orderBy(desc(reportVersions.versionNumber))
      .limit(50);
  }

  async restoreVersion(ctx: AuthContext, projectId: string, versionId: string) {
    const [version] = await this.db
      .select()
      .from(reportVersions)
      .where(
        and(
          eq(reportVersions.id, versionId),
          eq(reportVersions.projectId, projectId),
          eq(reportVersions.userId, ctx.userId),
        ),
      )
      .limit(1);
    if (!version) throw notFound('Version not found');
    const snapshot = version.snapshot as { sections: Array<{ sectionId: string; content: string; status: string }> };
    await this.createVersionSnapshot(ctx, projectId, 'restore', `Before restoring v${version.versionNumber}`);
    await this.db.transaction(async (tx) => {
      for (const section of snapshot.sections) {
        await tx
          .update(reportSections)
          .set({ content: section.content, status: section.status, revision: sql`${reportSections.revision} + 1`, editedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(reportSections.templateSectionId, section.sectionId), eq(reportSections.userId, ctx.userId)));
      }
    });
    return { restored: snapshot.sections.length };
  }

  async deleteExpired() {
    const rows = await this.db
      .select({ id: exportArtifacts.id, storageKey: exportArtifacts.storageKey })
      .from(exportArtifacts)
      .where(sql`${exportArtifacts.expiresAt} is not null and ${exportArtifacts.expiresAt} < now()`);
    for (const row of rows) {
      if (row.storageKey) await this.storage.delete(row.storageKey).catch(() => undefined);
      // tenancy-guard: allow system cleanup — rows were already filtered by expiry above
      await this.db.delete(exportArtifacts).where(eq(exportArtifacts.id, row.id));
    }
    return rows.length;
  }
}
