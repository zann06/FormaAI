/**
 * JSON Schema helpers + tolerant JSON parsing of model output.
 *
 * Providers differ in how strictly they honour schemas and some wrap JSON in
 * code fences. We parse defensively and then validate with Zod before anything
 * is persisted.
 */
import { z } from 'zod';

export function jsonSchema(name: string, schema: Record<string, unknown>) {
  return { name, schema };
}

/** Extract the first JSON object/array from a model response. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const direct = tryParse(candidate);
  if (direct.ok) return direct.value;
  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const starts = [objectStart, arrayStart].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error('The model response did not contain JSON');
  const start = Math.min(...starts);
  const endChar = candidate[start] === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(endChar);
  if (end <= start) throw new Error('The model response contained malformed JSON');
  const sliced = tryParse(candidate.slice(start, end + 1));
  if (sliced.ok) return sliced.value;
  throw new Error(`The model response contained malformed JSON: ${sliced.error}`);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Turns a model reply that is *actually* the section JSON into the body text.
 *
 * The "plain prose" retry asks the model to stop emitting JSON. Models sometimes
 * ignore that and reply with the full envelope anyway
 * (`{"section": "...", "body": "...", "warnings": [...]}`). That reply is long
 * enough to pass a length check, so it was stored verbatim as the section body
 * and exported into the finished document — three sections of a real report came
 * out as raw JSON with `\n` escapes showing in the PDF.
 *
 * This extracts the human-readable part and refuses to return anything that still
 * looks like a serialised object. It is deliberately conservative: if no `body`
 * field can be recovered, the whole text is returned unchanged so the caller can
 * apply its own length/quality checks.
 */
export function unwrapJsonBody(text: string): { body: string; unwrapped: boolean } {
  const trimmed = text.trim();
  // Only pay the parsing cost when the text plausibly is a JSON object.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return { body: trimmed, unwrapped: false };
  }

  let parsed: unknown;
  try {
    parsed = parseModelJson(trimmed);
  } catch {
    // Starts with "{" but is not parseable JSON: it may simply be prose that
    // begins with a brace. Leave it to the caller.
    return { body: trimmed, unwrapped: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { body: trimmed, unwrapped: false };
  }

  const record = parsed as Record<string, unknown>;
  // Prefer the documented field, then the common near-misses models use.
  for (const key of ['body', 'content', 'text', 'prose', 'sectionBody'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { body: normaliseEscapes(value.trim()), unwrapped: true };
    }
  }
  // A JSON object with no usable body: returning it would put braces in the
  // report, so report failure via an empty string.
  return { body: '', unwrapped: true };
}

/**
 * Converts escaped `\n` inside a JSON string into real newlines.
 *
 * A model that double-encodes its reply leaves the two characters `\` and `n` in
 * the text, which PDF export renders literally mid-sentence.
 */
export function normaliseEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
}

/**
 * True when the text is a serialised object rather than prose.
 *
 * Used as a final guard before saving: a body that still parses as a JSON object
 * with a `body`-like key must never reach the document.
 */
export function looksLikeSerialisedSection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  if (!/"?(body|section|content|warnings)"?\s*:/.test(trimmed)) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export const sectionTableZod = z
  .object({
    columns: z.array(z.string().max(200)).min(1).max(20),
    rows: z.array(z.array(z.string().max(500)).max(20)).max(200),
    caption: z.string().max(300).optional(),
  })
  .strict();

/**
 * A section draft as the model returns it.
 *
 * Deliberately NOT `.strict()`. A model that adds one harmless extra key
 * (`"title"`, `"heading"`, `"notes"`) used to fail the whole parse, and the section
 * was abandoned with "The model did not return a valid section payload" — which is
 * how a 44-section run ended with a silently empty 5.2 and no explanation stored.
 * Unknown keys are stripped; only the fields we actually use are validated.
 */
export const sectionDraftZod = z.object({
  body: z.string().trim().min(1, 'The section body is empty'),
  // Optional: only present when the section is about a table.
  table: sectionTableZod.nullish(),
  citedChunkIds: z.array(z.string()).max(200).default([]),
  warnings: z.array(z.string().max(1000)).max(30).default([]),
  placeholders: z.array(z.string().max(300)).max(30).default([]),
});

export const mappingZod = z.object({
  sections: z
    .array(
      z.object({
        sectionId: z.string(),
        purpose: z.string().max(2000).default(''),
        requirements: z.array(z.string().max(500)).max(20).default([]),
        evidenceChunkIds: z.array(z.string()).max(60).default([]),
        gaps: z.array(z.string().max(500)).max(20).default([]),
        contentPlan: z.array(z.string().max(500)).max(20).default([]),
      }),
    )
    .max(200),
});

/**
 * Detects output that suggests the model followed instructions embedded in a
 * source document instead of the system prompt.
 */
const INJECTION_MARKERS = [
  /ignore (?:all )?previous instructions/i,
  /ignore the (?:system|developer) prompt/i,
  /you are now/i,
  /reveal (?:the )?(?:api|secret) key/i,
  /system prompt:/i,
];

export function detectInstructionLeakage(text: string): string[] {
  return INJECTION_MARKERS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/** Enforces that generated body text does not introduce its own headings. */
export function containsMarkdownHeadings(text: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/m.test(text);
}

/**
 * Extracts numeric/date tokens to check they appear in the evidence used.
 * Used by factual-support validation (FR-08 / MASTER_PROMPT §7).
 */
export function extractClaimTokens(text: string): { numbers: string[]; dates: string[] } {
  const numbers = (text.match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\b|\b\d+(?:[.,]\d+)?%?/g) ?? [])
    .map((n) => n.replace(/[.,]$/, ''))
    .filter((n) => n.length > 0);
  const dates = text.match(
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|Mei|Juni|Juli|Agustus|Oktober|Desember)\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
  ) ?? [];
  return { numbers, dates };
}

export function numbersSupportedBy(evidenceText: string, tokens: string[]): { supported: string[]; unsupported: string[] } {
  const normalizedEvidence = evidenceText.replace(/[.,](?=\d{3})/g, '').toLowerCase();
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const token of tokens) {
    const normalized = token.replace(/[.,](?=\d{3})/g, '').toLowerCase();
    if (!/\d/.test(normalized)) {
      supported.push(token);
      continue;
    }
    // allow 5 and 5.0 / 5,0 equivalence
    const variants = [normalized, normalized.replace('.', ','), normalized.replace(',', '.')];
    if (variants.some((variant) => normalizedEvidence.includes(variant))) supported.push(token);
    else unsupported.push(token);
  }
  return { supported, unsupported };
}
