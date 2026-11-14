/**
 * Resolves `[PERLU DICEK: …]` / `[MISSING: …]` gap markers from the evidence.
 *
 * Why this exists
 * ---------------
 * Generation writes a visible marker whenever a value cannot be derived from the
 * text it was given. Those markers are deliberately honest, but a report that
 * ships with 50 of them is not finished — and many of them are values the source
 * screenshots plainly show. The OCR text simply lost them: a CLI capture read at
 * 300 dpi turns `192.168.10.97` into `192.168.10.9?`, a table got flattened, a
 * column was cut off.
 *
 * So this pass re-reads the same evidence WITH the images attached and asks the
 * model to fill only the gaps it can actually support. The safety rule is the
 * whole point of the module:
 *
 *  - a value read from TEXT is accepted only if that value literally appears in
 *    the evidence text;
 *  - a value read from an IMAGE is accepted only if the model names an image that
 *    was actually attached, and it is recorded as image-derived so the user knows;
 *  - anything else keeps its marker.
 *
 * A gap that survives is not a failure. It is the truthful answer.
 */

export interface GapMarker {
  /** Index of this marker in `findGapMarkers` order — used as the model's id. */
  id: number;
  /** The full marker text, e.g. `[PERLU DICEK: versi Packet Tracer]`. */
  marker: string;
  /** The question inside the marker, e.g. `versi Packet Tracer`. */
  question: string;
}

/** The structural table stored alongside a section, when it has one. */
export interface GapTable {
  columns: string[];
  rows: string[][];
  caption?: string;
}

/**
 * A marker together with where it lives.
 *
 * The same question can appear in several table rows with a different answer per
 * row — four interfaces each need their own mask — so resolution works per
 * occurrence, not per marker text. `where` and `context` are what let the model
 * tell those rows apart.
 */
export interface GapOccurrence extends GapMarker {
  /** e.g. `body text` or `table row 3 (“R-KABEL”), column “Subnet Mask”`. */
  where: string;
  /** A readable slice of the row or paragraph the marker sits in. */
  context: string;
}

const GAP_PATTERN = /\[(?:PERLU DICEK|MISSING)\s*:\s*([^\]]*)\]/gi;

/**
 * Lists the gap markers in a section, in document order.
 *
 * Both languages are matched because the body text follows the report language
 * while table cells may keep whichever marker generation produced.
 */
