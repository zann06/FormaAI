/**
 * Marks unreliable text before it reaches the model or the document.
 *
 * Screenshots of a terminal are the main evidence for a networking report, and
 * OCR reads them imperfectly: `ipconfig` came back as `apconfig`, and a model
 * then wrapped commands in `???` that appear nowhere in the source. Those
 * errors were exported verbatim, so the report contained commands that do not
 * exist and quotation marks the model invented.
 *
 * This module cannot recover the true bytes, but it can stop the report from
 * presenting a doubtful token as a fact.
 */
import { isOnlyGapMarkers } from '@formaai/shared';

/** Characters that OCR emits when it cannot resolve a glyph. */
const OCR_NOISE = /[\uFFFD\u25A1\u25A0\u2b1c]/g;

export interface SuspiciousToken {
  token: string;
  reason: string;
}

/**
 * Command words that appear in a Cisco PT / shell transcript. Used to spot a
 * near-miss of a real command, which is the signature of a misread glyph.
 */
const KNOWN_COMMANDS = [
  'ipconfig',
  'ping',
  'tracert',
  'traceroute',
  'show',
  'shutdown',
  'no',
  'router',
  'interface',
  'enable',
  'write',
  'copy',
  'hostname',
  'ip',
  'configure',
  'exit',
];

/** Levenshtein distance, bounded to short tokens. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i]![0] = i;
  for (let j = 0; j < cols; j += 1) grid[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i]![j] = Math.min(grid[i - 1]![j]! + 1, grid[i]![j - 1]! + 1, grid[i - 1]![j - 1]! + cost);
    }
  }
  return grid[rows - 1]![cols - 1]!;
}

/**
 * Finds tokens that are almost certainly OCR damage.
 *
 * A single edit from a known command is treated as damage only when the token
 * is not itself a known command, so real commands are never flagged.
 */
export function findSuspiciousTokens(text: string): SuspiciousToken[] {
  const found = new Map<string, string>();

  for (const match of text.matchAll(/\b[A-Za-z]{3,}\b/g)) {
    const token = match[0];
    const lower = token.toLowerCase();
    if (KNOWN_COMMANDS.includes(lower)) continue;
    for (const command of KNOWN_COMMANDS) {
      // One edit away from a real command, and long enough that a coincidence
      // is unlikely (`ip` alone would match far too much).
      if (token.length >= 5 && editDistance(lower, command) === 1) {
        found.set(token, `looks like a misread "${command}"`);
        break;
      }
    }
  }

  return [...found].map(([token, reason]) => ({ token, reason }));
}

/**
 * Text the model must not treat as fact.
 *
 * Returns the cleaned text plus what was removed, so the caller can record it
 * as a review note instead of silently dropping evidence.
 *
 * A token that looks like OCR damage is **marked inline** in the evidence rather
 * than merely reported in a warning. Warning alone did not work: the model is
 * instructed to copy evidence exactly, so it copied `apconfig` verbatim into seven
 * sections of a real report even though a warning had been raised. Marking the
 * token at its source is the only way to stop a doubtful reading from being
 * restated as a fact.
 */
export function cleanEvidenceText(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const before = text;
  let cleaned = text.replace(OCR_NOISE, '');
  if (cleaned !== before) {
    notes.push('Unreadable OCR characters were removed from this passage.');
  }

  const suspicious = findSuspiciousTokens(cleaned);
  for (const { token, reason } of suspicious) {
    // `[OCR?]` marks the doubt without deleting the original, so a human can
    // still compare it against the screenshot.
    const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    cleaned = cleaned.replace(pattern, `${token} [OCR? ${reason}]`);
    notes.push(`"${token}" ${reason} and is marked as uncertain in the evidence.`);
  }

  return { text: cleaned, notes };
}

/**
 * Removes any `[OCR? …]` annotation the model copied into the body, keeping the
 * original token.
 *
 * The annotation belongs in the evidence, not in the finished report: a reader of
 * a submitted assignment should not see our internal note. The section carries the
 * warning instead, so the doubt is not lost.
 */
