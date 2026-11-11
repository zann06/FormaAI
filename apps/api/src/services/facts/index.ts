import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { documents, projects, sourceFacts, users } from '../../db/schema.js';
import type { AuthContext } from '../auth/index.js';
import type { FactCandidate, FactConflict } from '@formaai/shared';

/**
 * Deterministic fact extraction from chunks.
 *
 * These are *candidates*: sentence-level units with detected categories and
 * provenance. They are what the mapping stage retrieves and what factual
 * validation checks generated text against. Nothing here calls an LLM, so the
 * pipeline works (and is testable) without a provider.
 */

const DATE_PATTERNS = [
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4}\b/gi,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Agustus|Oktober|Desember)\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
];

const MONEY_PATTERN = /(?:Rp\.?|IDR|USD|\$|€|£)\s?\d[\d.,]*\s?(?:juta|ribu|million|billion|miliar|bn|k|M)?/gi;
const PERCENT_PATTERN = /\b\d+(?:[.,]\d+)?\s?%/g;
const NUMBER_PATTERN = /\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\b/g;
const ORGANIZATION_PATTERN =
  /\b(?:PT|CV|UD|Tbk|Inc|Ltd|LLC|GmbH|Corp|Corporation|Company|University|Universitas|Politeknik|Sekolah|Dinas|Kementerian|Ministry|Bank|Institute|Institut)\b\.?\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}/g;
const NAME_PATTERN = /\b(?:Mr|Mrs|Ms|Dr|Prof|Ir|Drs|Bapak|Ibu|Pak|Bu)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

interface Detected {
  category: FactCandidate['category'];
  value: string;
  subject: string | null;
}

export function detectFact(sentence: string): Detected | null {
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(sentence);
    if (match) return { category: 'date', value: match[0], subject: guessSubject(sentence, match.index) };
  }
  MONEY_PATTERN.lastIndex = 0;
  const money = MONEY_PATTERN.exec(sentence);
  if (money) return { category: 'money', value: money[0].trim(), subject: guessSubject(sentence, money.index) };

  PERCENT_PATTERN.lastIndex = 0;
  const percent = PERCENT_PATTERN.exec(sentence);
  if (percent) return { category: 'percent', value: percent[0], subject: guessSubject(sentence, percent.index) };

  ORGANIZATION_PATTERN.lastIndex = 0;
  const org = ORGANIZATION_PATTERN.exec(sentence);
  if (org) return { category: 'organization', value: org[0].trim(), subject: guessSubject(sentence, org.index) };

  NAME_PATTERN.lastIndex = 0;
  const name = NAME_PATTERN.exec(sentence);
  if (name) return { category: 'name', value: name[0].trim(), subject: guessSubject(sentence, name.index) };

  NUMBER_PATTERN.lastIndex = 0;
  const number = NUMBER_PATTERN.exec(sentence);
  if (number && /\d{2,}/.test(number[0])) {
    return { category: 'number', value: number[0], subject: guessSubject(sentence, number.index) };
  }
  if (sentence.length >= 40) return { category: 'statement', value: sentence.slice(0, 300), subject: null };
  return null;
}

function guessSubject(sentence: string, valueIndex: number): string | null {
  const before = sentence.slice(0, valueIndex).trim();
  const words = before.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.slice(-6).join(' ').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim().slice(-120) || null;
}

export function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(january|januari)\b/g, '01')
    .replace(/\b(february|februari)\b/g, '02')
    .replace(/\b(march|maret)\b/g, '03')
    .replace(/\b(april)\b/g, '04')
    .replace(/\b(may|mei)\b/g, '05')
    .replace(/\b(june|juni)\b/g, '06')
    .replace(/\b(july|juli)\b/g, '07')
    .replace(/\b(august|agustus)\b/g, '08')
    .replace(/\b(september)\b/g, '09')
    .replace(/\b(october|oktober)\b/g, '10')
    .replace(/\b(november)\b/g, '11')
    .replace(/\b(december|desember)\b/g, '12')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CandidateWithLocation extends FactCandidate {
  documentId: string;
  documentName: string;
}

export function buildCandidates(
  chunks: Array<{ id: string; documentId: string; text: string; page: number | null; paragraphIndex: number | null; documentName: string }>,
): Array<FactCandidate & { chunkId: string; documentId: string; documentName: string }> {
  const out: Array<FactCandidate & { chunkId: string; documentId: string; documentName: string }> = [];
  for (const chunk of chunks) {
    const sentences = splitSentences(chunk.text);
    for (const sentence of sentences.slice(0, 40)) {
      const detected = detectFact(sentence);
      if (!detected) continue;
      out.push({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        text: sentence.slice(0, 500),
        category: detected.category,
        subject: detected.subject,
        value: detected.value,
        normalizedValue: normalizeValue(detected.value),
        page: chunk.page,
        paragraphIndex: chunk.paragraphIndex,
        confidence: detected.category === 'statement' ? 0.4 : 0.7,
      });
    }
  }
  return out.slice(0, 4000);
}

/**
 * Groups facts by (subject, category) and reports groups with differing values.
 * Conflicts are surfaced to the user — never auto-resolved.
 */
