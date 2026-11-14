import { describe, expect, it } from 'vitest';
import {
  classifyCoverDateLabel,
  coverDateReplacements,
  dateFieldsStillBlank,
  datePromptsIn,
  formatCoverDate,
  labelBeforePrompt,
} from '../src/services/export/index.js';

/**
 * Cover dates must be filled only where the template's own label says the date is
 * "when this document was produced".
 *
 * The tempting shortcut — fill every date prompt with today — is wrong for the most
 * common template in this app, whose label reads "Tanggal Pengumpulan" (submission
 * date). A report is written on one day and handed in on another, so stamping the
 * export date there would put a confidently wrong fact on the cover. These tests
 * pin the distinction so a later "just fill it in" change cannot quietly undo it.
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

  it('treats submission wording as a submission date', () => {
    for (const label of [
      'Tanggal Pengumpulan',
      'Tanggal Penyerahan',
      'Tanggal Pengiriman',
      'Batas Pengumpulan',
      'Tenggat',
      'Submission Date',
      'Deadline',
    ]) {
      expect(classifyCoverDateLabel(label)).toBe('submission');
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

  it('does NOT fill a submission date with the export date', () => {
    const replacements = coverDateReplacements(cover, new Date('2026-11-13T10:00:00Z'));
    expect(replacements).toHaveLength(0);
    expect(dateFieldsStillBlank(cover).map((entry) => entry.prompt)).toEqual(['[ Tuliskan Tanggal Pengumpulan ]']);
  });

  it('DOES fill a generation date', () => {
    const generated = 'Tanggal Pembuatan : [ Tuliskan Tanggal Pembuatan ]';
    const replacements = coverDateReplacements(generated, new Date(2026, 10, 13));
    expect(replacements).toEqual([{ find: '[ Tuliskan Tanggal Pembuatan ]', replace: '13 November 2026' }]);
    expect(dateFieldsStillBlank(generated)).toHaveLength(0);
  });

  it('fills the generated date but leaves a neighbouring submission date alone', () => {
    const mixed = [
      'Tanggal Pembuatan : [ Tuliskan Tanggal Pembuatan ]',
      'Tanggal Pengumpulan : [ Tuliskan Tanggal Pengumpulan ]',
    ].join('\n');
    const replacements = coverDateReplacements(mixed, new Date(2026, 10, 13));
    expect(replacements.map((entry) => entry.find)).toEqual(['[ Tuliskan Tanggal Pembuatan ]']);
    expect(dateFieldsStillBlank(mixed).map((entry) => entry.prompt)).toEqual(['[ Tuliskan Tanggal Pengumpulan ]']);
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
