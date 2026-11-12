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
  cleanEvidenceText,
  markSuspiciousInBody,
  markSuspiciousInTable,
  stripInventedQuotes,
  stripOcrAnnotations,
} from './source-fidelity.js';
import {
  containsMarkdownHeadings,
  detectInstructionLeakage,
  extractClaimTokens,
  numbersSupportedBy,
  parseModelJson,
  sectionDraftZod,
} from './schemas.js';
import { countWords, classifySection, shouldKeepTemplateText, type SectionKind } from '@formaai/shared';

export interface GenerationResult {
  sectionId: string;
  content: string;
  status: string;
  warnings: string[];
  citedChunkIds: string[];
  model: string;
  fallbackUsed: boolean;
  wordCount: number;
  /**
   * The section is not prose (a cover line, a rubric sheet), so the template's
   * own text is kept and nothing was generated. Lets the caller say "kept as-is"
   * instead of counting it as a drafted section.
   */
  keptTemplateText?: boolean;
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

    // What kind of text this heading expects. A cover line or a rubric sheet is
    // not a discussion: generating prose for it produced filings about the
    // cover ("Laporan ini disusun sebagai…") instead of the cover itself.
    const nearStart = await this.isNearDocumentStart(ctx, projectId, section.sortOrder);
    const sectionKind: SectionKind = classifySection({
      heading: section.heading,
      level: section.level,
      nearStart,
      // A paragraph styled as the document Title *is* the cover, whatever its
      // wording. Without this, a template whose first heading is a title-case
      // title ("Quarterly Activity Report") looked like an ordinary chapter and
      // the exporter wrote an essay directly under the report's own title.
      isTitleStyle: /^(title|subtitle|coverpage|cover)$/i.test(section.styleId ?? ''),
    });
    // Only cover matter and form sheets keep the template's text. Listing
    // sections (bibliography, appendices) still get generated, because their
    // entries come from the evidence — skipping them left them empty and blocked
    // the export. Explicit user instructions always override.
    if (shouldKeepTemplateText(sectionKind) && options.instructions === undefined) {
      // Furniture keeps the template's own text, so the stored body must be
      // EMPTY. Writing a body here does not "fill" the cover: it appends generated
      // prose after a heading whose real content (title, rubric table, checklist)
      // already lives in the template. Keeping stale content was worse still — it
      // preserved an earlier run's 1,500-character essay about the cover, which is
      // exactly the reported defect, so the row is cleared deliberately.
      const [existing] = await this.db
        .select()
        .from(reportSections)
        .where(and(eq(reportSections.templateSectionId, sectionId), eq(reportSections.userId, ctx.userId)))
        .limit(1);
      const keptText = '';
      let cleared = false;
      if (existing && existing.content.trim()) {
        await this.saveContent(ctx, projectId, sectionId, keptText, 'empty', existing.revision, {
          warnings: [
            'Cover/title matter: the template’s own text is used, so any generated body was cleared.',
          ],
          citedChunkIds: [],
          placeholders: [],
          providerCredentialId: null,
          modelUsed: null,
          table: null,
        });
        cleared = true;
      }
      return {
        sectionId,
        // `empty` is the honest status: nothing is stored for this section because
        // the template itself supplies the text.
        content: cleared ? keptText : existing?.content ?? '',
        status: 'empty',
        warnings: [
          sectionKind === 'identity'
            ? 'Cover/title matter: the template’s own text is kept instead of being rewritten.'
            : 'This sheet comes from the template; its own text is kept as-is.',
        ],
        citedChunkIds: [],
        model: 'none',
        fallbackUsed: false,
        wordCount: 0,
        keptTemplateText: true,
      };
    }

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

