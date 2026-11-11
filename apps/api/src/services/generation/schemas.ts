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

export const sectionDraftZod = z
  .object({
    body: z.string().min(1, 'The section body is empty'),
    citedChunkIds: z.array(z.string()).max(200).default([]),
    warnings: z.array(z.string().max(1000)).max(30).default([]),
    placeholders: z.array(z.string().max(300)).max(30).default([]),
  })
  .strict();

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