export function detectConflicts(facts: CandidateWithLocation[]): FactConflict[] {
  const groups = new Map<string, CandidateWithLocation[]>();
  for (const fact of facts) {
    if (!fact.subject || fact.category === 'statement') continue;
    const key = `${fact.category}::${fact.subject}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  const conflicts: FactConflict[] = [];
  for (const [key, list] of groups) {
    const values = new Map<string, CandidateWithLocation[]>();
    for (const fact of list) {
      const normalized = fact.normalizedValue ?? normalizeValue(fact.value ?? '');
      if (!normalized) continue;
      const bucket = values.get(normalized) ?? [];
      bucket.push(fact);
      values.set(normalized, bucket);
    }
    if (values.size < 2) continue;
    // Only report when the differing values come from different documents, or
    // clearly disagree (this avoids noise from repeated statements).
    const distinctDocs = new Set(list.map((f) => f.documentId));
    if (distinctDocs.size < 2) continue;
    conflicts.push({
      key,
      label: `${list[0]!.category} · ${list[0]!.subject}`,
      values: Array.from(values.entries()).slice(0, 6).map(([value, items]) => ({
        value,
        documentId: items[0]!.documentId,
        documentName: items[0]!.documentName,
        chunkId: items[0]!.chunkId,
        page: items[0]!.page,
      })),
    });
  }
  return conflicts;
}

export class FactService {
  constructor(private readonly db: Database) {}

  async rebuildForProject(ctx: AuthContext, projectId: string) {
    const chunks = await this.db
      .select({
        id: sql<string>`c.id`,
        documentId: sql<string>`c.document_id`,
        text: sql<string>`c.text`,
        page: sql<number | null>`c.page`,
        paragraphIndex: sql<number | null>`c.paragraph_index`,
        documentName: sql<string>`d.original_name`,
      })
      .from(sql`extracted_chunks c join documents d on d.id = c.document_id`)
      .where(sql`c.project_id = ${projectId} and c.user_id = ${ctx.userId}`)
      .orderBy(sql`c.ordinal asc`);

    const candidates = buildCandidates(chunks);
    await this.db.transaction(async (tx) => {
      await tx.delete(sourceFacts).where(and(eq(sourceFacts.projectId, projectId), eq(sourceFacts.userId, ctx.userId)));
      if (candidates.length === 0) return;
      for (let i = 0; i < candidates.length; i += 300) {
        const slice = candidates.slice(i, i + 300);
        await tx.insert(sourceFacts).values(
          slice.map((candidate) => ({
            userId: ctx.userId,
            projectId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            text: candidate.text,
            category: candidate.category,
            subject: candidate.subject,
            value: candidate.value,
            normalizedValue: candidate.normalizedValue,
            page: candidate.page,
            confidence: candidate.confidence,
            producedBy: 'heuristic',
          })),
        );
      }
    });
    return candidates.length;
  }

  async listForProject(ctx: AuthContext, projectId: string, limit = 500) {
    return this.db
      .select({
        id: sourceFacts.id,
        chunkId: sourceFacts.chunkId,
        documentId: sourceFacts.documentId,
        documentName: documents.originalName,
        text: sourceFacts.text,
        category: sourceFacts.category,
        subject: sourceFacts.subject,
        value: sourceFacts.value,
        page: sourceFacts.page,
        confidence: sourceFacts.confidence,
        producedBy: sourceFacts.producedBy,
        reviewStatus: sourceFacts.reviewStatus,
      })
      .from(sourceFacts)
      .innerJoin(documents, eq(documents.id, sourceFacts.documentId))
      .where(and(eq(sourceFacts.projectId, projectId), eq(sourceFacts.userId, ctx.userId)))
      .orderBy(asc(sourceFacts.category), asc(sourceFacts.createdAt))
      .limit(limit);
  }

  async conflictsForProject(ctx: AuthContext, projectId: string): Promise<FactConflict[]> {
    const facts = await this.listForProject(ctx, projectId, 4000);
    return detectConflicts(
      facts.map((f) => ({
        chunkId: f.chunkId,
        documentId: f.documentId,
        documentName: f.documentName,
        text: f.text,
        category: f.category as FactCandidate['category'],
        subject: f.subject,
        value: f.value,
        normalizedValue: f.value ? normalizeValue(f.value) : null,
        page: f.page,
        paragraphIndex: null,
        confidence: f.confidence,
      })),
    );
  }

  async stats(ctx: AuthContext, projectId: string) {
    const rows = await this.db
      .select({ category: sourceFacts.category, count: sql<number>`count(*)::int` })
      .from(sourceFacts)
      .where(and(eq(sourceFacts.projectId, projectId), eq(sourceFacts.userId, ctx.userId)))
      .groupBy(sourceFacts.category);
    return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
  }

  async setReviewStatus(ctx: AuthContext, factId: string, status: 'unreviewed' | 'confirmed' | 'rejected') {
    const [row] = await this.db
      .update(sourceFacts)
      .set({ reviewStatus: status })
      .where(and(eq(sourceFacts.id, factId), eq(sourceFacts.userId, ctx.userId)))
      .returning({ id: sourceFacts.id, reviewStatus: sourceFacts.reviewStatus });
    return row ?? null;
  }
}

void isNull;
void projects;
void users;
