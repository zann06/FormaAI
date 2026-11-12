import { describe, expect, it } from 'vitest';
import { planChatAction, summariseSteps } from '../lib/chat-actions';

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
