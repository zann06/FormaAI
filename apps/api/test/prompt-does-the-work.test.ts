/**
 * The prompt must let the model DO the work, while keeping the report honest.
 *
 * The original rules said "use ONLY the evidence" and "if the evidence does not
 * support it, do not guess", which made the writer refuse work a student would
 * obviously do — subnet maths from a stated base network, conclusions from
 * observed output. The report shipped with 31 `[MISSING]` holes because of it.
 *
 * These tests pin the corrected contract in both directions: the model is told to
 * compute and derive, and it is still forbidden from inventing recorded values.
 */
import { describe, expect, it } from 'vitest';
import { buildSectionMessages, SYSTEM_PROMPT, sectionExpectsTable } from '../src/services/generation/prompts.js';
import { countGapMarkers, countComputedValues, isOnlyGapMarkers } from '@formaai/shared';

describe('the writer is told to do the work', () => {
  it('no longer restricts the model to quoting the evidence alone', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/Use ONLY the evidence/i);
  });

  it('explicitly asks for computed values such as VLSM subnetting', () => {
    expect(SYSTEM_PROMPT).toMatch(/COMPUTE/i);
    expect(SYSTEM_PROMPT).toMatch(/VLSM|subnet/i);
    expect(SYSTEM_PROMPT).toMatch(/wildcard|broadcast|host count/i);
  });

  it('explicitly allows deriving conclusions and explaining mechanism', () => {
    expect(SYSTEM_PROMPT).toMatch(/DERIVE/i);
    expect(SYSTEM_PROMPT).toMatch(/OSPF/);
    expect(SYSTEM_PROMPT).toMatch(/[Ee]xplaining how the technology works is not fabrication/);
  });

  it('still forbids inventing recorded facts, sources and identifiers', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never invent external facts, sources, citations/i);
    expect(SYSTEM_PROMPT).toMatch(/Never invent that kind of value/i);
  });

  it('requires a visible marker on every computed figure', () => {
    expect(SYSTEM_PROMPT).toMatch(/\(dihitung\)/);
    expect(SYSTEM_PROMPT).toMatch(/\(diturunkan dari/);
  });

  it('marks an underivable value with a marker a reader can find', () => {
    expect(SYSTEM_PROMPT).toMatch(/\[PERLU DICEK:/);
  });
});

describe('table sections are built, not deferred', () => {
  it('recognises a table heading', () => {
    expect(sectionExpectsTable('2.3 Tabel Alokasi Pengalamatan IP', [], [])).toBe(true);
  });

  it('tells the model to compute every row instead of leaving cells empty', () => {
    const messages = buildSectionMessages({
      projectTitle: 'Tugas Jaringan',
      language: 'id',
      sectionHeading: '2.3 Tabel Alokasi Pengalamatan IP Lengkap',
      sectionLevel: 2,
      requirements: [],
      contentPlan: [],
      gaps: [],
      conflicts: [],
      evidence: [{ id: 'e1', documentName: '1.png', page: null, paragraphIndex: null, text: '192.168.10.0/24' }],
    });
    const user = messages[1]!.content;
    expect(user).toMatch(/BUILD the table/i);
    expect(user).toMatch(/compute every row/i);
    expect(user).toMatch(/The ROWS come from the evidence/i);
    expect(user).toMatch(/Never invent a row or a cell/i);
    // The old wording actively invited an empty table.
    expect(user).not.toMatch(/Never invent a cell/i);
  });
});

describe('gap and derived-value accounting', () => {
  it('recognises both marker languages', () => {
    expect(countGapMarkers('Nama: [PERLU DICEK: tanggal] dan [MISSING: date]')).toBe(2);
    expect(countGapMarkers('isi lengkap tanpa penanda')).toBe(0);
  });

  it('treats a section holding only a marker as empty', () => {
    expect(isOnlyGapMarkers('[PERLU DICEK: hasil pengamatan]')).toBe(true);
    expect(isOnlyGapMarkers('[MISSING: name]')).toBe(true);
    expect(isOnlyGapMarkers('Teks asli. [PERLU DICEK: tanggal]')).toBe(false);
  });

  it('counts derived figures so they can be reported separately', () => {
    expect(countComputedValues('Mask 255.255.255.192 (dihitung) dan OSPF menang (diturunkan dari tabel)')).toBe(2);
    expect(countComputedValues('teks biasa tanpa turunan')).toBe(0);
  });
});
