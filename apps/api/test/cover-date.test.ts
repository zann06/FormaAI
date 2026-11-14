import { describe, expect, it } from 'vitest';
import {
  classifyCoverDateLabel,
  coverDateReplacements,
  dateFieldsStillBlank,
  datePromptsIn,
  formatCoverDate,
  identityReplacements,
  labelBeforePrompt,
} from '../src/services/export/index.js';

/**
 * Cover dates are filled from the export date, but only where that is the truth.
 *
 * The submission date is the day of the export: a report finished and exported on
 * the same day is handed in that day (the user's own rule). A deadline is not — it
 * is the last day the work MAY be handed in, often set by the course well after the
 * fact — so filling it with the export date would print a deadline that does not
 * exist. These tests pin the difference so neither side drifts.
 */
describe('cover date classification', () => {
  it('reads the label that sits beside a prompt, not the whole page', () => {
    const text = 'Nama : [ Tuliskan Nama Lengkap Anda ]\nTanggal Pengumpulan : [ Tuliskan Tanggal Pengumpulan ]';
    expect(labelBeforePrompt(text, '[ Tuliskan Tanggal Pengumpulan ]')).toBe('Tanggal Pengumpulan');
  });

  it('collapses the template padding used to align cover lines', () => {
    const text = 'Tanggal   Pembuatan    :   [ Tuliskan Tanggal Pembuatan ]';
    expect(labelBeforePrompt(text, '[ Tuliskan Tanggal Pembuatan ]')).toBe('Tanggal Pembuatan');
  });

  it('treats submission wording as the day of the export', () => {
    for (const label of [
      'Tanggal Pengumpulan',
      'Tanggal Penyerahan',
      'Tanggal Pengiriman',
      'Dikumpulkan Pada',
      'Submission Date',
    ]) {
      expect(classifyCoverDateLabel(label)).toBe('submission');
    }
  });

  it('treats a limit on when it may be handed in as a deadline, not a submission', () => {
    // "Batas Pengumpulan" contains "pengumpulan", but it is the opposite idea: a
    // limit the course set, which the export date cannot know.
    for (const label of ['Batas Pengumpulan', 'Tenggat Pengumpulan', 'Deadline', 'Batas Waktu Pengiriman']) {
      expect(classifyCoverDateLabel(label)).toBe('deadline');
    }
  });

  it('treats production wording as a generation date', () => {
    for (const label of ['Tanggal Pembuatan', 'Tanggal Penyusunan', 'Dibuat Pada', 'Generated', 'Prepared On']) {
      expect(classifyCoverDateLabel(label)).toBe('generated');
    }
  });

  it('leaves an unrecognised label unknown rather than assuming', () => {
    expect(classifyCoverDateLabel('Keterangan')).toBe('unknown');
    expect(classifyCoverDateLabel('')).toBe('unknown');
    expect(classifyCoverDateLabel(null)).toBe('unknown');
  });

  it('wins on the submission side when a label mentions both ideas', () => {
    // "Tanggal Pengumpulan Laporan" mentions "laporan"; it must not be read as
    // generated just because a looser rule matched a word inside it.
    expect(classifyCoverDateLabel('Tanggal Pengumpulan Laporan')).toBe('submission');
  });
});