export function stripOcrAnnotations(body: string): { body: string; changed: boolean } {
  if (!body.includes('[OCR?')) return { body, changed: false };
  return { body: body.replace(/\s*\[OCR\?[^\]]*\]/g, ''), changed: true };
}

/**
 * Marks a damaged token in the finished body so it is never stated as fact.
 *
 * `stripOcrAnnotations` assumed the model would copy our `[OCR? …]` marker into
 * the draft. On a real report it did not: it dropped the marker and wrote the raw
 * token instead ("menjalankan perintah apconfig /all"), so the marker-strip found
 * nothing and the report presented a misread command as a fact. The model's own
 * warnings named the token as a likely misread of `ipconfig` in the same section,
 * so the doubt was known — it just never reached the page.
 *
 * Only tokens that the evidence itself flagged are touched, so a legitimate word
 * that merely resembles a command is never altered.
 */
/**
 * The marker inserted next to a token that the source read imperfectly.
 *
 * A submitted assignment should not silently contain a command that does not
 * exist, and a bare word would hide the doubt. The wording is deliberately
 * readable by a human marker so it is actionable, not cryptic.
 */
export const UNCERTAIN_MARKER = '[sic? verify against source]';

export function markSuspiciousInBody(body: string, evidenceText: string): { body: string; tokens: string[] } {
  const tokens = findSuspiciousTokens(evidenceText).map((found) => found.token);
  let result = body;
  const marked: string[] = [];
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Skip a token that is already marked, so running the scrub twice (a retry, a
    // regenerate over an already-marked body) cannot mark it a second time.
    const unfixed = `\\b${escaped}\\b(?! \\[sic\\? verify)`;
    if (!new RegExp(unfixed).test(result)) continue;
    result = result.replace(new RegExp(unfixed, 'g'), `${token} ${UNCERTAIN_MARKER}`);
    marked.push(token);
  }
  return { body: result, tokens: marked };
}

/**
 * Applies the same damaged-token marking to a generated table.
 *
 * Tables carry most of a networking report's actual findings — an addressing plan,
 * a comparison of measurements — and they go through `table_data`, not the prose
 * body. When the model restated a misread command inside a cell, the body-only
 * scrub missed it: 6 of the 10 `apconfig` occurrences in a real export were table
 * cells, including one that flatly stated "Perintah ... terbaca apconfig, bukan
 * ipconfig" as fact.
 */
export function markSuspiciousInTable<
  T extends { columns: string[]; rows: string[][]; caption?: string | null } | null | undefined,
>(table: T, evidenceText: string): { table: T; tokens: string[] } {
  if (!table) return { table, tokens: [] };
  const tokens = new Set<string>();
  const fix = (value: string): string => {
    const result = markSuspiciousInBody(value, evidenceText);
    for (const token of result.tokens) tokens.add(token);
    return result.body;
  };
  return {
    table: {
      ...table,
      columns: table.columns.map(fix),
      rows: table.rows.map((row) => row.map(fix)),
      ...(table.caption ? { caption: fix(table.caption) } : {}),
    },
    tokens: [...tokens],
  };
}

/**
 * Finds table rows that have no basis in the evidence.
 *
 * A model told to "build the table" will happily invent entities to look thorough:
 * asked to tabulate the subnets it could see, it produced a `/27` block and a `/25`
 * remainder that appear nowhere in the source, and even admitted so in a warning
 * while the table itself looked authoritative. A warning is not enough — the shape
 * of the table is what a reader trusts.
 *
 * A row is judged by its FIRST cell, which is the row's identity (a subnet, a
 * device, an interface). Other cells hold computed values and are expected to be
 * new. A first cell counts as traceable when any meaningful token of it appears in
 * the evidence; values the model tagged `(dihitung)` are stripped first, so a
 * computed cell never makes its own row look invented.
 */
