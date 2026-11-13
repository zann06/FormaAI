import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import {
  documents,
  exportArtifacts,
  extractedChunks,
  projects,
  reportSections,
  reportVersions,
  templateSections,
} from '../../db/schema.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import type { StorageAdapter } from '../storage/index.js';
import { assembleDocx, readDocxPackage, xmlToString } from '@formaai/docx-engine';
import type { AssemblyFigure } from '@formaai/docx-engine';
import { analyzeDocumentXml } from '@formaai/docx-engine';
import { sha256Hex } from '../../lib/crypto.js';
import { convertDocxToPdf, isPdfConverterConfigured, validatePdf } from './pdf.js';
import { renderDocxPreview } from './preview.js';
import { buildStorageKey } from '../storage/index.js';
import { safeFilename } from '@formaai/shared';
import { classifySection, shouldKeepTemplateText, isOnlyGapMarkers, isChapterDivider } from '@formaai/shared';

export interface AssemblyInput {
  ctx: AuthContext;
  projectId: string;
  jobId?: string;
}

/**
 * True when the stored content is nothing but a gap marker.
 *
 * Generation writes such a marker when no evidence could be mapped, so that the
 * gap is visible instead of inventing text. Treating that marker as "empty" for
 * the required-section check keeps a handful of unsupported sections (cover
 * pages, appendices) from blocking an otherwise finished report.
 *
 * Both marker languages are recognised, because a report written in Indonesian
 * carries `[PERLU DICEK: …]` and would otherwise look finished while still holding
 * an unfilled hole.
 */
export function isPlaceholderOnly(content: string | null | undefined): boolean {
  if (!content) return false;
  return isOnlyGapMarkers(content);
}

/**
 * Maps a stored image's MIME type (or its key's extension) to the media
 * extension used inside the DOCX package.
 *
 * Word only accepts PNG, JPEG and GIF here as plain `<Default>` content types;
 * anything else (WEBP, TIFF, BMP) would need a converter we do not ship, so those
 * return null and the section simply keeps its prose.
 */
export function imageExtensionFor(
  mimeType: string | null | undefined,
  storageKey: string,
): 'png' | 'jpeg' | 'gif' | null {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  if (mime === 'image/gif') return 'gif';
  const key = storageKey.toLowerCase();
  if (key.endsWith('.png')) return 'png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'jpeg';
  if (key.endsWith('.gif')) return 'gif';
  return null;
}

/**
 * The literal fill-in prompts shipped by student-report templates.
 *
 * Kept next to `identityReplacements` so the strings that are replaced and the
 * strings whose absence is reported can never drift apart.
 */
export const COVER_PROMPTS = [
  { field: 'Nama', find: '[ Tuliskan Nama Lengkap Anda ]' },
  { field: 'NIM', find: '[ Tuliskan NIM Anda ]' },
  { field: 'Kelas', find: '[ RA / RB / RC / RD ]' },
  { field: 'Tanggal', find: '[ Tuliskan Tanggal Pengumpulan ]' },
] as const;

/**
 * Names the cover fields still unfilled in an assembled document.
 *
 * Export used to leave these prompts in the file silently, so a finished report
 * arrived with `[ Tuliskan Nama Lengkap Anda ]` on the cover and the assistant never
 * asked for the missing details. This is the check that turns that silence into a
 * question the chat can ask.
 */
export function missingCoverFields(documentText: string): string[] {
  return COVER_PROMPTS.filter((prompt) => documentText.includes(prompt.find)).map((prompt) => prompt.field);
}

/**
 * Turns the identity the user supplied into literal template replacements.
 *
 * Student report templates ship with fill-in prompts (`[ Tuliskan Nama Lengkap
 * Anda ]`) instead of data fields, so the cover stays blank unless those exact
 * strings are replaced. `instructions` is where the identity is kept as
 * `Nama: …`, `NIM: …`, `Kelas: …` lines; anything else in there is ordinary
 * guidance and is left alone.
 */