describe('cover date prompts', () => {
  const cover = [
    'Nama Mahasiswa : [ Tuliskan Nama Lengkap Anda ]',
    'NIM : [ Tuliskan NIM Anda ]',
    'Kelas : [ RA / RB / RC / RD ]',
    'Tanggal Pengumpulan : [ Tuliskan Tanggal Pengumpulan ]',
    'LAMPUNG SELATAN 2026',
  ].join('\n');

  it('finds date prompts and ignores identity prompts', () => {
    const prompts = datePromptsIn(cover).map((entry) => entry.prompt);
    expect(prompts).toContain('[ Tuliskan Tanggal Pengumpulan ]');
    expect(prompts).not.toContain('[ Tuliskan Nama Lengkap Anda ]');
    expect(prompts).not.toContain('[ RA / RB / RC / RD ]');
  });

  it('fills the submission date from the export date', () => {
    const replacements = coverDateReplacements(cover, new Date(2026, 10, 13));
    expect(replacements).toEqual([{ find: '[ Tuliskan Tanggal Pengumpulan ]', replace: '13 November 2026' }]);
    // Nothing is left to ask the user about.
    expect(dateFieldsStillBlank(cover)).toHaveLength(0);
  });

  it('follows the new day when the same project is exported again', () => {
    // The user's rule: "semisal saya kerjain hari itu yaa berati hari itu juga".
    // Exporting tomorrow must not keep yesterday's date on the cover.
    const monday = coverDateReplacements(cover, new Date(2026, 10, 13));
    const tuesday = coverDateReplacements(cover, new Date(2026, 10, 14));
    expect(monday[0]!.replace).toBe('13 November 2026');
    expect(tuesday[0]!.replace).toBe('14 November 2026');
  });

  it('fills a generation date the same way', () => {
    const generated = 'Tanggal Pembuatan : [ Tuliskan Tanggal Pembuatan ]';
    const replacements = coverDateReplacements(generated, new Date(2026, 10, 13));
    expect(replacements).toEqual([{ find: '[ Tuliskan Tanggal Pembuatan ]', replace: '13 November 2026' }]);
    expect(dateFieldsStillBlank(generated)).toHaveLength(0);
  });

  it('fills both dates on a cover that carries both', () => {
    const mixed = [
      'Tanggal Pembuatan : [ Tuliskan Tanggal Pembuatan ]',
      'Tanggal Pengumpulan : [ Tuliskan Tanggal Pengumpulan ]',
    ].join('\n');
    const replacements = coverDateReplacements(mixed, new Date(2026, 10, 13));
    expect(replacements.map((entry) => entry.find)).toEqual([
      '[ Tuliskan Tanggal Pembuatan ]',
      '[ Tuliskan Tanggal Pengumpulan ]',
    ]);
    expect(dateFieldsStillBlank(mixed)).toHaveLength(0);
  });

  it('never fills a deadline with the export date', () => {
    const withDeadline = 'Batas Pengumpulan : [ Tuliskan Batas Pengumpulan ]';
    expect(coverDateReplacements(withDeadline, new Date(2026, 10, 13))).toHaveLength(0);
    const blank = dateFieldsStillBlank(withDeadline);
    expect(blank).toEqual([{ prompt: '[ Tuliskan Batas Pengumpulan ]', kind: 'deadline' }]);
  });

  it('never treats rubric or screenshot prompts as dates', () => {
    const other = [
      'Status : [ LULUS / REVISI ]',
      'Catatan : [ ... ]',
      '[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ]',
      '[AD 110 / Metrik Cost]',
    ].join('\n');
    expect(datePromptsIn(other)).toHaveLength(0);
  });
});

describe('cover date formatting', () => {
  it('writes an Indonesian long date instead of a database value', () => {
    expect(formatCoverDate(new Date(2026, 10, 13))).toBe('13 November 2026');
    expect(formatCoverDate(new Date(2026, 0, 1))).toBe('1 Januari 2026');
  });

  it('uses the local calendar date, not UTC', () => {
    // Late-evening local time must not roll back a day the way toISOString can.
    const evening = new Date(2026, 10, 13, 23, 30, 0);
    expect(formatCoverDate(evening)).toBe('13 November 2026');
  });
});

describe('submission date ownership', () => {
  const cover = 'Tanggal Pengumpulan : [ Tuliskan Tanggal Pengumpulan ]';

  it('does not read a stored date out of the instructions by default', () => {
    // With no date stated, the cover prompt is left for the export date.
    const replacements = identityReplacements('Nama: Farid\nNIM: 124140210\nKelas: RA');
    expect(replacements.map((entry) => entry.find)).not.toContain('[ Tuliskan Tanggal Pengumpulan ]');
  });

  it('lets an explicitly stated date claim its prompt', () => {
    const replacements = identityReplacements('Nama: Farid\nTanggal: 1 Desember 2026');
    expect(replacements).toContainEqual({ find: '[ Tuliskan Tanggal Pengumpulan ]', replace: '1 Desember 2026' });
  });

  it('does not let the export date overwrite a date the user stated', () => {
    // Both replacements target the same literal prompt, so the export-date default
    // has to know the prompt is already taken — otherwise the date the user typed is
    // silently swapped for the day of the export.
    const identity = identityReplacements('Tanggal: 1 Desember 2026');
    const auto = coverDateReplacements(
      cover,
      new Date(2026, 10, 14),
      identity.map((entry) => entry.find),
    );
    expect(auto).toHaveLength(0);
    expect(dateFieldsStillBlank(cover, identity.map((entry) => entry.find))).toHaveLength(0);
  });

  it('still fills the date when the user said nothing about it', () => {
    const identity = identityReplacements('Nama: Farid');
    const auto = coverDateReplacements(
      cover,
      new Date(2026, 10, 14),
      identity.map((entry) => entry.find),
    );
    expect(auto).toEqual([{ find: '[ Tuliskan Tanggal Pengumpulan ]', replace: '14 November 2026' }]);
  });
});
