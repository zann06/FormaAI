const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those of in on at to for from by with without into ' +
    "over under about as is are was were be been being it its we you they he she i our your their " +
    'not no nor so such can could should would may might must will shall do does did done have has had ' +
    'yang dan di ke dari untuk dengan pada adalah ini itu tidak akan dapat oleh sebagai juga atau karena ' +
    'akan tetapi namun serta para bagi kita kami mereka saya anda dia'
  ).split(/\s+/),
);

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

/**
 * Rank documents (chunks) against a query using a small BM25 implementation.
 * Deterministic, no external dependencies, good enough for evidence pre-filtering.
 */
export function bm25Rank<T>(
  query: string,
  documents: Array<{ item: T; text: string }>,
  options: { k1?: number; b?: number; limit?: number } = {},
): ScoredItem<T>[] {
  const { k1 = 1.4, b = 0.75, limit } = options;
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0 || documents.length === 0) {
    return [];
  }
  const docTokens = documents.map((d) => tokenize(d.text));
  const avgLen = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, docTokens.length) || 1;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const token of queryTokens) if (seen.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = documents.length;
  const scored = documents.map((doc, index) => {
    const tokens = docTokens[index] ?? [];
    const tf = termFrequency(tokens);
    let score = 0;
    for (const token of queryTokens) {
      const freq = tf.get(token) ?? 0;
      if (freq === 0) continue;
      const idf = Math.log(1 + (n - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5));
      const denom = freq + k1 * (1 - b + (b * tokens.length) / avgLen);
      score += idf * ((freq * (k1 + 1)) / denom);
    }
    return { item: doc.item, score };
  });
  const sorted = scored.sort((a, b2) => b2.score - a.score || 0);
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

/** Rough word count that handles CJK text better than split(' '). */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const latin = text
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Remove characters that are unsafe for filenames / headers, keeping the extension. */
export function safeFilename(input: string, fallback = 'file'): string {
  const base = input.split(/[/\\]/).pop() ?? fallback;
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  const noDots = cleaned.replace(/^\.+/, '');
  return (noDots || fallback).slice(0, 180);
}

export function extensionOf(filename: string): string {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  return match ? match[0].toLowerCase() : '';
}

export function chunkText(text: string, options: { maxChars?: number; overlap?: number } = {}): string[] {
  const maxChars = options.maxChars ?? 1200;
  const overlap = options.overlap ?? 120;
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let piece = '';
      for (const sentence of sentences) {
        if ((piece + ' ' + sentence).length > maxChars && piece) {
          chunks.push(piece.trim());
          piece = piece.slice(Math.max(0, piece.length - overlap));
        }
        piece = piece ? `${piece} ${sentence}` : sentence;
      }
      if (piece.trim()) current = piece.trim();
      continue;
    }
    if ((current + '\n\n' + trimmed).length > maxChars && current) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.trim().length > 0);
}

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Markers a draft can leave behind, in either report language.
 *
 * `[MISSING: …]` is the English form; `[PERLU DICEK: …]` the Indonesian one. Both
 * mean "a human must supply or verify this", so every place that counts gaps, or
 * decides a section is empty, has to recognise both — otherwise an Indonesian
 * report would look complete while still carrying a hole.
 */
export const GAP_MARKER_PATTERN = /\[(?:MISSING|PERLU DICEK)\s*:[^\]]*\]/gi;

/** Matches a gap marker, without the global flag (safe for `.test`). */
export const GAP_MARKER_TEST = /\[(?:MISSING|PERLU DICEK)\s*:/i;

/** Counts the gap markers in a piece of text. */
export function countGapMarkers(text: string): number {
  return text.match(GAP_MARKER_PATTERN)?.length ?? 0;
}

/** True when the text is nothing but gap markers (and whitespace). */
export function isOnlyGapMarkers(text: string): boolean {
  if (!GAP_MARKER_TEST.test(text)) return false;
  return text.replace(GAP_MARKER_PATTERN, '').trim().length === 0;
}

/**
 * Marker for a value the model computed rather than read from the evidence.
 *
 * The report is allowed to do the work — VLSM maths, derived conclusions — but the
 * reader must be able to tell a computed figure from a recorded one, so every
 * derived value carries this tag.
 */
export const COMPUTED_MARKER = '(dihitung)';

/** Counts derived values, so the UI can say how many figures need a check. */
export function countComputedValues(text: string): number {
  return text.match(/\((?:dihitung|diturunkan)[^)]*\)/gi)?.length ?? 0;
}