export function identityReplacements(instructions: string | null): Array<{ find: string; replace: string }> {
  if (!instructions) return [];
  const fields: Record<string, string> = {};
  for (const line of instructions.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) fields[match[1]!.trim().toLowerCase()] = match[2]!.trim();
  }

  const replacements: Array<{ find: string; replace: string }> = [];
  const add = (find: string, value: string | undefined) => {
    if (value) replacements.push({ find, replace: value });
  };
  add(COVER_PROMPTS[0].find, fields.nama ?? fields.name);
  add(COVER_PROMPTS[1].find, fields.nim);
  add(COVER_PROMPTS[2].find, fields.kelas ?? fields.class);
  add(COVER_PROMPTS[3].find, fields.tanggal ?? fields.date);
  return replacements;
}

export class ExportService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageAdapter,
    private readonly config: AppConfig,
  ) {}

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
    // A chapter divider ("BAB I: PENDAHULUAN") legitimately has no body: the chapter
    // number is a label above 1.1, 1.2, 1.3 and the document reads correctly without
    // prose under it. Treating it as a missing section blocked the export and told the
    // user their finished report was incomplete.
    const blocking = emptyRequired.filter((section) => !isChapterDivider(section.heading));
    const emptyHeadings = blocking
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
  async assemble(
    ctx: AuthContext,
    exportId: string,
  ): Promise<{ artifactId: string; fidelity: unknown; warnings: string[]; missingCoverFields: string[] }> {
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
        figures: reportSections.figures,
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
    const figures = await this.loadFigures(ctx, rows);
    const result = assembleDocx(templateBytes, {
      globalPlaceholders: {
        report_title: project?.title ?? '',
        report_type: project?.reportType ?? '',
        generated_date: new Date().toISOString().slice(0, 10),
      },
      textReplacements: identityReplacements(project?.instructions ?? null),
      sections: rows.map((row) => ({
        sectionId: row.sectionId,
        headingText: row.heading,
        paragraphIndex: row.paragraphIndex,
        insertionStrategy: row.strategy as 'placeholder' | 'after_heading' | 'manual',
        placeholder: row.placeholder,
        content: row.content ?? '',
        table: row.tableData ?? null,
        figures: figures.get(row.sectionId) ?? [],
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
    // Chapter dividers ("BAB I: PENDAHULUAN") carry no body of their own: the
    // chapter number labels 1.1, 1.2, 1.3 and the document reads correctly without
    // prose under it. Recorded as a note so the outline explains the empty row
    // instead of looking like a silent failure.
    const emptyDividers = rows
      .filter((row) => !row.excluded && !(row.content ?? '').trim() && isChapterDivider(row.heading))
      .map((row) => row.heading);
    if (emptyDividers.length > 0) {
      warnings.push(
        `Chapter dividers with no body of their own (normal for this template): ${emptyDividers
          .slice(0, 6)
          .join(', ')}.`,
      );
    }

    // A blank cover is a question, not a failure: the file is valid and complete,
    // but the assistant must ask for the identity instead of shipping placeholders
    // without a word. The chat reads this from the export job and asks the user.
    const coverStillMissing = missingCoverFields(docXml.replace(/<[^>]+>/g, ''));
    if (coverStillMissing.length > 0) {
      warnings.push(
        `Cover details are still blank in the exported document: ${coverStillMissing.join(
          ', ',
        )}. Ask the user for them and rebuild rather than inventing values.`,
      );
    }
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

    return { artifactId: updated!.id, fidelity: result.fidelity, warnings, missingCoverFields: coverStillMissing };
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
    options: { maxPages?: number; fromPage?: number; toPage?: number } = {},
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
        figures: reportSections.figures,
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(templateSections.sortOrder);

    const templateBytes = await this.storage.get(template.storageKey);
    const figures = await this.loadFigures(ctx, rows);
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
        figures: figures.get(row.sectionId) ?? [],
        skip: row.excluded,
      })),
    });

    // No cache: the preview must always show the current document.
    //
    // An in-memory cache keyed on the assembled inputs used to sit here, and it
    // served stale pages whenever a section changed through a path that did not
    // update the key (a regenerated section, an edited instruction, a filled
    // screenshot box). The user saw an old document in Preview while the download
    // was correct. Paying ~10 s to re-render is the right trade: a wrong preview is
    // a broken product, a slow one is merely slow.
    return renderDocxPreview(assembled.buffer, this.config, {
      maxPages: options.maxPages,
      fromPage: options.fromPage,
      toPage: options.toPage,
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
    if (!docxArtifact) throw notFound('The source DOCX export not found');
    if (docxArtifact.status === 'failed') {
      throw conflict(
        `The DOCX could not be built, so there is nothing to convert to PDF: ${docxArtifact.errorMessage ?? 'unknown reason'}`,
      );
    }
    if (!docxArtifact.storageKey) {
      // Only reachable if the worker started this job before the DOCX finished. The
      // claim query now enforces that ordering, so surfacing it plainly beats a
      // generic conflict the user cannot act on.
      throw conflict('The DOCX export is still being written; try again in a moment.');
    }

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

  /**
   * Resolves the images attached to report sections into embeddable bytes.
   *
   * A figure row only stores `{ documentId, caption }`; the bytes live in storage
   * under the document's key. Every document is re-checked against the caller so
   * a section can never pull in another user's image. A figure whose document is
   * missing or unreadable is dropped rather than breaking the whole export: the
   * report is still correct, just without that picture.
   */
  private async loadFigures(
    ctx: AuthContext,
    rows: Array<{ sectionId: string; figures?: Array<{ documentId: string; caption?: string }> | null }>,
  ): Promise<Map<string, AssemblyFigure[]>> {
    const bySection = new Map<string, AssemblyFigure[]>();
    const wanted = new Set<string>();
    for (const row of rows) for (const figure of row.figures ?? []) wanted.add(figure.documentId);
    if (wanted.size === 0) return bySection;

    const docs = await this.db
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(and(eq(documents.userId, ctx.userId), inArray(documents.id, [...wanted])));

    const loaded = new Map<string, { bytes: Uint8Array; extension: 'png' | 'jpeg' | 'gif' }>();
    for (const doc of docs) {
      const extension = imageExtensionFor(doc.mimeType, doc.storageKey);
      if (!extension) continue;
      try {
        loaded.set(doc.id, { bytes: await this.storage.get(doc.storageKey), extension });
      } catch {
        // Unreadable object: skip this figure, keep the export working.
      }
    }

    // An image has no text of its own, so what it shows was OCR'd into chunks at
    // ingestion. Templates reserve a dashed box per screenshot with an instruction
    // such as "TEMPELKAN SCREENSHOT: Diagram Topologi"; choosing WHICH picture belongs
    // in which box means comparing that instruction with the picture's OCR text. The
    // figure therefore has to carry its documentId and its OCR text down to the
    // assembler, otherwise every box would stay empty and the pictures would be
    // appended wherever the prose ended.
    const ocrByDocument = new Map<string, string>();
    for (const doc of docs) {
      const chunks = await this.db
        .select({ text: extractedChunks.text, ordinal: extractedChunks.ordinal })
        .from(extractedChunks)
        .where(and(eq(extractedChunks.userId, ctx.userId), eq(extractedChunks.documentId, doc.id)))
        .orderBy(extractedChunks.ordinal);
      if (chunks.length > 0) {
        ocrByDocument.set(doc.id, chunks.map((chunk) => chunk.text).join(' ').slice(0, 4000));
      }
    }

    for (const row of rows) {
      const figures: AssemblyFigure[] = [];
      for (const figure of row.figures ?? []) {
        const asset = loaded.get(figure.documentId);
        if (!asset) continue;
        figures.push({
          bytes: asset.bytes,
          extension: asset.extension,
          caption: figure.caption ?? null,
          documentId: figure.documentId,
          text: ocrByDocument.get(figure.documentId) ?? null,
        });
      }
      if (figures.length > 0) bySection.set(row.sectionId, figures);
    }
    return bySection;
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