    // OCR damage must not be presented to the model as fact. Unreadable glyphs
    // are removed and near-miss commands are marked inline, so the draft cannot
    // restate `apconfig /all` as if it were a real command. A warning alone was
    // not enough: a real report repeated the damaged token in seven sections.
    const evidenceNotes: string[] = [];
    for (const chunk of evidence) {
      const { text, notes } = cleanEvidenceText(chunk.text);
      chunk.text = text;
      for (const note of notes) {
        if (!evidenceNotes.includes(note)) evidenceNotes.push(note);
      }
    }

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
      sectionKind,
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
        onAttempt: async (credentialId, outcome, error, usage) => {
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
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
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
        onAttempt: async (credentialId, outcome, error, usage) => {
          await this.usage.record(ctx, {
            projectId,
            credentialId,
            jobId: options.jobId,
            providerType: resolved.primary.providerType,
            model: resolved.primary.model,
            operation: 'generate_section_repair',
            status: outcome,
            errorCode: error?.code,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
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
    // Quotes the model invented around a passage (`???Reply from…???`) appear in
    // no source and must not reach the document.
    const deduped = stripInventedQuotes(parsed.data.body, evidence.map((chunk) => chunk.text).join('\n'));
    if (deduped.changed) {
      parsed.data.body = deduped.body;
      warnings.push('The draft contained "???" marks that do not appear in any source; they were removed.');
    }
    // The `[OCR? …]` annotations are for the model, not for the reader. They are
    // stripped from the body and reported as a warning instead, so the doubt
    // survives without appearing inside a submitted assignment.
    const withoutOcr = stripOcrAnnotations(parsed.data.body);
    if (withoutOcr.changed) {
      parsed.data.body = withoutOcr.body;
    }
    // Stripping the marker is not enough on its own: the model often drops it and
    // writes the bare damaged token, which then reads as a real command in the
    // report. Anything the evidence flagged as a likely misread is marked in the
    // body too, so the reader can see it was not certain.
    const bodyScan = markSuspiciousInBody(parsed.data.body, evidence.map((chunk) => chunk.text).join('\n'));
    const tableScan = markSuspiciousInTable(parsed.data.table ?? null, evidence.map((chunk) => chunk.text).join('\n'));
    // Tables carry the report's actual findings, and they bypass the prose body
    // entirely, so they need the same treatment or the doubt is lost where it
    // matters most.
    const markedTokens = [...new Set([...bodyScan.tokens, ...tableScan.tokens])];
    if (bodyScan.tokens.length > 0) {
      parsed.data.body = bodyScan.body;
    }
    if (tableScan.tokens.length > 0 && parsed.data.table) {
      parsed.data.table = tableScan.table as typeof parsed.data.table;
    }
    if (markedTokens.length > 0) {
      warnings.push(
        `The draft repeated a token the source read imperfectly (${markedTokens.join(', ')}); each is marked [sic?] in the text. Check it against the original screenshot.`,
      );
    }
    for (const note of evidenceNotes) warnings.push(note);

    // A section whose evidence contained a doubtful token must still tell the
    // reader to check it against the screenshot, even though the marker itself is
    // gone from the body.
    if (evidence.some((chunk) => chunk.text.includes('[OCR?'))) {
      warnings.push(
        'Some command names in this section come from a screenshot the OCR read imperfectly. Check them against the original image before submitting.',
      );
    }
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
      table: parsed.data.table ?? null,
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
      /** Structural table for this section, when the heading asked for one. */
      table?: { columns: string[]; rows: string[][]; caption?: string } | null;
    },
  ) {
    // Typing into a section must not silently delete its table, so an edit keeps
    // whatever table was generated. Only generation replaces it.
    const tableValue = extra.table === undefined ? undefined : extra.table;
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
        ...(tableValue !== undefined ? { tableData: tableValue } : {}),
        generatedAt: new Date(),
        wordCount: countWords(content),
        updatedAt: new Date(),
      })
      .where(and(eq(reportSections.templateSectionId, sectionId), eq(reportSections.userId, ctx.userId)))
      .returning();
    return row!;
  }