export function untraceableTableRows(
  table: { columns: string[]; rows: string[][] } | null | undefined,
  evidenceText: string,
): string[] {
  if (!table || table.rows.length === 0) return [];
  const haystack = evidenceText.toLowerCase();

  const isTraceable = (cell: string): boolean => {
    const cleaned = cell
      .replace(/\((?:dihitung|diturunkan)[^)]*\)/gi, ' ')
      .replace(/\[(?:MISSING|PERLU DICEK)\s*:[^\]]*\]/gi, ' ')
      .toLowerCase();

    // A subnet block is one indivisible identity: "192.168.10.128/25" is NOT the
    // same entity as "192.168.10.0/26" just because they share an octet prefix.
    // Matching those loosely is how an invented block slipped through, so a
    // CIDR-shaped cell must appear verbatim.
    const cidr = cleaned.match(/\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}/g);
    if (cidr) return cidr.some((block) => haystack.includes(block));

    const tokens = [
      ...(cleaned.match(/\d{1,3}(?:\.\d{1,3}){3}/g) ?? []),
      ...(cleaned.match(/[a-z]{3,}/g) ?? []).filter((word) => !ROW_STOPWORDS.has(word)),
    ];
    if (tokens.length === 0) return true; // nothing distinctive to check
    return tokens.some((token) => haystack.includes(token));
  };

  return table.rows
    .filter((row) => row.length > 0 && !isTraceable(row[0] ?? ''))
    .map((row) => row.slice(0, 3).join(' | '));
}

/**
 * Words too common to prove a row came from the evidence.
 *
 * Row identity is often a plain device or interface name. Counting "the", "and" or
 * "address" as a match would let any row pass, so only distinctive tokens count.
 */
const ROW_STOPWORDS = new Set([
  'dan', 'yang', 'untuk', 'dari', 'pada', 'dengan', 'atau', 'adalah', 'ini', 'itu',
  'the', 'and', 'for', 'from', 'with', 'address', 'alamat', 'router', 'interface',
  'antarmuka', 'subnet', 'blok', 'mask', 'host', 'ip', 'gateway', 'start', 'pool',
  'default', 'server', 'client', 'switch', 'network', 'jaringan',
]);

/**
 * Rows that are nothing but gap markers.
 *
 * The opposite failure to an invented row: the model gave up on a row entirely even
 * though the evidence supported some of its cells. A row reading "R-KABEL |
 * [PERLU DICEK: alamat IP] | [PERLU DICEK: prefix] | …" discards the interface
 * address that the `show ip interface brief` screenshot plainly shows.
 */
export function fullyUnfilledTableRows(table: { columns: string[]; rows: string[][] } | null | undefined): string[] {
  if (!table || table.rows.length === 0) return [];
  return table.rows
    .filter((row) => {
      const cells = row.filter((cell) => cell.trim().length > 0);
      if (cells.length === 0) return false;
      // The first cell names the row; it is an identity, not a data value, so it is
      // expected to be plain text. The DATA cells are what must not all be markers.
      const dataCells = cells.length > 1 ? cells.slice(1) : cells;
      return dataCells.every((cell) => isOnlyGapMarkers(cell));
    })
    .map((row) => row[0] ?? '(unnamed row)');
}

/**
 * Removes quotation marks the model invented around a passage.
 *
 * The source contains no `???`, but the draft did: the model wrapped a command
 * in `???...???` to signal a transcription. Shipping that into a formal report
 * is a defect, so the quotes are stripped and the section is flagged.
 */
export function stripInventedQuotes(body: string, evidenceText: string): { body: string; changed: boolean } {
  if (!body.includes('???')) return { body, changed: false };

  // Only strip when the source has none of its own; otherwise the marks belong
  // to the evidence and must be preserved.
  const evidenceHasMarks = evidenceText.includes('???');
  const cleaned = evidenceHasMarks ? body : body.replace(/\?{2,}/g, '');
  return { body: cleaned, changed: !evidenceHasMarks };
}
