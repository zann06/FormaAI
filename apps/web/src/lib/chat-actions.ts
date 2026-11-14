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
  | 'resolve-gaps'
  | 'open-sources'
  | 'open-outline'
  | 'status'
  | 'identity'
  | 'instruction';

export interface ChatAction {
  kind: ChatActionKind;
  /** Section heading or filename the message referred to, when there is one. */
  target?: string;
  /** The original text, kept so an `instruction` action can be stored verbatim. */
  text: string;
  /** Short human label for the activity line, e.g. "Generating every section". */
  label: string;
  /**
   * Identity fields read out of the message (`Nama`, `NIM`, `Kelas`, `Tanggal`).
   *
   * The cover page asks for these with literal `[ Tuliskan Nama Lengkap Anda ]`
   * prompts, and export fills them from `projects.instructions`. Users type them
   * into the chat instead, so without this the cover stayed blank on every project
   * even though the user had plainly said who they are.
   */
  identity?: Partial<Record<IdentityField, string>>;
}

/**
 * The cover-page fields a user can supply in passing.
 *
 * Keys match what `identityReplacements()` reads from `projects.instructions`, so
 * whatever is captured here lands in the exported cover without another mapping.
 */
export type IdentityField = 'nama' | 'nim' | 'kelas' | 'tanggal';

/**
 * Reads identity fields out of a free-form message.
 *
 * Handles the shapes people actually type: "Nama: Farid", "nama saya Farid",
 * "NIM 124140210", "kelas RA", "NIM-nya 124140210". Values stop at the next field
 * label, a comma, or the end of the line, so one sentence can carry all of them.
 */
export function extractIdentity(message: string): Partial<Record<IdentityField, string>> {
  const text = message.trim();
  if (!text) return {};
  const found: Partial<Record<IdentityField, string>> = {};

  // A value runs until another label, a comma/semicolon/period, a newline, or end.
  const STOP = String.raw`(?=[,;.\n]|$)`;
  const patterns: Array<{ field: IdentityField; re: RegExp }> = [
    {
      field: 'nama',
      re: new RegExp(
        String.raw`\b(?:nama(?:\s+(?:saya|aku|ku|mahasiswa|lengkap|penyusun))?|name)\s*[:\-]?\s*([A-Za-z][A-Za-z.'’\- ]{1,60}?)${STOP}`,
        'i',
      ),
    },
    { field: 'nim', re: new RegExp(String.raw`\b(?:nim|n\.i\.m\.?|npm|student\s*id)\s*(?:saya|aku|ku|nya)?\s*[:\-]?\s*([0-9][0-9.\- ]{4,20}?)${STOP}`, 'i') },
    {
      field: 'kelas',
      re: new RegExp(String.raw`\b(?:kelas|class|rombel)\s*(?:saya|aku|ku|nya)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9.\- ]{0,15}?)${STOP}`, 'i'),
    },
    {
      field: 'tanggal',
      re: new RegExp(
        String.raw`\b(?:tanggal|tgl|date|dikumpulkan(?:\s+pada)?)\s*(?:saya|aku|ku|nya)?\s*(?:pengumpulan|pengiriman|penyerahan|submit)?\s*[:\-]?\s*([0-9][A-Za-z0-9 ,./\-]{3,30}?)${STOP}`,
        'i',
      ),
    },
  ];

  for (const { field, re } of patterns) {
    const match = re.exec(text);
    const value = match?.[1]?.trim().replace(/\s+/g, ' ');
    if (!value) continue;
    // A value that is really the next label ("nama: nim 123") is not a value.
    if (field === 'nama' && /^(nim|npm|kelas|class|tanggal|tgl)\b/i.test(value)) continue;
    found[field] = value;
  }

  // "nama Farid Rizky Fauzan NIM 124140210 kelas RA" — the name pattern above stops
  // at the first label-looking word, so trim a trailing field label that leaked in.
  if (found.nama) {
    found.nama = found.nama.replace(/\s*\b(?:nim|npm|kelas|class|tanggal|tgl)\b.*$/i, '').trim();
    if (!found.nama) delete found.nama;
  }

  // A class is a short code ("RA", "3KA01"); reject a sentence that swallowed words.
  if (found.kelas && found.kelas.split(/\s+/).length > 3) delete found.kelas;

  return found;
}

