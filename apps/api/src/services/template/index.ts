import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { documents, processingJobs, projects, reportSections, sectionMappings, templateSections } from '../../db/schema.js';
import type { AuthContext } from '../auth/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { analyzeDocumentXml, partText, readDocxPackage, xmlToString } from '@formaai/docx-engine';
import { storageRegistry } from '../storage/registry.js';
import type { OutlineSectionUpdateInput, TemplateStructure } from '@formaai/shared';

export interface TemplateAnalysisResult {
  structure: TemplateStructure;
  sections: Array<{
    sectionKey: string;
    heading: string;
    level: number;
    sortOrder: number;
    paragraphIndex: number;
    styleId: string | null;
    bodyPreview: string;
    tableCount: number;
    hasImages: boolean;
    insertionStrategy: 'placeholder' | 'after_heading' | 'manual';
    placeholder: string | null;
  }>;
}

/**
 * Parses a DOCX template and produces the structure map + persisted sections.
 * Pure function over bytes: no DB access, so it is unit-testable in isolation.
 */
export function analyzeTemplateBytes(bytes: Uint8Array): TemplateAnalysisResult {
  const pkg = readDocxPackage(bytes);
  const documentXml = xmlToString(pkg.files['word/document.xml']!);
  const stylesXml = pkg.files['word/styles.xml'] ? xmlToString(pkg.files['word/styles.xml']!) : null;
  const coreXml = pkg.files['docProps/core.xml'] ? xmlToString(pkg.files['docProps/core.xml']!) : null;
  const structure = analyzeDocumentXml(documentXml, stylesXml, coreXml);

  const headerParts = Object.keys(pkg.files).filter((n) => /^word\/header\d+\.xml$/.test(n));
  const footerParts = Object.keys(pkg.files).filter((n) => /^word\/footer\d+\.xml$/.test(n));
  structure.hasHeaders = headerParts.length > 0;
  structure.hasFooters = footerParts.length > 0;
  structure.headerTexts = headerParts.map((n) => partText(xmlToString(pkg.files[n]!))).filter(Boolean);
  structure.footerTexts = footerParts.map((n) => partText(xmlToString(pkg.files[n]!))).filter(Boolean);

  const usedKeys = new Set<string>();
  const sections = structure.headings.map((heading, index) => {
    const base = heading.hasExplicitPlaceholder
      ? heading.placeholders[0]
      : `section_${index + 1}`;
    let key = (base ?? `section_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 100);
    while (usedKeys.has(key)) key = `${key}_${index + 1}`;
    usedKeys.add(key);
    return {
      sectionKey: key,
      heading: heading.text.slice(0, 400),
      level: heading.level,
      sortOrder: index,
      paragraphIndex: heading.paragraphIndex,
      styleId: heading.styleId,
      bodyPreview: heading.bodyText.slice(0, 1000),
      tableCount: heading.tableCount,
      hasImages: heading.hasImages,
      insertionStrategy: heading.suggestedStrategy,
      placeholder: heading.hasExplicitPlaceholder ? heading.placeholders[0] ?? null : null,
    };
  });

  return { structure, sections };
}

export class TemplateService {
  constructor(private readonly db: Database) {}

  async analyzeAndStore(ctx: AuthContext, projectId: string, documentId: string): Promise<TemplateAnalysisResult> {
    const [doc] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, ctx.userId), eq(documents.projectId, projectId)))
      .limit(1);
    if (!doc) throw notFound('Template not found');
    if (doc.kind !== 'template') throw conflict('This document is not a template');
    if (doc.status === 'extracted') {
      const existing = await this.load(ctx, projectId);
      if (existing) return existing;
    }

    const bytes = await this.getBytes(ctx, doc.storageKey);
    const result = analyzeTemplateBytes(bytes);

    await this.db.transaction(async (tx) => {
      // Replace sections produced by a previous analysis of this template.
      await tx.delete(templateSections).where(
        and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)),
      );
      if (result.sections.length > 0) {
        await tx.insert(templateSections).values(
          result.sections.map((section) => ({
            userId: ctx.userId,
            projectId,
            documentId,
            sectionKey: section.sectionKey,
            headingOriginal: section.heading,
            heading: section.heading,
            level: section.level,
            sortOrder: section.sortOrder,
            paragraphIndex: section.paragraphIndex,
            styleId: section.styleId,
            bodyPreview: section.bodyPreview,
            tableCount: section.tableCount,
            hasImages: section.hasImages,
            required: true,
            excluded: false,
            insertionStrategy: section.insertionStrategy,
            placeholder: section.placeholder,
          })),
        );
      }
      await tx
        .update(documents)
        .set({
          status: 'extracted',
          extractionMethod: 'docx-template',
          extractedAt: new Date(),
          pageCount: result.structure.pageSetup ? result.structure.sectionBreakCount : null,
          metadata: { structure: result.structure },
          // A template with zero sections is not an error in the parser; it is a
          // real, common authoring problem. Record it where the user will see it,
          // instead of leaving them with a silently empty outline.
          extractionError:
            result.sections.length === 0
              ? 'No sections could be detected. FormaAI looked for Word heading styles, outline levels, chapter numbering (BAB I, 1.1, ...) and heading-like formatting (bold, larger or centred short paragraphs). If the document has none of these, add sections manually from the outline, or re-upload a version whose chapter titles use Heading 1 / Heading 2.'
              : null,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, documentId), eq(documents.userId, ctx.userId)));
      await tx
        .update(projects)
        .set({
          templateReady: result.sections.length > 0,
          // The upload set status to "processing". Analysis is the step that ends
          // that wait, so clear it here — otherwise a template that yields no
          // headings (or a re-analysis that changes nothing) leaves the project
          // stuck on "Processing" forever, with no job left running. Only a
          // "processing" project is moved; a report already in review or ready
          // keeps its status.
          status: sql`case when ${projects.status} = 'processing' then 'draft' else ${projects.status} end`,
          updatedAt: new Date(),
          lastActivityAt: new Date(),
        })
        .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
    });

    return result;
  }

  private async getBytes(ctx: AuthContext, storageKey: string): Promise<Uint8Array> {
    // Storage access is delegated: the caller passes keys that were already
    // resolved through an ownership-checked query.
    return storageRegistry.get().get(storageKey);
  }

  async load(ctx: AuthContext, projectId: string): Promise<TemplateAnalysisResult | null> {
    const [templateDoc] = await this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.kind, 'template')),
      )
      .limit(1);
    if (!templateDoc) return null;
    const structure = (templateDoc.metadata as { structure?: TemplateStructure } | null)?.structure;
    if (!structure) return null;
    const rows = await this.db
      .select()
      .from(templateSections)
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(asc(templateSections.sortOrder));
    return {
      structure,
      sections: rows.map((row) => ({
        sectionKey: row.sectionKey,
        heading: row.heading,
        level: row.level,
        sortOrder: row.sortOrder,
        paragraphIndex: row.paragraphIndex,
        styleId: row.styleId,
        bodyPreview: row.bodyPreview ?? '',
        tableCount: row.tableCount,
        hasImages: row.hasImages,
        insertionStrategy: row.insertionStrategy as 'placeholder' | 'after_heading' | 'manual',
        placeholder: row.placeholder,
      })),
    };
  }

  async createManualSection(
    ctx: AuthContext,
    projectId: string,
    input: { heading: string; level: number; paragraphIndex: number },
  ) {
    const template = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(eq(documents.projectId, projectId), eq(documents.userId, ctx.userId), eq(documents.kind, 'template')),
      )
      .limit(1);
    if (template.length === 0) throw notFound('Upload a DOCX template first');
    const [maxRow] = await this.db
      .select({ max: sql<number>`coalesce(max(${templateSections.sortOrder}), -1)::int` })
      .from(templateSections)
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)));
    const nextOrder = Number(maxRow?.max ?? -1) + 1;
    const [row] = await this.db
      .insert(templateSections)
      .values({
        userId: ctx.userId,
        projectId,
        documentId: template[0]!.id,
        sectionKey: `manual_${Date.now().toString(36)}`,
        headingOriginal: input.heading,
        heading: input.heading,
        level: input.level,
        sortOrder: nextOrder,
        paragraphIndex: input.paragraphIndex,
        required: true,
        excluded: false,
        insertionStrategy: 'after_heading',
      })
      .returning();
    return row!;
  }

  async listSections(ctx: AuthContext, projectId: string) {
    return this.db
      .select({
        id: templateSections.id,
        sectionKey: templateSections.sectionKey,
        heading: templateSections.heading,
        headingOriginal: templateSections.headingOriginal,
        level: templateSections.level,
        sortOrder: templateSections.sortOrder,
        styleId: templateSections.styleId,
        required: templateSections.required,
        excluded: templateSections.excluded,
        insertionStrategy: templateSections.insertionStrategy,
        placeholder: templateSections.placeholder,
        instructions: templateSections.instructions,
        tableCount: templateSections.tableCount,
        bodyPreview: templateSections.bodyPreview,
        report: {
          id: reportSections.id,
          status: reportSections.status,
          revision: reportSections.revision,
          wordCount: reportSections.wordCount,
          generatedAt: reportSections.generatedAt,
          editedAt: reportSections.editedAt,
          warnings: reportSections.warnings,
        },
        mapping: {
          coverage: sectionMappings.coverage,
          producedBy: sectionMappings.producedBy,
          gaps: sectionMappings.gaps,
          evidenceCount: sql<number>`coalesce(jsonb_array_length(${sectionMappings.evidenceChunkIds}), 0)`,
        },
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .leftJoin(sectionMappings, eq(sectionMappings.sectionId, templateSections.id))
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(asc(templateSections.sortOrder));
  }

  async getOwnedSection(ctx: AuthContext, sectionId: string) {
    const [row] = await this.db
      .select()
      .from(templateSections)
      .where(and(eq(templateSections.id, sectionId), eq(templateSections.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Section not found');
    return row;
  }

  async updateSection(ctx: AuthContext, projectId: string, sectionId: string, input: OutlineSectionUpdateInput) {
    const section = await this.getOwnedSection(ctx, sectionId);
    if (section.projectId !== projectId) throw notFound('Section not found');
    const [row] = await this.db
      .update(templateSections)
      .set({
        ...(input.heading !== undefined ? { heading: input.heading } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
        ...(input.insertionStrategy !== undefined ? { insertionStrategy: input.insertionStrategy } : {}),
        ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
        ...(input.order !== undefined ? { sortOrder: input.order } : {}),
        ...(input.excluded !== undefined ? { excluded: input.excluded } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(templateSections.id, sectionId), eq(templateSections.userId, ctx.userId)))
      .returning();
    return row!;
  }

  async reorder(ctx: AuthContext, projectId: string, order: string[]) {
    const rows = await this.db
      .select({ id: templateSections.id })
      .from(templateSections)
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)));
    const owned = new Set(rows.map((r) => r.id));
    if (order.some((id) => !owned.has(id))) throw notFound('Section not found');
    await this.db.transaction(async (tx) => {
      for (const [index, id] of order.entries()) {
        await tx
          .update(templateSections)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(and(eq(templateSections.id, id), eq(templateSections.userId, ctx.userId)));
      }
    });
  }

  async latestTemplateJob(ctx: AuthContext, projectId: string) {
    const [row] = await this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.projectId, projectId),
          eq(processingJobs.userId, ctx.userId),
          eq(processingJobs.kind, 'analyze_template'),
        ),
      )
      .orderBy(sql`${processingJobs.createdAt} desc`)
      .limit(1);
    return row ?? null;
  }
}
