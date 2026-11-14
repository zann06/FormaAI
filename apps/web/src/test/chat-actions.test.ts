import { describe, expect, it } from 'vitest';
import { extractIdentity, mergeIdentity, planChatAction, planChatSteps, summariseSteps } from '../lib/chat-actions';

/**
 * The chat is the primary surface of the workspace, so what a message *does* is
 * product behaviour, not an implementation detail. These tests pin the routing
 * rules: a user who types "export as pdf" must get a file, not a saved
 * instruction, and a user who types a sentence about their own writing must not
 * accidentally trigger a 44-section regeneration.
 */
describe('planChatAction', () => {
  const context = {
    headings: [
      'BAB I: PENDAHULUAN',
      '2.3 Tabel Alokasi Pengalamatan IP Lengkap',
      '3.4 Verifikasi Alokasi IP Address Otomatis',
    ],
  };

  it('routes an export request to a file, not a draft', () => {
    expect(planChatAction('export the report please', context).kind).toBe('export-docx');
    expect(planChatAction('tolong ekspor laporannya', context).kind).toBe('export-docx');
  });

  it('picks PDF when the message names PDF', () => {
    expect(planChatAction('export as pdf', context).kind).toBe('export-pdf');
    expect(planChatAction('buat file pdf', context).kind).toBe('export-pdf');
  });

  it('prefers the export when a message mentions both generating and exporting', () => {
    // "generate and export" contains both verbs; the user is waiting on a file,
    // so producing one wins.
    expect(planChatAction('generate and export the docx', context).kind).toBe('export-docx');
  });

  it('routes a draft request to the whole pipeline', () => {
    expect(planChatAction('generate the report', context).kind).toBe('generate-all');
    expect(planChatAction('tolong tulis semua bagian', context).kind).toBe('generate-all');
  });

  it('targets a named section instead of the whole report', () => {
    const action = planChatAction('regenerate 2.3', context);
    expect(action.kind).toBe('generate-section');
    expect(action.target).toBe('2.3 Tabel Alokasi Pengalamatan IP Lengkap');
  });

  it('matches a section by its wording, not only by its number', () => {
    const action = planChatAction('rewrite the section 3.4 Verifikasi Alokasi IP Address Otomatis please', context);
    expect(action.kind).toBe('generate-section');
    expect(action.target).toBe('3.4 Verifikasi Alokasi IP Address Otomatis');
  });

  it('answers a status question with the status view', () => {
    expect(planChatAction('what is the status?', context).kind).toBe('status');
    expect(planChatAction('bagian mana yang masih kosong?', context).kind).toBe('status');
    expect(planChatAction('berapa yang sudah selesai?', context).kind).toBe('status');
  });

  it('opens the outline when the message asks about structure', () => {
    expect(planChatAction('show me the outline', context).kind).toBe('open-outline');
  });

  it('opens sources when the message asks where to put a file', () => {
    expect(planChatAction('where do I upload a zip?', context).kind).toBe('open-sources');
  });

  it('treats an unmatched sentence as a standing instruction', () => {
    // This is the safe default: it must never start a long job by accident.
    const action = planChatAction('please use a formal academic tone and cite the screenshots', context);
    expect(action.kind).toBe('instruction');
    expect(action.text).toBe('please use a formal academic tone and cite the screenshots');
  });

  it('does not treat a status question as an export request', () => {
    // "file" and "missing" appear together often; status must win.
    expect(planChatAction('which part of the file is still missing?', context).kind).toBe('status');
  });

  it('always provides a human label for the activity trail', () => {
    for (const message of ['generate', 'export pdf', 'status?', 'be more formal', 'regenerate 2.3']) {
      expect(planChatAction(message, context).label.length).toBeGreaterThan(0);
    }
  });

  /**
   * The reported failure, verbatim. This message produced no visible reply at all.
   * Two causes: "buatkan" was not a recognised generate verb (only bare "buat"),
   * and the word "source"/"zip" made an earlier rule offer to open Sources — so a
   * clear request for a report resolved to "saving this instruction".
   */
  it('routes the real report request from the chat log to drafting', () => {
    const message =
      'buatkan laporan dari template yang di berikan dan dokumentasi/source bisa dari sumber zip yang saya berikan\n\nNama : Farid Rizky Fauzan';
    const action = planChatAction(message, context);
    expect(action.kind).toBe('generate-all');
    expect(action.text).toBe(message);
  });

  it('still opens Sources for a real question about where to upload', () => {
    expect(planChatAction('where do I upload a zip?', context).kind).toBe('open-sources');
    expect(planChatAction('bagaimana cara upload sumber?', context).kind).toBe('open-sources');
  });

  it('does not start a rewrite when the user is only asking about the report', () => {
    expect(planChatAction('what does the report say about VLANs?', context).kind).toBe('instruction');
    expect(planChatAction('apa isi laporan ini?', context).kind).toBe('instruction');
  });

  it('recognises the common Indonesian ways of asking for a report', () => {
    for (const message of ['buatkan laporan', 'tolong buatkan laporannya', 'bikin laporan dong', 'tuliskan laporan']) {
      expect(planChatAction(message, context).kind).toBe('generate-all');
    }
  });

  /**
   * Verifying the `[PERLU DICEK]` markers is its own job. Routing it to the draft
   * pipeline would rewrite supported prose — and would not fill a single marker,
   * because generation reads the same OCR text that produced the gap.
   */
  it('routes a verification request to gap resolution, not to a redraft', () => {
    for (const message of [
      'tolong verifikasi nilai yang masih perlu dicek',
      'cek ulang semua tanda perlu dicek',
      'lengkapi nilai yang belum terbukti',
      'cross-check the unverified values',
    ]) {
      expect(planChatAction(message, context).kind).toBe('resolve-gaps');
    }
  });

  it('does not mistake a status question about gaps for a verification run', () => {
    expect(planChatAction('bagian mana yang masih kosong?', context).kind).toBe('status');
    expect(planChatAction('berapa yang belum selesai?', context).kind).toBe('status');
  });
});