/** True when the extractor recognised at least one cover field. */
export function hasIdentityFields(fields: Partial<Record<IdentityField, string>>): boolean {
  return Object.values(fields).some((value) => Boolean(value && value.trim()));
}

/** Canonical labels, so stored instructions and export read the same keys. */
const IDENTITY_LABEL: Record<IdentityField, string> = {
  nama: 'Nama',
  nim: 'NIM',
  kelas: 'Kelas',
  tanggal: 'Tanggal',
};

/** Any label a user or template may use for a cover field. */
const IDENTITY_ALIASES: Record<string, IdentityField> = {
  nama: 'nama',
  name: 'nama',
  nim: 'nim',
  npm: 'nim',
  'student id': 'nim',
  kelas: 'kelas',
  class: 'kelas',
  rombel: 'kelas',
  tanggal: 'tanggal',
  tgl: 'tanggal',
  date: 'tanggal',
};

/** Renders cover fields as the `Nama: …` lines `identityReplacements()` reads. */
export function formatIdentity(fields: Partial<Record<IdentityField, string>>): string {
  return (Object.keys(IDENTITY_LABEL) as IdentityField[])
    .filter((field) => fields[field]?.trim())
    .map((field) => `${IDENTITY_LABEL[field]}: ${fields[field]!.trim()}`)
    .join('\n');
}

/**
 * Adds cover fields to the project's standing instructions without losing the
 * guidance already stored there.
 *
 * Saving identity used to overwrite `projects.instructions` with the whole chat
 * message, which either wiped a standing instruction or stored "Nama: Farid, export
 * DOCX" as the name. This keeps prose guidance and updates only the fields given.
 */
