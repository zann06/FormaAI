import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { AuthContext } from '../auth/index.js';
import { projects, sectionMappings, templateSections } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { FactConflict } from '@formaai/shared';
import type { CredentialService } from '../credentials/index.js';
import type { FactService } from '../facts/index.js';
import { completeWithFallback, ProviderError, type ProviderRegistry } from '@formaai/ai-providers';
import { coverageFromEvidence, loadProjectChunks, rankEvidence, type EvidenceChunk } from './retrieval.js';
import { buildMappingMessages } from './mapping-prompt.js';
import { mappingZod, parseModelJson } from '../generation/schemas.js';

const MAPPING_JSON_SCHEMA = {
  name: 'evidence_mapping',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sections'],
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sectionId', 'purpose', 'requirements', 'evidenceChunkIds', 'gaps', 'contentPlan'],
          properties: {
            sectionId: { type: 'string' },
            purpose: { type: 'string' },
            requirements: { type: 'array', items: { type: 'string' } },
            evidenceChunkIds: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } },
            contentPlan: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};
import { UsageService } from '../usage/index.js';

export interface MappingPreview {
  sectionId: string;
  sectionKey: string;
  heading: string;
  level: number;
  purpose: string;
  requirements: string[];
  evidence: Array<{ chunkId: string; documentName: string; page: number | null; paragraphIndex: number | null; excerpt: string }>;
  gaps: string[];
  conflicts: FactConflict[];
  contentPlan: string[];
  coverage: 'strong' | 'partial' | 'none';
  producedBy: 'heuristic' | 'ai';
}

const REQUIREMENT_HINTS: Array<{ pattern: RegExp; requirement: string; gapTemplate?: string }> = [
  { pattern: /(date|tanggal|period|periode|time|waktu)/i, requirement: 'State the relevant dates or period.', gapTemplate: 'No dates were found in the sources for this section.' },
  { pattern: /(budget|cost|biaya|anggaran|expense|pengeluaran|financial|keuangan)/i, requirement: 'Include the amounts and currency exactly as documented.', gapTemplate: 'No monetary figures were found in the sources for this section.' },
  { pattern: /(result|hasil|outcome|achievement|capai)/i, requirement: 'Describe outcomes with the figures reported in the sources.', gapTemplate: 'No quantified results were found in the sources.' },
  { pattern: /(conclusion|kesimpulan|summary|ringkasan)/i, requirement: 'Summarise only what earlier sections and the sources support.' },
  { pattern: /(introduction|pendahuluan|background|latar belakang)/i, requirement: 'Explain purpose, scope and context from the sources.' },
  { pattern: /(method|metode|approach|process|proses)/i, requirement: 'Describe the method or process as documented.' },
  { pattern: /(participant|peserta|member|anggota|committee|panitia)/i, requirement: 'Name participants or organisations exactly as written.' },
  { pattern: /(reference|referensi|bibliography|daftar pustaka|citation)/i, requirement: 'List only sources actually provided by the user.' },
];

export function deriveRequirements(heading: string, bodyPreview: string): { requirements: string[]; gaps: string[] } {
  const text = `${heading} ${bodyPreview}`;
  const requirements: string[] = [];
  const gaps: string[] = [];
  for (const hint of REQUIREMENT_HINTS) {
    if (hint.pattern.test(text)) {
      requirements.push(hint.requirement);
      if (hint.gapTemplate) gaps.push(hint.gapTemplate);
    }
  }
  if (requirements.length === 0) requirements.push('Cover the topic of this heading using only the supplied evidence.');
  return { requirements: requirements.slice(0, 6), gaps };
}

