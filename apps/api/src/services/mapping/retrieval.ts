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
}

/**
 * Hybrid-safe evidence retrieval: deterministic BM25 over chunk text against a
 * query built from the section heading, its template body preview, and user
 * instructions. AI re-ranking (when configured) happens in the mapping service;
 * this pure function is the part that always runs and is unit tested.
 */
export function rankEvidence(
  query: RetrievalQuery,
  chunks: EvidenceChunk[],
  options: RetrievalOptions = {},
): Array<{ chunk: EvidenceChunk; score: number }> {
  const { topK = 8, minScore = 0.15 } = options;
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
  return ranked
    .filter((entry) => entry.score >= minScore)
    .map((entry) => ({ chunk: entry.item, score: entry.score }));
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
