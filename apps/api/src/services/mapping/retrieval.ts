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
  // Search in the vocabulary the sources use, not just the wording of the heading.
  const expandedQuery = expandQuery(queryText);
  const ranked = bm25Rank(
    expandedQuery,
    chunks.map((chunk) => ({ item: chunk, text: `${chunk.headingPath ?? ''} ${chunk.text}` })),
    { limit: topK * 4 },
  );
  const matched = ranked
    .filter((entry) => entry.score >= minScore)
    .map((entry) => ({ chunk: entry.item, score: entry.score }));

  if (matched.length > 0) return diversifyByDocument(matched, topK);

  if (fallback.length === 0) return matched;

  // No keyword overlap: rank the fallback pool by how much of the heading it
  // covers, keeping a document-order tiebreak so the result stays deterministic.
  const scoredFallback = bm25Rank(
    expandedQuery,
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
 * Guarantees every relevant source gets a seat at the table.
 *
 * One screenshot produces dozens of chunks, and BM25 happily returns ten of them
 * from the same document — which is how section 2.2 (VLSM) ended up reading six
 * ping screenshots while the DHCP-pool table that actually answered it was never
 * mapped. Taking the best chunk of each document first, then filling the remaining
 * slots by score, keeps the most relevant evidence without letting one source
 * crowd out the rest.
 */
/**
 * Domain synonyms that bridge the wording gap between a heading and its evidence.
 *
 * A template heading says "Desain Subnetting Berbasis VLSM"; the screenshot that
 * answers it says "Pool Name / Default Gateway / Start IP Address". Those share no
 * words, so BM25 scored the answering chunk 0.000 and left the section to a generic
 * topical fallback — which is why the VLSM section was drafted from ping
 * screenshots. Expanding the query with the vocabulary the sources actually use
 * fixes that without weakening the relevance threshold.
 */
const DOMAIN_SYNONYMS: Array<{ match: RegExp; expand: string[] }> = [
  {
    match: /\b(vlsm|subnet|subnetting|subnetting|pengalamatan|prefix|netmask)\b/i,
    expand: ['pool', 'subnet', 'mask', 'gateway', 'start ip', 'wildcard', 'broadcast', 'host', 'prefix', 'alamat'],
  },
  {
    match: /\b(dhcp)\b/i,
    expand: ['dhcp', 'pool', 'lease', 'gateway', 'dns', 'start ip', 'excluded'],
  },
  {
    match: /\b(routing|rute|route|forwarding)\b/i,
    expand: ['route', 'routing', 'codes', 'connected', 'static', 'next hop', 'metric', 'via'],
  },
  {
    match: /\b(ospf)\b/i,
    expand: ['ospf', 'neighbor', 'adjacency', 'area', 'cost', 'hello', 'dr', 'bdr'],
  },
  {
    match: /\b(ping|konektivitas|connectivity)\b/i,
    expand: ['ping', 'pinging', 'reply', 'bytes', 'ttl', 'time', 'lost'],
  },
  {
    match: /\b(traceroute|tracert|penelusuran|jalur)\b/i,
    expand: ['tracert', 'traceroute', 'tracing', 'hops', 'route', 'ms'],
  },
  {
    match: /\b(interface|antarmuka|konfigurasi)\b/i,
    expand: ['interface', 'brief', 'status', 'protocol', 'up', 'down', 'ip-address', 'gigabitethernet'],
  },
  {
    match: /\b(topologi|arsitektur|desain|diagram)\b/i,
    expand: ['topology', 'router', 'switch', 'server', 'pc', 'laptop', 'gig', 'fa', 'access point'],
  },
  {
    match: /\b(nirkabel|wireless|wifi|access point|ssid)\b/i,
    expand: ['ssid', 'wpa', 'wireless', 'authentication', 'port', 'access point'],
  },
];

/** Expands a heading into the vocabulary its evidence is likely written in. */
function expandQuery(text: string): string {
  const extra: string[] = [];
  for (const { match, expand } of DOMAIN_SYNONYMS) {
    if (match.test(text)) extra.push(...expand);
  }
  return extra.length > 0 ? `${text} ${extra.join(' ')}` : text;
}

function diversifyByDocument<T extends { chunk: { documentId: string }; score: number }>(
  entries: T[],
  limit: number,
): T[] {
  const bestPerDocument = new Map<string, T>();
  for (const entry of entries) {
    const current = bestPerDocument.get(entry.chunk.documentId);
    if (!current || entry.score > current.score) bestPerDocument.set(entry.chunk.documentId, entry);
  }
  const winners = [...bestPerDocument.values()].sort((a, b) => b.score - a.score);
  const picked = winners.slice(0, limit);
  // Remaining slots go to the next-best entries overall, so a strong source can
  // still contribute more than one chunk.
  const chosen = new Set(picked);
  for (const entry of entries) {
    if (picked.length >= limit) break;
    if (chosen.has(entry)) continue;
    picked.push(entry);
    chosen.add(entry);
  }
  return picked;
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