export class MappingService {
  private readonly usage: UsageService;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly credentials: CredentialService,
    private readonly facts: FactService,
    private readonly registry: ProviderRegistry,
  ) {
    this.usage = new UsageService(db);
  }

  private async getProject(ctx: AuthContext, projectId: string) {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!row) throw notFound('Project not found');
    return row;
  }

  /**
   * Builds (and persists) evidence mappings for every non-excluded section.
   * Retrieval is deterministic; when a provider is configured and `useAi` is true
   * an AI pass refines purpose/requirements/plan and may add evidence.
   */
  async buildMappings(
    ctx: AuthContext,
    projectId: string,
    options: { useAi?: boolean; providerCredentialId?: string; jobId?: string } = {},
  ): Promise<{ mappings: MappingPreview[]; producedBy: 'heuristic' | 'ai'; fallbackUsed: boolean; note?: string }> {
    const project = await this.getProject(ctx, projectId);
    const sections = await this.db
      .select()
      .from(templateSections)
      .where(and(eq(templateSections.projectId, projectId), eq(templateSections.userId, ctx.userId)))
      .orderBy(asc(templateSections.sortOrder));
    if (sections.length === 0) {
      throw conflict('Analyse a DOCX template before mapping evidence');
    }
    const chunks = await loadProjectChunks(this.db, ctx, projectId);
    const conflicts = await this.facts.conflictsForProject(ctx, projectId);

    const heuristic: MappingPreview[] = sections.map((section) => {
      const { requirements, gaps } = deriveRequirements(`${section.heading} ${section.bodyPreview ?? ''}`, '');
      const ranked = rankEvidence(
        {
          heading: section.heading,
          instructions: section.instructions ?? undefined,
          bodyPreview: section.bodyPreview ?? undefined,
        },
        chunks,
        { topK: 6 },
      );
      const sectionConflicts = conflicts.filter((conflictItem) =>
        ranked.some((entry) =>
          conflictItem.values.some((value) => value.documentName === entry.chunk.documentName),
        ),
      );
      const combinedGaps = [...gaps];
      if (ranked.length === 0) combinedGaps.unshift('No matching evidence was found in the uploaded sources for this section.');
      const evidenceText = ranked.map((r) => r.chunk.text).join(' ');
      return {
        sectionId: section.id,
        sectionKey: section.sectionKey,
        heading: section.heading,
        level: section.level,
        purpose: `Document the "${section.heading}" part of the report using the supplied evidence.`,
        requirements,
        evidence: ranked.map((entry) => toEvidencePreview(entry.chunk, entry.score)),
        gaps: combinedGaps,
        conflicts: sectionConflicts,
        contentPlan: ranked.slice(0, 4).map((entry) => summariseChunk(entry.chunk)),
        coverage: coverageFromEvidence(ranked.length, evidenceText.length),
        producedBy: 'heuristic' as const,
      };
    });

    let producedBy: 'heuristic' | 'ai' = 'heuristic';
    let fallbackUsed = false;
    let note: string | undefined;

    const wantsAi = options.useAi ?? true;
    let config: Awaited<ReturnType<CredentialService['getDefault']>> = null;
    if (wantsAi) {
      try {
        const resolved = await this.credentials.resolveForGeneration(ctx, options.providerCredentialId);
        const result = await completeWithFallback({
          registry: this.registry,
          primary: resolved.primary,
          fallback: resolved.fallback,
          request: {
            messages: buildMappingMessages({
              projectTitle: project.title,
              language: project.language,
              sections: heuristic.map((section) => ({
                sectionId: section.sectionId,
                heading: section.heading,
                level: section.level,
                requirements: section.requirements,
                evidence: section.evidence.map((e) => ({ id: e.chunkId, text: e.excerpt })),
              })),
            }),
            jsonSchema: MAPPING_JSON_SCHEMA,
          },
          onAttempt: async (credentialId, outcome, error) => {
            await this.usage.record(ctx, {
              projectId,
              credentialId,
              jobId: options.jobId,
              providerType: resolved.primary.providerType,
              model: resolved.primary.model,
              operation: 'mapping',
              status: outcome,
              errorCode: error?.code,
              durationMs: undefined,
              inputTokens: undefined,
              outputTokens: undefined,
            });
          },
        });
        fallbackUsed = result.fellBack;
        const parsed = mappingZod.safeParse(parseModelJson(result.result.text));
        if (!parsed.success) throw new ProviderError('The model returned an invalid mapping payload', 'INVALID_RESPONSE');
        producedBy = 'ai';
        this.applyAiMapping(heuristic, parsed.data.sections, chunks);
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'ABORTED') throw error;
        note =
          error instanceof ProviderError
            ? `Evidence mapping ran in deterministic mode: ${error.message}`
            : `Evidence mapping ran in deterministic mode: ${(error as Error).message}`;
      }
    } else {
      note = 'Evidence mapping ran in deterministic mode because no AI provider was requested.';
    }
    void config;

    await this.persist(ctx, projectId, heuristic);
    await this.db
      .update(projects)
      .set({ mappingReady: true, status: 'needs_review', updatedAt: new Date(), lastActivityAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));

    return { mappings: heuristic, producedBy, fallbackUsed, note };
  }

  private applyAiMapping(
    previews: MappingPreview[],
    aiSections: Array<{
      sectionId: string;
      purpose: string;
      requirements: string[];
      evidenceChunkIds: string[];
      gaps: string[];
      contentPlan: string[];
    }>,
    chunks: EvidenceChunk[],
  ): void {
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    for (const preview of previews) {
      const ai = aiSections.find((s) => s.sectionId === preview.sectionId || s.sectionId === preview.sectionKey);
      if (!ai) continue;
      preview.purpose = ai.purpose || preview.purpose;
      preview.requirements = ai.requirements.length ? ai.requirements.slice(0, 8) : preview.requirements;
      // Only chunk ids that really exist (and therefore belong to this project) are kept.
      const validIds = ai.evidenceChunkIds.filter((id) => byId.has(id));
      if (validIds.length > 0) {
        preview.evidence = validIds.slice(0, 10).map((id) => toEvidencePreview(byId.get(id)!, 1));
      }
      preview.gaps = Array.from(new Set([...ai.gaps, ...preview.gaps])).slice(0, 8);
      preview.contentPlan = ai.contentPlan.length ? ai.contentPlan.slice(0, 8) : preview.contentPlan;
      const totalChars = preview.evidence.reduce((sum, e) => sum + e.excerpt.length, 0);
      preview.coverage = coverageFromEvidence(preview.evidence.length, totalChars);
      preview.producedBy = 'ai';
    }
  }

  private async persist(ctx: AuthContext, projectId: string, previews: MappingPreview[]) {
    await this.db.transaction(async (tx) => {
      for (const preview of previews) {
        await tx
          .insert(sectionMappings)
          .values({
            userId: ctx.userId,
            projectId,
            sectionId: preview.sectionId,
            purpose: preview.purpose,
            requirements: preview.requirements,
            evidenceChunkIds: preview.evidence.map((e) => e.chunkId),
            gaps: preview.gaps,
            conflicts: preview.conflicts,
            contentPlan: preview.contentPlan,
            coverage: preview.coverage,
            producedBy: preview.producedBy,
          })
          .onConflictDoUpdate({
            target: sectionMappings.sectionId,
            set: {
              purpose: preview.purpose,
              requirements: preview.requirements,
              evidenceChunkIds: preview.evidence.map((e) => e.chunkId),
              gaps: preview.gaps,
              conflicts: preview.conflicts,
              contentPlan: preview.contentPlan,
              coverage: preview.coverage,
              producedBy: preview.producedBy,
              updatedAt: new Date(),
            },
          });
      }
    });
  }

  /** Loads stored mappings together with the evidence text for the review UI. */
  async loadMappings(ctx: AuthContext, projectId: string): Promise<MappingPreview[]> {
    await this.getProject(ctx, projectId);
    const rows = await this.db
      .select({
        mapping: sectionMappings,
        section: templateSections,
      })
      .from(sectionMappings)
      .innerJoin(templateSections, eq(templateSections.id, sectionMappings.sectionId))
      .where(and(eq(sectionMappings.projectId, projectId), eq(sectionMappings.userId, ctx.userId)))
      .orderBy(asc(templateSections.sortOrder));

    const allIds = Array.from(new Set(rows.flatMap((row) => row.mapping.evidenceChunkIds)));
    const chunks = await loadProjectChunks(this.db, ctx, projectId);
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));

    return rows.map(({ mapping, section }) => ({
      sectionId: section.id,
      sectionKey: section.sectionKey,
      heading: section.heading,
      level: section.level,
      purpose: mapping.purpose ?? '',
      requirements: mapping.requirements,
      evidence: mapping.evidenceChunkIds
        .map((id) => byId.get(id))
        .filter((chunk): chunk is EvidenceChunk => Boolean(chunk))
        .map((chunk) => toEvidencePreview(chunk, 1)),
      gaps: mapping.gaps,
      conflicts: (mapping.conflicts as FactConflict[]) ?? [],
      contentPlan: mapping.contentPlan,
      coverage: mapping.coverage as MappingPreview['coverage'],
      producedBy: mapping.producedBy as 'heuristic' | 'ai',
    })).map((preview) => preview && { ...preview, evidence: preview.evidence.slice(0, 12) })
      .filter((preview) => preview !== null)
      .map((preview) => {
        void allIds;
        return preview;
      });
  }

  async updateMapping(
    ctx: AuthContext,
    projectId: string,
    sectionId: string,
    input: { evidenceChunkIds?: string[]; gaps?: string[]; contentPlan?: string[]; purpose?: string; requirements?: string[] },
  ): Promise<void> {
    await this.getProject(ctx, projectId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.evidenceChunkIds !== undefined) {
      const chunks = await loadProjectChunks(this.db, ctx, projectId);
      const owned = new Set(chunks.map((c) => c.id));
      if (input.evidenceChunkIds.some((id) => !owned.has(id))) throw notFound('Evidence not found in this project');
      patch.evidenceChunkIds = input.evidenceChunkIds;
      const selected = chunks.filter((c) => input.evidenceChunkIds!.includes(c.id));
      patch.coverage = coverageFromEvidence(selected.length, selected.reduce((sum, c) => sum + c.text.length, 0));
    }
    if (input.gaps !== undefined) patch.gaps = input.gaps;
    if (input.contentPlan !== undefined) patch.contentPlan = input.contentPlan;
    if (input.purpose !== undefined) patch.purpose = input.purpose;
    if (input.requirements !== undefined) patch.requirements = input.requirements;

    const result = await this.db
      .update(sectionMappings)
      .set(patch)
      .where(
        and(
          eq(sectionMappings.sectionId, sectionId),
          eq(sectionMappings.projectId, projectId),
          eq(sectionMappings.userId, ctx.userId),
        ),
      )
      .returning({ id: sectionMappings.id });
    if (result.length === 0) throw notFound('Mapping not found');
  }

  async gapsSummary(ctx: AuthContext, projectId: string) {
    await this.getProject(ctx, projectId);
    const rows = await this.db
      .select({
        sectionId: sectionMappings.sectionId,
        heading: templateSections.heading,
        required: templateSections.required,
        coverage: sectionMappings.coverage,
        gaps: sectionMappings.gaps,
        conflicts: sectionMappings.conflicts,
      })
      .from(sectionMappings)
      .innerJoin(templateSections, eq(templateSections.id, sectionMappings.sectionId))
      .where(
        and(
          eq(sectionMappings.projectId, projectId),
          eq(sectionMappings.userId, ctx.userId),
          eq(templateSections.excluded, false),
        ),
      )
      .orderBy(asc(templateSections.sortOrder));

    const projectConflicts = await this.facts.conflictsForProject(ctx, projectId);
    const missing = rows
      .filter((row) => row.coverage !== 'strong' || row.gaps.length > 0)
      .map((row) => ({ sectionId: row.sectionId, heading: row.heading, required: row.required, coverage: row.coverage, gaps: row.gaps }));
    const conflictTotals = rows.reduce((sum, row) => sum + ((row.conflicts as unknown[])?.length ?? 0), 0);
    return {
      missing,
      conflicts: projectConflicts,
      conflictCount: Math.max(conflictTotals, projectConflicts.length),
      blockedSections: rows.filter((row) => row.required && row.coverage === 'none').length,
    };
  }
}

function toEvidencePreview(chunk: EvidenceChunk, score: number) {
  return {
    chunkId: chunk.id,
    documentName: chunk.documentName,
    page: chunk.page,
    paragraphIndex: chunk.paragraphIndex,
    excerpt: chunk.text.length > 600 ? `${chunk.text.slice(0, 600)}…` : chunk.text,
    score,
  };
}

function summariseChunk(chunk: EvidenceChunk): string {
  const firstSentence = chunk.text.split(/(?<=[.!?])\s/)[0] ?? chunk.text;
  const location = chunk.page ? `page ${chunk.page}` : chunk.paragraphIndex !== null ? `paragraph ${chunk.paragraphIndex + 1}` : 'source';
  return `${firstSentence.slice(0, 160)} (${chunk.documentName}, ${location})`;
}

void sql;
