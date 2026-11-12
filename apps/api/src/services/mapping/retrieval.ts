import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { AuthContext } from '../auth/index.js';
import { bm25Rank, tokenize } from '@formaai/shared';

export interface EvidenceChunk {
  id: string;
  documentId: string;
  documentName: string;
  text: string;
  page: number | null;
  paragraphIndex: number | null;
  headingPath: string | null;
  ordinal: number;
}

export interface RetrievalQuery {
  heading: string;
  purpose?: string;
  instructions?: string;
  bodyPreview?: string;
}

export interface RetrievalOptions {
  topK?: number;
  minScore?: number;
  /**
   * Chunks every section may fall back to when its heading shares no words with
   * the sources. Supplying these turns "no lexical overlap" into "best available
   * topical evidence" instead of an empty section.
   */
  fallback?: EvidenceChunk[];
  /** How many fallback chunks a section may receive. */
  fallbackK?: number;
}

/**
 * Hybrid-safe evidence retrieval: deterministic BM25 over chunk text against a
 * query built from the section heading, its template body preview, and user
 * instructions. AI re-ranking (when configured) happens in the mapping service;
 * this pure function is the part that always runs and is unit tested.
 *
 * Headings in real templates are structural — "BAB I PENDAHULUAN", "1.1 Latar
 * Belakang", "2.1 Pembahasan" — and those words appear nowhere in a case
 * document that talks about switches and latency. BM25 then scores exactly 0 and
 * the section was mapped to nothing, so drafting produced "[MISSING: no source
 * material]" even though the sources were full of relevant material. When a
 * heading has no lexical overlap at all we therefore fall back to the project's
 * most on-topic chunks, at a reduced score so the UI can tell the two apart.
 */
export function rankEvidence(
  query: RetrievalQuery,
  chunks: EvidenceChunk[],
  options: RetrievalOptions = {},
): Array<{ chunk: EvidenceChunk; score: number }> {
  const { topK = 8, minScore = 0.15, fallback = [], fallbackK = 3 } = options;
  const queryText = [query.heading, query.heading, query.purpose ?? '', query.instructions ?? '', query.bodyPreview ?? '']
    .filter(Boolean)
    .join(' ');
  if (tokenize(queryText).length === 0) {
    return chunks.slice(0, Math.min(topK, 3)).map((chunk) => ({ chunk, score: 0.1 }));
  }
  const ranked = bm25Rank(
    queryText,
    chunks.map((chunk) => ({ item: chunk, text: `${chunk.headingPath ?? ''} ${chunk.text}` })),
    { limit: topK },
  );
  const matched = ranked
    .filter((entry) => entry.score >= minScore)
    .map((entry) => ({ chunk: entry.item, score: entry.score }));

  if (matched.length > 0 || fallback.length === 0) return matched;

  // No keyword overlap: rank the fallback pool by how much of the heading it
  // covers, keeping a document-order tiebreak so the result stays deterministic.
  const scoredFallback = bm25Rank(
    queryText,
    fallback.map((chunk) => ({ item: chunk, text: `${chunk.headingPath ?? ''} ${chunk.text}` })),
  );
  const pool = scoredFallback.some((entry) => entry.score > 0)
    ? scoredFallback.filter((entry) => entry.score > 0)
    : fallback.map((chunk) => ({ item: chunk, score: 0 }));
  return pool
    .slice(0, fallbackK)
    .map((entry) => ({ chunk: entry.item, score: Math.max(entry.score, 0.01) }));
}

/**
 * Picks the chunks that represent the project as a whole — used as the topical
 * fallback above. Prefers the opening of each source, where the subject of the
 * document is stated, and stays within a small character budget.
 */
export function buildTopicPool(chunks: EvidenceChunk[], options: { maxChunks?: number } = {}): EvidenceChunk[] {
  const { maxChunks = 8 } = options;
  const byDocument = new Map<string, EvidenceChunk[]>();
  for (const chunk of chunks) {
    const list = byDocument.get(chunk.documentId) ?? [];
    list.push(chunk);
    byDocument.set(chunk.documentId, list);
  }
  const picks: EvidenceChunk[] = [];
  for (const list of byDocument.values()) {
    const ordered = [...list].sort((a, b) => a.ordinal - b.ordinal);
    picks.push(...ordered.slice(0, 3));
  }
  // Longest chunks carry the most context; keep the pool small and stable.
  return picks
    .sort((a, b) => b.text.length - a.text.length || a.ordinal - b.ordinal)
    .slice(0, maxChunks)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function coverageFromEvidence(evidenceCount: number, totalChars: number): 'strong' | 'partial' | 'none' {
  if (evidenceCount === 0) return 'none';
  if (evidenceCount >= 3 && totalChars >= 600) return 'strong';
  return 'partial';
}

export async function loadProjectChunks(
  db: Database,
  ctx: AuthContext,
  projectId: string,
): Promise<EvidenceChunk[]> {
  const result = await db.execute<{
    id: string;
    document_id: string;
    document_name: string;
    text: string;
    page: number | null;
    paragraph_index: number | null;
    heading_path: string | null;
    ordinal: number;
  }>(sql`
    select c.id, c.document_id, d.original_name as document_name, c.text, c.page,
           c.paragraph_index, c.heading_path, c.ordinal
    from extracted_chunks c
    join documents d on d.id = c.document_id
    where c.project_id = ${projectId} and c.user_id = ${ctx.userId}
    order by c.ordinal asc
    limit 4000
  `);
  return result.rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    text: row.text,
    page: row.page,
    paragraphIndex: row.paragraph_index,
    headingPath: row.heading_path,
    ordinal: row.ordinal,
  }));
}