describe('identity captured from chat', () => {
  const context = { headings: ['BAB I PENDAHULUAN'] };

  it('reads the cover details out of an ordinary sentence', () => {
    // The real message: these details never reached the server, so the exported
    // cover kept showing "[ Tuliskan Nama Lengkap Anda ]".
    const action = planChatAction('nama saya Farid Rizky Fauzan, NIM 124140210, kelas RA', context);
    expect(action.kind).toBe('identity');
    expect(action.identity).toEqual({ nama: 'Farid Rizky Fauzan', nim: '124140210', kelas: 'RA' });
  });

  it('accepts labelled form as well', () => {
    const action = planChatAction('Nama: Farid Rizky Fauzan\nNIM: 124140210\nKelas: RA', context);
    expect(action.kind).toBe('identity');
    expect(action.identity?.nama).toBe('Farid Rizky Fauzan');
    expect(action.identity?.nim).toBe('124140210');
    expect(action.identity?.kelas).toBe('RA');
  });

  it('does not mistake a class label for the name', () => {
    const fields = extractIdentity('nim 124140210');
    expect(fields.nama).toBeUndefined();
    expect(fields.nim).toBe('124140210');
  });

  it('keeps a name that contains a dot and an apostrophe', () => {
    expect(extractIdentity("nama saya M. Yusuf Ma'ruf, kelas RB").nama).toBe("M. Yusuf Ma'ruf");
  });

  it('captures a submission date when one is given', () => {
    expect(extractIdentity('tanggal pengumpulan 20 November 2026').tanggal).toBe('20 November 2026');
  });

  it('rejects a "class" that swallowed half the sentence', () => {
    // "kelas RA dan NIM ..." must not keep the trailing words as the class.
    const fields = extractIdentity('nama Farid kelas RA');
    expect(fields.kelas).toBe('RA');
  });

  it('leaves an ordinary instruction alone', () => {
    const action = planChatAction('pakai bahasa Indonesia formal', context);
    expect(action.kind).toBe('instruction');
    expect(action.identity).toBeUndefined();
  });

  it('still treats a generate request as work, not identity', () => {
    expect(planChatAction('buatkan laporan', context).kind).toBe('generate-all');
  });
});

describe('summariseSteps', () => {
  it('keeps every step message and marks skipped and failed ones differently', () => {
    const lines = summariseSteps('Finished.', [
      { name: 'analyze', status: 'done', message: 'Template read: 44 sections.' },
      { name: 'map', status: 'skipped', message: 'No evidence to map.' },
      { name: 'draft', status: 'failed', message: 'Drafting failed: no provider.' },
    ]);
    expect(lines).toEqual([
      '✓ Template read: 44 sections.',
      '· No evidence to map.',
      '✗ Drafting failed: no provider.',
      'Finished.',
    ]);
  });

  it('omits steps that carry no message rather than printing empty bullets', () => {
    const lines = summariseSteps(null, [
      { name: 'analyze', status: 'done' },
      { name: 'draft', status: 'done', message: 'Drafted 38 sections.' },
    ]);
    expect(lines).toEqual(['✓ Drafted 38 sections.']);
  });

  it('returns nothing when there is nothing to report', () => {
    expect(summariseSteps('', [])).toEqual([]);
  });
});

/**
 * The chat must behave like an agent: a message that asks for two things does both,
 * and a question gets an answer instead of being silently stored as an instruction.
 */