export function findGapMarkers(content: string): GapMarker[] {
  const markers: GapMarker[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(GAP_PATTERN.source, GAP_PATTERN.flags);
  while ((match = pattern.exec(content)) !== null) {
    markers.push({
      id: markers.length,
      marker: match[0],
      question: (match[1] ?? '').trim(),
    });
  }
  return markers;
}

/**
 * Lists every gap marker in a section's body AND its table cells, in the exact
 * order the resolver walks them.
 *
 * This used to scan only `content`, which missed the majority of gaps: an
 * addressing table keeps its unverified values in cells, not prose. The ids here
 * are the ids the model answers, and `applyDocumentGapResolutions` walks the same
 * sequence so a value lands in the row it was asked about.
 */
export function collectDocumentGaps(content: string, table: GapTable | null): GapOccurrence[] {
  const occurrences: GapOccurrence[] = [];

  const pushFrom = (text: string, where: (index: number) => string, prefix = '') => {
    const pattern = new RegExp(GAP_PATTERN.source, GAP_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const slice = text
        .slice(Math.max(0, start - 90), Math.min(text.length, end + 90))
        .replace(/\s+/g, ' ')
        .trim();
      occurrences.push({
        id: occurrences.length,
        marker: match[0],
        question: (match[1] ?? '').trim(),
        where: where(start),
        context: [prefix, slice].filter(Boolean).join(' — '),
      });
    }
  };

  pushFrom(content, () => 'body text');

  if (table) {
    const headers = table.columns ?? [];
    table.rows.forEach((row, rowIndex) => {
      const label = (row[0] ?? '').trim();
      row.forEach((cell, columnIndex) => {
        if (!cell) return;
        const column = headers[columnIndex]?.trim() || `column ${columnIndex + 1}`;
        pushFrom(
          cell,
          () => `table row ${rowIndex + 1}${label ? ` (“${label}”)` : ''}, column “${column}”`,
          `row: ${row.join(' | ').slice(0, 220)}`,
        );
      });
    });
    if (table.caption) pushFrom(table.caption, () => 'table caption');
  }

  return occurrences;
}

/** One proposed replacement returned by the model. */
export interface GapProposal {
  id: number;
  value: string;
  basis: string;
  source: 'text' | 'image';
  /** File name the value was read from, required when `source === 'image'`. */
  documentName?: string;
  confidence: 'certain' | 'uncertain';
  /** The literal marker this value replaces, e.g. `[PERLU DICEK: prefix]`. */
  markerText: string;
}

export interface GapResolutionDecision {
  proposal: GapProposal;
  accepted: boolean;
  /** Why it was rejected, for the job result and for tests. */
  reason?:
    | 'uncertain'
    | 'no-basis'
    | 'not-in-evidence'
    | 'unknown-document'
    | 'empty-value'
    | 'placeholder-value';
}

/**
 * Values that mean "no value".
 *
 * `0.0.0.0` is literally present in the captures — as the DHCP DNS server and as
 * the Windows "Default gateway" field of an unconfigured adapter — so a
 * containment check happily accepts it as a gateway. Writing it into a gateway
 * cell is worse than keeping the marker: it reads like a verified fact and says
 * the opposite of what the capture shows.
 */
const PLACEHOLDER_VALUES = new Set(['0.0.0.0', '::', 'n/a', 'na', '-', '--', 'tbd', 'null', 'none', 'unknown']);

/** True when a proposed value carries no information. */
function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

/**
 * Characters OCR commonly swaps inside a value, mapped to the digit they stand in
 * for.
 *
 * A CLI capture read at 300 dpi routinely yields `TIL-128` where the pixels say
 * `TTL-128`, `1O` for `10`, `S` for `5`. Comparing shapes is what lets a genuine
 * reading corroborate its own damaged OCR.
 *
 * Only glyphs that genuinely look alike are collapsed: `I`, `l`, `|`, `!` are all
 * a vertical stroke, so they share `1`; `O`/`Q`/`D`/`U` are a loop, so they share
 * `0`. `T` is deliberately NOT collapsed — it is the same letter in both spellings
 * (`TTL` and `TIL` both start with `T`), and mapping it would turn a correct
 * reading into a mismatch.
 *
 * Digits themselves are never remapped: a changed number is a different value.
 */
const OCR_LOOKALIKES: Record<string, string> = {
  o: '0',
  q: '0',
  d: '0',
  u: '0',
  i: '1',
  l: '1',
  j: '1',
  '|': '1',
  '!': '1',
  z: '2',
  a: '4',
  s: '5',
  g: '6',
  b: '8',
  e: '6',
};

/**
 * Normalises a value for containment checks.
 *
 * Spacing is ignored, so a value read from a screenshot can still be found in its
 * own damaged OCR (`TTL-128` vs `TTl-128`). OCR lookalike letters are collapsed
 * only for the corroboration check, never for the digit-boundary check: collapsing
 * `l` to `1` would turn a letter into a digit and make `192.168.10.1` look like a
 * prefix of a longer number.
 *
 * The characters that carry meaning — the digits, their count and their order —
 * are compared exactly, because that is the part a user would be misled by.
 */
function normaliseForMatch(value: string): string {
  return value.toLowerCase().replace(/[\s\u00a0]+/g, '');
}

/** Collapses glyphs that OCR confuses, for the shape-insensitive comparison. */
function collapseLookalikes(value: string): string {
  return value.replace(/[oqduilj|!zasgbe]/g, (character) => OCR_LOOKALIKES[character] ?? character);
}

/**
 * Decides whether a proposal may replace its marker.
 *
 * `evidenceText` is everything the model was given as text, and `attachedImages`
 * is the set of document names whose pixels travelled with the request. A model
 * that cites an image it was never shown is guessing, so that is rejected too.
 */
export function decideProposal(
  proposal: GapProposal,
  evidenceText: string,
  attachedImages: readonly string[],
): GapResolutionDecision {
  const value = proposal.value?.trim() ?? '';
  if (!value) return { proposal, accepted: false, reason: 'empty-value' };
  if (isPlaceholderValue(value)) return { proposal, accepted: false, reason: 'placeholder-value' };
  if (proposal.confidence !== 'certain') return { proposal, accepted: false, reason: 'uncertain' };
  if (!proposal.basis || proposal.basis.trim().length < 3) {
    return { proposal, accepted: false, reason: 'no-basis' };
  }

  if (proposal.source === 'image') {
    const named = (proposal.documentName ?? '').trim();
    if (!named) return { proposal, accepted: false, reason: 'unknown-document' };
    // Tolerate extension/case differences between the stored name and the answer.
    const known = attachedImages.some((name) => {
      const a = name.toLowerCase();
      const b = named.toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    });
    if (!known) return { proposal, accepted: false, reason: 'unknown-document' };
    // An image claim is accepted only when the evidence text corroborates it.
    // The prompt already forbids inventing values, yet a vision model quietly
    // "tidied" a readable `TTL=128` into `TTL=126` and filled in a `bytes=32`
    // field that was never in the capture. Neither is a reading of the pixels, and
    // nothing downstream would ever catch it: OCR garble (`time=3eme`) is normal
    // enough that an unverifiable value must stay a marker.
    const haystack = normaliseForMatch(evidenceText);
    if (haystack.length > 0 && !containsValue(haystack, normaliseForMatch(value))) {
      return { proposal, accepted: false, reason: 'not-in-evidence' };
    }    return { proposal, accepted: true };
  }

  // Text-sourced values must literally be present. This is the check that makes
  // "reasoned" answers impossible: a derivation is fine in generation, but a gap
  // resolution is a value the evidence is supposed to already contain.
  const haystack = normaliseForMatch(evidenceText);
  if (!containsValue(haystack, normaliseForMatch(value))) {
    return { proposal, accepted: false, reason: 'not-in-evidence' };
  }
  return { proposal, accepted: true };
}

/**
 * True when `haystack` contains `needle`, treating OCR lookalikes as equal while
 * refusing matches that are only a slice of a longer number.
 *
 * Two things have to hold at once. `192.168.10.1` must not match inside
 * `192.168.10.10` — that would put one host's address in another row — while
 * `TTL-128` must match `TTl-128`. So the boundary test runs on the text as printed
 * (separators intact) and only the comparison itself folds lookalike glyphs.
 */
function containsValue(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const folded = collapseLookalikes(needle);
  const isDigit = (character: string | undefined) => character !== undefined && /[0-9]/.test(character);
  const digitNeedleStart = isDigit(needle[0]);
  const digitNeedleEnd = isDigit(needle[needle.length - 1]);

  for (let from = 0; from + needle.length <= haystack.length; from += 1) {
    if (collapseLookalikes(haystack.slice(from, from + needle.length)) !== folded) continue;
    const before = haystack[from - 1];
    const after = haystack[from + needle.length];
    // A digit glued to the match on either side means it is part of a longer number.
    if (digitNeedleStart && isDigit(before)) continue;
    if (digitNeedleEnd && isDigit(after)) continue;
    return true;
  }
  return false;
}

/**
 * Replaces accepted markers with their values.
 *
 * Replaced by exact marker text rather than by index: the same marker can appear
 * in prose and in a table cell, and both should receive the same answer. Markers
 * with no accepted proposal stay untouched, which is what keeps the report honest.
 */
export function applyGapResolutions(
  content: string,
  decisions: readonly GapResolutionDecision[],
): { content: string; replaced: number } {
  let output = content;
  let replaced = 0;
  for (const decision of decisions) {
    if (!decision.accepted) continue;
    const value = decision.proposal.value.trim();
    if (!value) continue;
    // Replaced by exact marker text rather than by index: the same marker can
    // appear in prose and in a table cell, and both should receive the answer.
    const before = output;
    output = output.split(decision.proposal.markerText).join(value);
    if (output !== before) replaced += 1;
  }
  return { content: output, replaced };
}

/**
 * Applies accepted values to the body and the table, per occurrence.
 *
 * Applying by marker text alone was wrong for tables: “status antarmuka” appears
 * in several rows, and replacing every occurrence with one accepted answer would
 * put the same interface status on rows that were never verified. The walk order
 * is identical to `collectDocumentGaps` — body, then rows in order, then caption.
 */
export function applyDocumentGapResolutions(
  document: { content: string; table: GapTable | null },
  decisions: readonly GapResolutionDecision[],
): { content: string; table: GapTable | null; replaced: number } {
  const accepted = new Map<number, string>();
  for (const decision of decisions) {
    if (!decision.accepted) continue;
    const value = decision.proposal.value.trim();
    if (value) accepted.set(decision.proposal.id, value);
  }

  let cursor = 0;
  let replaced = 0;
  const replaceIn = (text: string): string => {
    const pattern = new RegExp(GAP_PATTERN.source, GAP_PATTERN.flags);
    return text.replace(pattern, (match) => {
      const value = accepted.get(cursor++);
      if (value === undefined) return match;
      replaced += 1;
      return value;
    });
  };

  const content = replaceIn(document.content);
  let table = document.table;
  if (table) {
    const rows = table.rows.map((row) => row.map((cell) => replaceIn(cell)));
    const caption = table.caption === undefined ? undefined : replaceIn(table.caption);
    table = { ...table, rows, ...(caption !== undefined ? { caption } : {}) };
  }
  return { content, table, replaced };
}

/** A proposal as it arrives from the model, before the marker text is attached. */
export interface RawGapProposal {
  id?: number;
  value?: string;
  basis?: string;
  source?: string;
  documentName?: string;
  confidence?: string;
}

/**
 * Merges raw model output with the markers it refers to.
 *
 * Unknown ids are dropped rather than clamped: a model that invents an id is not
 * answering the question that was asked, and silently mapping it to a real marker
 * would put an unrelated value in the report.
 */
export function proposalsFromModel(
  raw: readonly RawGapProposal[],
  markers: readonly GapMarker[],
): GapProposal[] {
  const out: GapProposal[] = [];
  for (const entry of raw) {
    const marker = markers.find((candidate) => candidate.id === entry.id);
    if (!marker) continue;
    if (typeof entry.value !== 'string') continue;
    out.push({
      id: marker.id,
      markerText: marker.marker,
      value: entry.value,
      basis: entry.basis ?? '',
      source: entry.source === 'image' ? 'image' : 'text',
      documentName: entry.documentName,
      confidence: entry.confidence === 'certain' ? 'certain' : 'uncertain',
    });
  }
  return out;
}

/**
 * The instruction sent alongside the evidence and the images.
 *
 * Written to make refusal the default: the model is told that leaving a marker is
 * a correct answer, because a model asked to "resolve everything" will happily
 * invent a version number to be helpful.
 */
export function buildGapResolutionPrompt(input: {
  heading: string;
  language: string;
  markers: readonly GapMarker[];
  evidenceText: string;
  attachedImages: readonly string[];
}): string {
  const list = input.markers
    .map((marker) => {
      const occurrence = marker as Partial<GapOccurrence>;
      const where = occurrence.where ? `\n  location: ${occurrence.where}` : '';
      const context = occurrence.context ? `\n  context: ${occurrence.context}` : '';
      return `- id ${marker.id}: ${marker.marker}${where}${context}`;
    })
    .join('\n');
  const images = input.attachedImages.length
    ? input.attachedImages.map((name, index) => `- IMAGE ${index + 1}: ${name}`).join('\n')
    : '- (no images attached)';

  return `You are completing a report section by filling the few values that were marked as unverified.

SECTION: ${input.heading}
REPORT LANGUAGE: ${input.language}

VALUES TO RESOLVE (ids must be copied exactly):
${list}

SOURCE TEXT (the same evidence the section was written from):
"""
${input.evidenceText.slice(0, 24_000)}
"""

SOURCE IMAGES ATTACHED (they follow this message in exactly this order):
${images}

For each id, do ONE of two things:
1. Give the exact value the evidence supports, and say where you saw it.
2. Omit the id entirely. Leaving it unresolved is the correct answer when the
   evidence truly does not contain it.

Rules you must never break:
- The value must appear in the source text, or be visible in one of the attached
  images. Never infer, average, guess, or construct a plausible value.
- Copy values character by character: version numbers, IP addresses, hostnames,
  mask lengths, dates. Do not tidy them up or "correct" what looks like a typo.
- If a value is only partially visible (a cut-off digit, a blurred row), omit it.
- Answer the row you were asked about: the "location" and "context" lines say
  which device and column an id belongs to. Do not reuse a value from another row
  because it looks similar.
- For an image-sourced value, set "source" to "image" and "documentName" to the
  exact file name of the numbered IMAGE you read it from.
- For a text-sourced value, set "source" to "text".
- Set "confidence" to "certain" only when you can point at the exact place.
  Otherwise use "uncertain" — an uncertain answer will be discarded.

Return JSON only:
{"resolved":[{"id":0,"value":"...","basis":"quoted text or what is visible in the image","source":"text|image","documentName":"only for image","confidence":"certain|uncertain"}]}`;
}

/**
 * Parses the model's JSON answer into raw proposals.
 *
 * Models routinely wrap JSON in a fenced block or add a sentence before it, and a
 * fenced reply used to be treated as "no answer" — which silently threw away every
 * resolution. Anything that cannot be read at all yields an empty list, so the
 * caller keeps every marker rather than failing the section.
 */
export function parseGapProposals(text: string): RawGapProposal[] {
  if (!text) return [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    const list =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { resolved?: unknown }).resolved)
          ? (parsed as { resolved: unknown[] }).resolved
          : [];
    return list.filter((entry): entry is RawGapProposal => !!entry && typeof entry === 'object');
  } catch {
    return [];
  }
}

/** Result of resolving one section, shaped for the job result and the chat. */
export interface GapResolutionSummary {
  sectionId: string;
  heading: string;
  found: number;
  resolved: number;
  /** Markers that remain, with the reason each one was kept and where it lives. */
  remaining: Array<{ marker: string; reason: string; where?: string }>;
  content: string;
  /** Values that came from a screenshot rather than text, listed for the user. */
  imageDerived: Array<{ marker: string; value: string; documentName: string }>;
}
