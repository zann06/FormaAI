import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import { documents, extractedChunks, projects, reportSections, sectionMappings, templateSections } from '../../db/schema.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import type { CredentialService } from '../credentials/index.js';
import type { MappingService } from '../mapping/index.js';
import type { UsageService } from '../usage/index.js';
import type { FactService } from '../facts/index.js';
import { completeWithFallback, ProviderError, type ProviderRegistry } from '@formaai/ai-providers';
import { buildSectionMessages, sectionDraftSchema, type SectionPromptInput } from './prompts.js';
import {
  containsMarkdownHeadings,
  detectInstructionLeakage,
  extractClaimTokens,
  numbersSupportedBy,
  parseModelJson,
  sectionDraftZod,
} from './schemas.js';
import { countWords } from '@formaai/shared';

export interface GenerationResult {
  sectionId: string;
  content: string;
  status: string;
  warnings: string[];
  citedChunkIds: string[];
  model: string;
  fallbackUsed: boolean;
  wordCount: number;
}

export interface GenerateSectionOptions {
  instructions?: string;
  providerCredentialId?: string;
  keepEdits?: boolean;
  jobId?: string;
}

export class GenerationService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly credentials: CredentialService,
    private readonly mapping: MappingService, // retained for mapping refresh calls
    private readonly usage: UsageService,
    private readonly facts: FactService,
    private readonly registry: ProviderRegistry,
  ) {}

  async ensureReportSection(ctx: AuthContext, projectId: string, sectionId: string) {
    const [existing] = await this.db
      .select()
      .from(reportSections)
      .where(and(eq(reportSections.templateSectionId, sectionId), eq(reportSections.userId, ctx.userId)))
      .limit(1);
    if (existing) return existing;
    const [created] = await this.db
      .insert(reportSections)
      .values({ userId: ctx.userId, projectId, templateSectionId: sectionId, content: '', status: 'empty' })
      .onConflictDoUpdate({
        target: reportSections.templateSectionId,
        set: { updatedAt: new Date() },
      })
      .returning();
    return created!;
  }

  async generateSection(ctx: AuthContext, projectId: string, sectionId: string, options: GenerateSectionOptions): Promise<GenerationResult> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!project) throw notFound('Project not found');

    const [section] = await this.db
      .select()
      .from(templateSections)
      .where(and(eq(templateSections.id, sectionId), eq(templateSections.userId, ctx.userId)))
      .limit(1);
    if (!section) throw notFound('Section not found');
    if (section.excluded) throw conflict('This section is excluded from generation');

    // Daily quota (counts AI requests made today with the user's own key).
    const usedToday = await this.usage.todayCount(ctx).catch(() => 0);
    if (usedToday >= this.config.DAILY_AI_REQUEST_QUOTA) {
      throw new AppError('QUOTA_EXCEEDED', `Daily AI request quota reached (${this.config.DAILY_AI_REQUEST_QUOTA}).`);
    }

    const reportSection = await this.ensureReportSection(ctx, projectId, sectionId);
    const hasUserEdits =
      reportSection.content.trim().length > 0 &&
      reportSection.editedAt !== null &&
      (reportSection.status !== 'draft' || reportSection.revision > 0);
    if (hasUserEdits && !options.keepEdits && options.instructions === undefined) {
      throw conflict(
        'This section has unsaved or manual edits. Confirm regeneration to overwrite them, or pass keepEdits.',
      );
    }

    const [mappingRow] = await this.db
      .select()
      .from(sectionMappings)
      .where(and(eq(sectionMappings.sectionId, sectionId), eq(sectionMappings.userId, ctx.userId)))
      .limit(1);

    const evidenceIds = mappingRow?.evidenceChunkIds ?? [];
    const evidenceChunks = evidenceIds.length
      ? await this.db
          .select({
            id: extractedChunks.id,
            text: extractedChunks.text,
            page: extractedChunks.page,
            paragraphIndex: extractedChunks.paragraphIndex,
            documentName: documents.originalName,
          })
          .from(extractedChunks)
          .innerJoin(documents, eq(documents.id, extractedChunks.documentId))
          .where(and(inArray(extractedChunks.id, evidenceIds), eq(extractedChunks.userId, ctx.userId)))
      : [];

    if (evidenceChunks.length === 0) {
      // Refuse to fabricate. The user must add evidence or accept a marked draft.
      const content = `[MISSING: no source material was mapped to this section. Upload evidence or enter the content manually.]`;
      const updated = await this.saveContent(ctx, projectId, sectionId, content, 'needs_review', reportSection.revision, {
        warnings: ['No supporting evidence was mapped to this section — nothing was generated.'],
        citedChunkIds: [],
        placeholders: ['[MISSING: no source material was mapped to this section.]'],
        providerCredentialId: null,
        modelUsed: null,
      });
      return {
        sectionId,
        content: updated.content,
        status: updated.status,
        warnings: updated.warnings,
        citedChunkIds: [],
        model: 'none',
        fallbackUsed: false,
        wordCount: countWords(updated.content),
      };
    }

    let budget = this.config.AI_MAX_EVIDENCE_CHARS;
    const evidence = evidenceChunks
      .map((chunk) => ({ ...chunk, text: chunk.text }))
      .filter((chunk) => {
        if (budget <= 0) return false;
        const slice = chunk.text.slice(0, Math.min(chunk.text.length, budget));
        chunk.text = slice;
        budget -= slice.length;
        return true;
      });

    const resolved = await this.credentials.resolveForGeneration(ctx, options.providerCredentialId);
    const promptInput: SectionPromptInput = {
      projectTitle: project.title,
      reportType: project.reportType,
      language: project.language,
      tone: project.tone,
      audience: project.audience,
      targetLength: project.targetLength,
      userInstructions: project.instructions,
      sectionHeading: section.heading,
      sectionLevel: section.level,
      purpose: mappingRow?.purpose ?? null,
      requirements: mappingRow?.requirements ?? [],
      contentPlan: mappingRow?.contentPlan ?? [],
      gaps: mappingRow?.gaps ?? [],
      conflicts: ((mappingRow?.conflicts ?? []) as Array<{ label: string; values: Array<{ value: string; documentName: string }> }>) ?? [],
      evidence: evidence.map((chunk) => ({
        id: chunk.id,
        documentName: chunk.documentName,
        page: chunk.page,
        paragraphIndex: chunk.paragraphIndex,
        text: chunk.text,
      })),
      previousContent: options.keepEdits ? reportSection.content : null,
      regenerateInstructions: options.instructions ?? null,
    };

    const messages = buildSectionMessages(promptInput);
    const started = Date.now();
    let completion;
    try {
      completion = await completeWithFallback({
        registry: this.registry,
        primary: resolved.primary,
        fallback: resolved.fallback,
        request: { messages, jsonSchema: sectionDraftSchema, signal: AbortSignal.timeout(this.config.AI_REQUEST_TIMEOUT_MS) },
        onAttempt: async (credentialId, outcome, error) => {
          await this.usage.record(ctx, {
            projectId,
            credentialId,
            jobId: options.jobId,
            providerType: resolved.primary.providerType,
            model: resolved.primary.model,
            operation: 'generate_section',
            status: outcome,
            errorCode: error?.code,
            durationMs: Date.now() - started,
          });
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new AppError('PROVIDER_ERROR', error.message, { code: error.code });
      }
      throw error;
    }

    let parsed = sectionDraftZod.safeParse(safeParseJson(completion.result.text));
    if (!parsed.success && this.config.AI_STRUCTURED_REPAIR_ATTEMPTS > 0) {
      const repairMessages = [
        ...messages,
        { role: 'assistant' as const, content: completion.result.text },
        {
          role: 'user' as const,
          content: `Your previous response did not match the required JSON schema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}. Respond again with JSON only.`,
        },
      ];
      const repaired = await completeWithFallback({
        registry: this.registry,
        primary: resolved.primary,
        fallback: resolved.fallback,
        request: { messages: repairMessages, jsonSchema: sectionDraftSchema },
        onAttempt: async (credentialId, outcome, error) => {
          await this.usage.record(ctx, {
            projectId,
            credentialId,
            jobId: options.jobId,
            providerType: resolved.primary.providerType,
            model: resolved.primary.model,
            operation: 'generate_section_repair',
            status: outcome,
            errorCode: error?.code,
          });
        },
      });
      parsed = sectionDraftZod.safeParse(safeParseJson(repaired.result.text));
      completion = { ...repaired, fellBack: completion.fellBack || repaired.fellBack };
      if (!parsed.success) {
        throw new AppError('PROVIDER_ERROR', 'The model did not return a valid section payload after a repair attempt.');
      }
    } else if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'The model did not return a valid section payload.');
    }

    // ---- post-generation validation -------------------------------------
    const warnings = [...parsed.data.warnings];
    if (completion.fellBack) {
      warnings.push('The primary provider failed; your configured fallback provider was used. Verify the result.');
    }
    if (containsMarkdownHeadings(parsed.data.body)) {
      warnings.push('The model added Markdown-style headings. Convert them to plain text before exporting.');
    }
    const leakage = detectInstructionLeakage(parsed.data.body);
    if (leakage.length > 0) {
      warnings.push(
        'Potential prompt-injection content was detected in the generated text. Review the section carefully before using it.',
      );
    }
    const knownIds = new Set(evidence.map((chunk) => chunk.id));
    const citedChunkIds = parsed.data.citedChunkIds.filter((id) => knownIds.has(id));
    if (parsed.data.citedChunkIds.length !== citedChunkIds.length) {
      warnings.push('The model cited source references that were not in the evidence; those citations were removed.');
    }

    const evidenceText = evidence.map((chunk) => chunk.text).join('\n');
    const { numbers, dates } = extractClaimTokens(parsed.data.body);
    const unsupportedNumbers = numbersSupportedBy(evidenceText, numbers).unsupported;
    const unsupportedDates = numbersSupportedBy(evidenceText, dates).unsupported;
    if (unsupportedNumbers.length > 0) {
      warnings.push(
        `These numeric values in the draft were not found in the mapped evidence and must be verified: ${unsupportedNumbers
          .slice(0, 10)
          .join(', ')}`,
      );
    }
    if (unsupportedDates.length > 0) {
      warnings.push(
        `These dates in the draft were not found in the mapped evidence: ${unsupportedDates.slice(0, 10).join(', ')}`,
      );
    }

    const updated = await this.saveContent(ctx, projectId, sectionId, parsed.data.body, 'draft', reportSection.revision, {
      warnings,
      citedChunkIds,
      placeholders: parsed.data.placeholders,
      providerCredentialId: completion.usedCredentialId,
      modelUsed: completion.result.model,
    });

    return {
      sectionId,
      content: updated.content,
      status: updated.status,
      warnings,
      citedChunkIds,
      model: completion.result.model,
      fallbackUsed: completion.fellBack,
      wordCount: updated.wordCount,
    };
  }

  private async saveContent(
    ctx: AuthContext,
    projectId: string,
    sectionId: string,
    content: string,
    status: string,
    revision: number,
    extra: {
      warnings: string[];
      citedChunkIds: string[];
      placeholders: string[];
      providerCredentialId: string | null;
      modelUsed: string | null;
    },
  ) {
    const [row] = await this.db
      .update(reportSections)
      .set({
        content,
        status,
        revision: revision + 1,
        warnings: extra.warnings,
        citedChunkIds: extra.citedChunkIds,
        placeholders: extra.placeholders,
        providerCredentialId: extra.providerCredentialId,
        modelUsed: extra.modelUsed,
        generatedAt: new Date(),
        wordCount: countWords(content),
        updatedAt: new Date(),
      })
      .where(and(eq(reportSections.templateSectionId, sectionId), eq(reportSections.userId, ctx.userId)))
      .returning();
    return row!;
  }

  /** Returns the ordered list of sections eligible for generation. */
  async eligibleSections(ctx: AuthContext, projectId: string) {
    return this.db
      .select({ id: templateSections.id, heading: templateSections.heading, level: templateSections.level })
      .from(templateSections)
      .where(
        and(
          eq(templateSections.projectId, projectId),
          eq(templateSections.userId, ctx.userId),
          eq(templateSections.excluded, false),
        ),
      )
      .orderBy(asc(templateSections.sortOrder));
  }

  /**
   * Generates content for many sections sequentially. Each section is persisted
   * independently, so a failure in section N never discards sections 1..N-1.
   */
  async generateMany(
    ctx: AuthContext,
    projectId: string,
    options: { sectionIds?: string[]; providerCredentialId?: string; regenerateExisting?: boolean; jobId?: string },
    onProgress?: (done: number, total: number, currentHeading: string) => Promise<void> | void,
  ): Promise<{ results: Array<{ sectionId: string; ok: boolean; error?: string }>; generated: number; failed: number }> {
    const eligible = await this.eligibleSections(ctx, projectId);
    const selected = options.sectionIds ? eligible.filter((s) => options.sectionIds!.includes(s.id)) : eligible;
    const limited = selected.slice(0, this.config.AI_MAX_SECTIONS_PER_JOB);

    const existing = await this.db
      .select({ sectionId: reportSections.templateSectionId, content: reportSections.content })
      .from(reportSections)
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)));
    const existingMap = new Map(existing.map((row) => [row.sectionId, row.content]));

    const results: Array<{ sectionId: string; ok: boolean; error?: string }> = [];
    let done = 0;
    for (const section of limited) {
      const already = existingMap.get(section.id)?.trim();
      if (already && !options.regenerateExisting) {
        results.push({ sectionId: section.id, ok: true });
        done += 1;
        continue;
      }
      await onProgress?.(done, limited.length, section.heading);
      try {
        await this.generateSection(ctx, projectId, section.id, {
          providerCredentialId: options.providerCredentialId,
          keepEdits: true,
          jobId: options.jobId,
        });
        results.push({ sectionId: section.id, ok: true });
      } catch (error) {
        results.push({ sectionId: section.id, ok: false, error: (error as Error).message });
      }
      done += 1;
      await onProgress?.(done, limited.length, section.heading);
    }
    const failed = results.filter((r) => !r.ok).length;
    await this.db
      .update(projects)
      .set({ status: failed === results.length && results.length > 0 ? 'failed' : 'needs_review', updatedAt: new Date(), lastActivityAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
    return { results, generated: results.length - failed, failed };
  }

  async getSectionForEditing(ctx: AuthContext, sectionId: string) {
    const [row] = await this.db
      .select({
        report: reportSections,
        template: templateSections,
        mapping: sectionMappings,
      })
      .from(templateSections)
      .leftJoin(reportSections, eq(reportSections.templateSectionId, templateSections.id))
      .leftJoin(sectionMappings, eq(sectionMappings.sectionId, templateSections.id))
      .where(and(eq(templateSections.id, sectionId), eq(templateSections.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Section not found');
    return row;
  }

  /** Saves user edits with optimistic concurrency on `revision`. */
  async saveUserEdit(
    ctx: AuthContext,
    sectionId: string,
    input: { content: string; status?: string; baseVersion?: number },
  ) {
    const row = await this.getSectionForEditing(ctx, sectionId);
    if (input.baseVersion !== undefined && row.report && row.report.revision !== input.baseVersion) {
      throw conflict('This section changed in another tab. Reload before saving.', {
        currentRevision: row.report.revision,
      });
    }
    if (!row.report) {
      await this.ensureReportSection(ctx, row.template.projectId, sectionId);
    }
    const [updated] = await this.db
      .update(reportSections)
      .set({
        content: input.content,
        status: input.status ?? (input.content.trim() ? 'needs_review' : 'empty'),
        revision: sql`${reportSections.revision} + 1`,
        editedAt: new Date(),
        wordCount: countWords(input.content),
        updatedAt: new Date(),
        ...(input.status === 'validated' || input.status === 'final' ? { reviewedAt: new Date() } : {}),
      })
      .where(and(eq(reportSections.templateSectionId, sectionId), eq(reportSections.userId, ctx.userId)))
      .returning();
    return updated!;
  }

  async listReportSections(ctx: AuthContext, projectId: string) {
    return this.db
      .select({
        id: reportSections.id,
        sectionId: reportSections.templateSectionId,
        content: reportSections.content,
        status: reportSections.status,
        revision: reportSections.revision,
        warnings: reportSections.warnings,
        citedChunkIds: reportSections.citedChunkIds,
        placeholders: reportSections.placeholders,
        wordCount: reportSections.wordCount,
        modelUsed: reportSections.modelUsed,
        generatedAt: reportSections.generatedAt,
        editedAt: reportSections.editedAt,
      })
      .from(reportSections)
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)));
  }

  async gapsForContext(ctx: AuthContext, projectId: string) {
    return this.facts.conflictsForProject(ctx, projectId);
  }

}

function safeParseJson(text: string): unknown {
  try {
    return parseModelJson(text);
  } catch {
    return {};
  }
}
