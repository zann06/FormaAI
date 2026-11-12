/**
 * Turns a chat message into something the workspace can actually do.
 *
 * The chat is not a general assistant: it owns one report. Every message is
 * matched against the actions this report supports, and when nothing matches it
 * is treated as a standing instruction for the next draft rather than a chat
 * reply. Keeping the matching here — pure and testable — means the UI only has
 * to render the decision, and the rules can be checked without a browser.
 */

export type ChatActionKind =
  | 'generate-all'
  | 'generate-section'
  | 'export-docx'
  | 'export-pdf'
  | 'open-sources'
  | 'open-outline'
  | 'status'
  | 'instruction';

export interface ChatAction {
  kind: ChatActionKind;
  /** Section heading or filename the message referred to, when there is one. */
  target?: string;
  /** The original text, kept so an `instruction` action can be stored verbatim. */
  text: string;
  /** Short human label for the activity line, e.g. "Generating every section". */
  label: string;
}

export interface PlannerContext {
  /** Known section headings, used to resolve "regenerate 2.3". */
  headings: string[];
}

/**
 * Words that mean "write / rewrite the whole report".
 *
 * Indonesian inflections matter here: the reported message said "buatkan laporan"
 * and matched nothing, because only the bare "buat" was listed. A user asking for a
 * report must never fall through to "saving this as an instruction".
 */
const GENERATE_ALL =
  /\b(generate|draft|write|rewrite|redo|buat|buatkan|bikinin|bikin|tulis|tuliskan|perbaiki|susun|susunkan|generate ulang|regenerate|create the report|make the report)\b/i;
/** Words that name the artefact itself, so "buatkan laporan" is a request for a report. */
const REPORT_NOUN = /\b(laporan|report|docx|pdf|document|dokumen)\b/i;
/** Words that mean "produce a file". */
const EXPORT = /\b(export|download|unduh|ekspor|docx|pdf|word|file)\b/i;
/** Words that ask about state rather than changing it. */
const STATUS =
  /\b(status|progress|how (?:is|far)|berapa|sudah|ready|selesai|mana yang|kosong|missing|which (?:part|section|one)|empty|incomplete|unfinished|belum)\b/i;
/** Words that specifically mean "open the structure view". */
const OUTLINE = /\b(outline|struktur|daftar isi|section list|bagian mana)\b/i;

/**
 * Detects the intent behind a message.
 *
 * Order matters: an explicit export request wins over the generic "generate"
 * verb, because "export the docx" contains no generate verb but "generate and
 * export" contains both and the user is waiting on a file.
 */
export function planChatAction(message: string, context: PlannerContext): ChatAction {
  const text = message.trim();
  const lower = text.toLowerCase();

  // "regenerate 2.3" / "rewrite the section Tabel Alokasi" — a named section.
  const namedHeading = context.headings.find((heading) => {
    const needle = heading.trim().toLowerCase();
    // Long headings are matched by prefix so "2.3 Tabel Alokasi Pengalamatan IP
    // Lengkap" is found by "2.3" alone.
    const numbered = /^(\d+(?:\.\d+)+)/.exec(needle);
    if (numbered && lower.includes(numbered[1]!)) return true;
    return needle.length >= 6 && lower.includes(needle);
  });

  const wantsPdf = /\bpdf\b/i.test(text);
  if (EXPORT.test(text) && !STATUS.test(text)) {
    return {
      kind: wantsPdf ? 'export-pdf' : 'export-docx',
      text,
      label: wantsPdf ? 'Exporting as PDF' : 'Exporting as DOCX',
    };
  }

  if (namedHeading && GENERATE_ALL.test(text)) {
    return {
      kind: 'generate-section',
      target: namedHeading,
      text,
      label: `Regenerating “${namedHeading}”`,
    };
  }

  // Only a genuine *question about where to put a file* opens Sources. A request
  // that merely mentions the word "source" or "zip" ("buatkan laporan dari sumber
  // zip yang saya berikan") is asking for a report, and opening a drawer answered
  // nothing.
  const asksWhere = /(\?|where do i|dimana|di mana|how do i|bagaimana cara)/i.test(text);
  if (
    asksWhere &&
    /\b(zip|sumber|source|upload|unggah|lampiran)\b/i.test(text) &&
    !(GENERATE_ALL.test(text) && REPORT_NOUN.test(text))
  ) {
    return { kind: 'open-sources', text, label: 'Opening sources' };
  }

  // A question about *gaps* ("bagian mana yang masih kosong?") mentions structure
  // but is asking for a report on state, so status is checked first: opening the
  // outline would answer nothing.
  if (STATUS.test(text)) {
    return { kind: 'status', text, label: 'Checking the report status' };
  }

  if (OUTLINE.test(lower) && !(GENERATE_ALL.test(text) && REPORT_NOUN.test(text))) {
    return { kind: 'open-outline', text, label: 'Opening the outline' };
  }

  if (GENERATE_ALL.test(text) && !namedHeading) {
    return { kind: 'generate-all', text, label: 'Drafting every section' };
  }

  // "laporan" / "report" with no other signal is still a request to write it.
  if (REPORT_NOUN.test(text) && !asksQuestion(text)) {
    return { kind: 'generate-all', text, label: 'Drafting every section' };
  }

  return { kind: 'instruction', text, label: 'Saving this instruction' };
}

/**
 * True when a message asks for information rather than work.
 *
 * Used so "what does the report say about VLANs?" does not start a 44-section
 * regeneration. A bare report noun without a question or a generate verb is
 * treated as a request to write it.
 */
function asksQuestion(text: string): boolean {
  return /(\?|^(what|why|how|when|where|which|who|apa|kenapa|mengapa|bagaimana|kapan|dimana|di mana|berapa|siapa|mana)\b)/i.test(
    text.trim(),
  );
}

/**
 * Splits a full pipeline message into the lines the chat shows.
 *
 * The pipeline already reports each step honestly (including sections it did not
 * attempt), so the chat repeats those lines rather than inventing a summary — the
 * whole point of showing feedback inline is that it is the truth about the run.
 */
export function summariseSteps(summary: string | null | undefined, steps: Array<{ name: string; status: string; message?: string }>): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (!step.message) continue;
    const mark = step.status === 'failed' ? '✗' : step.status === 'skipped' ? '·' : '✓';
    lines.push(`${mark} ${step.message}`);
  }
  if (summary) lines.push(summary);
  return lines;
}