describe('planChatSteps', () => {
  const context = {
    headings: [
      'BAB I: PENDAHULUAN',
      '2.3 Tabel Alokasi Pengalamatan IP Lengkap',
      '3.2 Konfigurasi Switch dan Access Point Nirkabel',
    ],
  };

  it('regenerates and then exports when both are asked for', () => {
    const steps = planChatSteps('perbaiki laporan ini lalu export PDF', context);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe('generate-all');
    expect(steps[1]!.kind).toBe('export-pdf');
  });

  it('regenerates only the named section before exporting', () => {
    const steps = planChatSteps('regenerate 2.3 lalu unduh docx', context);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe('generate-section');
    expect(steps[0]!.target).toContain('Tabel Alokasi');
    expect(steps[1]!.kind).toBe('export-docx');
  });

  it('does not run work for a pure question', () => {
    // A question is answered in prose; running a 44-section regeneration on it would
    // be answering something the user never asked.
    expect(planChatSteps('apa yang masih kosong?', context)).toEqual([]);
    expect(planChatSteps('how many sections are unfinished?', context)).toEqual([]);
  });

  it('still performs explicit work that happens to end in a question mark', () => {
    const steps = planChatSteps('bisakah kamu export pdf?', context);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('export-pdf');
  });

  it('keeps single-command messages as one step', () => {
    expect(planChatSteps('buatkan laporan', context)).toHaveLength(1);
    expect(planChatSteps('generate', context)[0]!.kind).toBe('generate-all');
  });

  it('saves cover details as one step', () => {
    const steps = planChatSteps('Nama: Farid Rizky Fauzan, NIM: 124140210, Kelas: RA', context);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('identity');
  });

  /**
   * The reported cover stayed blank because "Nama: … export" chose the export and
   * dropped the data on the floor. Identity is a step of the job, not decoration.
   */
  it('saves cover details before exporting when one message carries both', () => {
    const steps = planChatSteps('Nama: Farid, NIM: 124140210, Kelas: RA, lalu export DOCX', context);
    expect(steps.map((step) => step.kind)).toEqual(['identity', 'export-docx']);
    expect(steps[0]!.identity).toEqual({ nama: 'Farid', nim: '124140210', kelas: 'RA' });
  });

  it('saves cover details, drafts, then exports in that order', () => {
    const steps = planChatSteps('Nama: Farid, NIM: 124140210. buatkan laporan lalu export pdf', context);
    expect(steps.map((step) => step.kind)).toEqual(['identity', 'generate-all', 'export-pdf']);
  });

  it('verifies and then exports when both are asked for', () => {
    // The export must come after the verification, otherwise the file still
    // contains every `[PERLU DICEK]` the user just asked to close.
    const steps = planChatSteps('verifikasi lalu export pdf', context);
    expect(steps.map((step) => step.kind)).toEqual(['resolve-gaps', 'export-pdf']);
  });

  it('drafts, then verifies, when both are asked for', () => {
    const steps = planChatSteps('generate ulang lalu validasi nilai yang belum terbukti', context);
    expect(steps.map((step) => step.kind)).toEqual(['generate-all', 'resolve-gaps']);
  });

  it('keeps a plain verification request as one step', () => {
    const steps = planChatSteps('tolong periksa nilai yang perlu dicek', context);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('resolve-gaps');
  });
});

describe('mergeIdentity', () => {
  it('keeps standing guidance while adding the cover fields', () => {
    const merged = mergeIdentity('pakai bahasa Indonesia formal', { nama: 'Farid', nim: '124140210' });
    expect(merged).toBe('pakai bahasa Indonesia formal\nNama: Farid\nNIM: 124140210');
  });

  it('updates only the fields the user supplied', () => {
    const merged = mergeIdentity('Nama: Farid\nNIM: 124140210\nKelas: RA', { kelas: 'RB' });
    expect(merged).toContain('Nama: Farid');
    expect(merged).toContain('NIM: 124140210');
    expect(merged).toContain('Kelas: RB');
    expect(merged).not.toContain('Kelas: RA');
  });

  it('accepts the aliases a template or user may write', () => {
    const merged = mergeIdentity('Name: Farid\nClass: RA\nDate: 20 November 2026', { nama: 'Farid Rizky' });
    expect(merged).toContain('Nama: Farid Rizky');
    expect(merged).toContain('Kelas: RA');
    expect(merged).toContain('Tanggal: 20 November 2026');
    expect(merged).not.toContain('Name:');
  });
});

/**
 * The submission date fills itself from the export date, so the chat must not ask
 * for it as if the cover could not be completed without it — and must still honour
 * a date the user states explicitly.
 */
describe('submission date is not a required cover field', () => {
  it('saves a cover message without inventing a date field', () => {
    const merged = mergeIdentity(null, { nama: 'Farid', nim: '124140210', kelas: 'RA' });
    expect(merged).not.toContain('Tanggal:');
    expect(merged.split('\n')).toEqual(['Nama: Farid', 'NIM: 124140210', 'Kelas: RA']);
  });

  it('keeps a date the user states explicitly as an override', () => {
    const merged = mergeIdentity('Nama: Farid', { tanggal: '20 November 2026' });
    expect(merged).toContain('Tanggal: 20 November 2026');
  });

  it('routes an explicit date to the identity step', () => {
    expect(planChatAction('tanggal pengumpulan 20 November 2026', { headings: [] }).kind).toBe('identity');
  });
});