  /**
   * True when the section sits in the first few slots of the document.
   *
   * Covers are recognised partly by position: the first lines of a report are
   * title matter even when their wording is unusual ("LAMPUNG SELATAN 2026").
   */
  private async isNearDocumentStart(ctx: AuthContext, projectId: string, sortOrder: number): Promise<boolean> {
    const [row] = await this.db
      .select({ first: sql<number>`min(${templateSections.sortOrder})` })
      .from(templateSections)
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)));
    const first = Number(row?.first ?? 0);
    return sortOrder - first < 8;
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
  ): Promise<{
    results: Array<{ sectionId: string; ok: boolean; error?: string }>;
    generated: number;
    failed: number;
    /**
     * Sections that were deliberately left alone because the per-job cap was hit.
     *
     * The cap exists to bound a single job's cost, but silently slicing the list
     * meant a 44-section report stopping at 40 still reported success with
     * `failed: 0` — the last four sections were never attempted and nothing said
     * so. Callers must be told the difference between "wrote it" and "never tried".
     */
    deferred: Array<{ sectionId: string; heading: string }>;
    /**
     * Sections whose text was kept from the template instead of generated
     * (cover lines, rubric sheets). Reported separately so a summary never claims
     * they were "drafted" — nothing was written for them by design.
     */
    keptTemplateText: Array<{ sectionId: string; heading: string }>;
    /**
     * Total `[MISSING: …]` markers across the drafted sections.
     *
     * A section can map fine and still leave facts unfilled, because the model
     * flagged data no source provided (a student's name, an NIM, a cover logo).
     * Those markers are exported verbatim, so "44 of 44 drafted" must not hide
     * the fact that the shipped file still asks to be completed.
     */
    unfilledDetails: number;
  }> {
    const eligible = await this.eligibleSections(ctx, projectId);
    const selected = options.sectionIds ? eligible.filter((s) => options.sectionIds!.includes(s.id)) : eligible;
    const limited = selected.slice(0, this.config.AI_MAX_SECTIONS_PER_JOB);
    const deferred = selected.slice(this.config.AI_MAX_SECTIONS_PER_JOB).map((section) => ({
      sectionId: section.id,
      heading: section.heading,
    }));

    const existing = await this.db
      .select({ sectionId: reportSections.templateSectionId, content: reportSections.content, status: reportSections.status })
      .from(reportSections)
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)));
    const existingMap = new Map(existing.map((row) => [row.sectionId, row]));

    const results: Array<{ sectionId: string; ok: boolean; error?: string }> = [];
    const keptTemplateText: Array<{ sectionId: string; heading: string }> = [];
    let done = 0;
    for (const section of limited) {
      const prior = existingMap.get(section.id);
      // A cleared cover section is intentionally empty (its content is the
      // template's own), so "has content" is not the test for skipping it.
      const already = prior?.content.trim() ?? '';
      if (already && !options.regenerateExisting) {
        results.push({ sectionId: section.id, ok: true });
        done += 1;
        continue;
      }
      await onProgress?.(done, limited.length, section.heading);
      try {
        const outcome = await this.generateSection(ctx, projectId, section.id, {
          providerCredentialId: options.providerCredentialId,
          keepEdits: true,
          jobId: options.jobId,
        });
        results.push({ sectionId: section.id, ok: true });
        if (outcome.keptTemplateText) keptTemplateText.push({ sectionId: section.id, heading: section.heading });
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

    // Count the gap markers that actually ended up in the report, so the caller
    // can warn that the exported file still needs a human to fill them in.
    const written = await this.db
      .select({ content: reportSections.content })
      .from(reportSections)
      .where(and(eq(reportSections.projectId, projectId), eq(reportSections.userId, ctx.userId)));
    const unfilledDetails = written.reduce(
      (total, row) => total + (String(row.content ?? '').match(/\[MISSING:[^\]]*\]/g)?.length ?? 0),
      0,
    );

    return { results, generated: results.length - failed, failed, deferred, keptTemplateText, unfilledDetails };
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