export function mergeIdentity(
  instructions: string | null,
  fields: Partial<Record<IdentityField, string>>,
): string {
  const merged: Partial<Record<IdentityField, string>> = {};
  const guidance: string[] = [];
  for (const line of (instructions ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/.exec(line);
    const field = match ? IDENTITY_ALIASES[match[1]!.trim().toLowerCase()] : undefined;
    if (match && field) {
      merged[field] = match[2]!.trim();
    } else if (line.trim()) {
      guidance.push(line.trim());
    }
  }
  for (const [field, value] of Object.entries(fields) as Array<[IdentityField, string | undefined]>) {
    if (value?.trim()) merged[field] = value.trim();
  }
  const identity = formatIdentity(merged);
  return [...guidance, ...(identity ? [identity] : [])].join('\n');
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
 * Words that ask for the unverified values to be checked against the sources.
 *
 * Distinct from "generate": the user is not asking for a new draft, they are
 * asking for the `[PERLU DICEK]` holes to be filled from the evidence they already
 * supplied. Running a regeneration instead would rewrite supported prose and could
 * easily introduce new gaps.
 */
const RESOLVE_GAPS =
  /\b(perlu dicek|verifikasi|verif|cek ulang|periksa|validasi|validate|verify|cross-?check|cek lagi|isi yang kosong|lengkapi|complete the gaps|fill the gaps|unverified|tanda cek)\b/i;

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
  const namedHeading = findNamedHeading(text, context.headings);

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

  // Checking the unverified values comes before the generic "write the report"
  // fallback: "lengkapi laporan ini" names the artefact but is asking to close the
  // gaps, not to redraft prose that is already supported.
  if (RESOLVE_GAPS.test(text) && !(GENERATE_ALL.test(text) && namedHeading)) {
    return { kind: 'resolve-gaps', text, label: 'Checking the unverified values against your sources' };
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

  // A message that states who the user is fills the cover. Checked before the
  // generic instruction fallback because "nama saya Farid" was previously stored as
  // prose guidance, leaving `[ Tuliskan Nama Lengkap Anda ]` on the exported cover.
  const identity = extractIdentity(text);
  if (hasIdentityFields(identity)) {
    const named = (['nama', 'nim', 'kelas', 'tanggal'] as const).filter((field) => identity[field]);
    return {
      kind: 'identity',
      text,
      identity,
      label: `Saving your cover details (${named.join(', ')})`,
    };
  }

  return { kind: 'instruction', text, label: 'Saving this instruction' };
}

/**
 * Plans EVERY step a message needs, in order.
 *
 * `planChatAction` returns one action, which is why "perbaiki laporan ini lalu
 * export PDF" only exported — the user asked for two things and got half a job. This
 * splits a compound request into the steps it actually implies, so the chat behaves
 * like an agent doing the work rather than a router picking a button.
 *
 * The rules are deliberately conservative: an explicit export asked for together with
 * a regenerate produces [generate, export]; a question produces no steps (the caller
 * answers it in prose); anything else falls back to the single action.
 */
export function planChatSteps(message: string, context: PlannerContext): ChatAction[] {
  const text = message.trim();
  const primary = planChatAction(text, context);

  // A pure question is answered, not executed. Doing work on "apa yang masih kosong?"
  // would be the assistant answering a question nobody asked.
  const isQuestion = asksQuestion(text);
  const wantsResolve = RESOLVE_GAPS.test(text);
  const explicitWork =
    GENERATE_ALL.test(text) || EXPORT.test(text) || wantsResolve || hasIdentityFields(extractIdentity(text));
  if (isQuestion && !explicitWork) return [];

  const wantsWork = GENERATE_ALL.test(text);
  const wantsFile = EXPORT.test(text);

  // "Nama: Farid, NIM: … lalu export" carries data AND a command. Saving the data
  // is a real step of the job: without it the export runs before the cover is
  // filled and ships a blank identity page.
  const identity = extractIdentity(text);
  if (hasIdentityFields(identity)) {
    const named = (['nama', 'nim', 'kelas', 'tanggal'] as const).filter((field) => identity[field]);
    const steps: ChatAction[] = [
      {
        kind: 'identity',
        text,
        identity,
        label: `Saving your cover details (${named.join(', ')})`,
      },
    ];
    if (wantsWork) {
      const namedHeading = findNamedHeading(text, context.headings);
      steps.push(
        namedHeading
          ? { kind: 'generate-section', target: namedHeading, text, label: `Regenerating “${namedHeading}”` }
          : { kind: 'generate-all', text, label: 'Drafting every section' },
      );
    }
    if (wantsFile) {
      steps.push({
        kind: /\bpdf\b/i.test(text) ? 'export-pdf' : 'export-docx',
        text,
        label: /\bpdf\b/i.test(text) ? 'Then exporting as PDF' : 'Then exporting as DOCX',
      });
    }
    return steps;
  }

  // "verifikasi lalu export" is two jobs: the verification changes the document,
  // and the file has to be built after it, not before. Without this branch the
  // export wins and the user gets a file still full of `[PERLU DICEK]`.
  if (wantsResolve && (wantsWork || wantsFile)) {
    const steps: ChatAction[] = [];
    if (wantsWork) {
      const namedHeading = findNamedHeading(text, context.headings);
      steps.push(
        namedHeading
          ? { kind: 'generate-section', target: namedHeading, text, label: `Regenerating “${namedHeading}”` }
          : { kind: 'generate-all', text, label: 'Drafting every section' },
      );
    }
    steps.push({
      kind: 'resolve-gaps',
      text,
      label: 'Checking the unverified values against your sources',
    });
    if (wantsFile) {
      steps.push({
        kind: /\bpdf\b/i.test(text) ? 'export-pdf' : 'export-docx',
        text,
        label: /\bpdf\b/i.test(text) ? 'Then exporting as PDF' : 'Then exporting as DOCX',
      });
    }
    return steps;
  }

  // Regenerate-then-export: two verbs, two jobs, both expected in one reply.
  if (wantsWork && wantsFile) {
    const steps: ChatAction[] = [];
    const namedHeading = findNamedHeading(text, context.headings);
    if (namedHeading) {
      steps.push({ kind: 'generate-section', target: namedHeading, text, label: `Regenerating “${namedHeading}”` });
    } else {
      steps.push({ kind: 'generate-all', text, label: 'Drafting every section' });
    }
    steps.push({
      kind: /\bpdf\b/i.test(text) ? 'export-pdf' : 'export-docx',
      text,
      label: /\bpdf\b/i.test(text) ? 'Then exporting as PDF' : 'Then exporting as DOCX',
    });
    return steps;
  }

  return [primary];
}

/** Resolves a heading mentioned in the message, if any. */
function findNamedHeading(text: string, headings: string[]): string | undefined {
  const lower = text.toLowerCase();
  return headings.find((heading) => {
    const needle = heading.trim().toLowerCase();
    const numbered = /^(\d+(?:\.\d+)+)/.exec(needle);
    if (numbered && lower.includes(numbered[1]!)) return true;
    return needle.length >= 6 && lower.includes(needle);
  });
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
