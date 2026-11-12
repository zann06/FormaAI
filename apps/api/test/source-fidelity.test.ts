import { describe, expect, it } from 'vitest';
import {
  cleanEvidenceText,
  findSuspiciousTokens,
  markSuspiciousInBody,
  markSuspiciousInTable,
  stripInventedQuotes,
  stripOcrAnnotations,
} from '../src/services/generation/source-fidelity.js';

/**
 * Both defects below were found in a real exported report, not invented:
 * the source chunk read `C:\>apconfig /all` (OCR damage for `ipconfig`), and the
 * draft contained `???Reply from 192.168.10.10???` although no source chunk
 * contained a single `???`.
 */
describe('findSuspiciousTokens', () => {
  it('flags the OCR misread that reached the report', () => {
    const tokens = findSuspiciousTokens('C:\\>apconfig /all');
    expect(tokens.map((t) => t.token)).toEqual(['apconfig']);
  });

  it('does not flag real commands', () => {
    const text = 'ipconfig /all\nping 192.168.10.10\nshow running-config\ntracert 8.8.8.8';
    expect(findSuspiciousTokens(text)).toEqual([]);
  });

  it('ignores short tokens, where a one-edit match is coincidence', () => {
    // "ping" vs "ip" is within reach of short tokens; length >= 5 prevents noise.
    expect(findSuspiciousTokens('ing 123')).toEqual([]);
  });

  it('reports each damaged token once', () => {
    const tokens = findSuspiciousTokens('apconfig then apconfig again');
    expect(tokens).toHaveLength(1);
  });
});

describe('cleanEvidenceText', () => {
  it('removes unreadable replacement glyphs and records a note', () => {
    const result = cleanEvidenceText('Reply from 192.168.10.10\uFFFD\uFFFD');
    expect(result.text).toBe('Reply from 192.168.10.10');
    expect(result.notes).toHaveLength(1);
  });

  it('leaves clean text untouched and silent', () => {
    const result = cleanEvidenceText('ipconfig /all');
    expect(result.text).toBe('ipconfig /all');
    expect(result.notes).toEqual([]);
  });

  /**
   * The warning-only version of this did not work: the model copied `apconfig`
   * into seven sections of a real report, because it is told to reproduce the
   * evidence exactly. Marking the token in the evidence is what stops it.
   */
  it('marks a misread command inline so it cannot be restated as fact', () => {
    const result = cleanEvidenceText('C:\\>apconfig /all');
    expect(result.text).toContain('apconfig [OCR?');
    expect(result.text).toContain('ipconfig');
    expect(result.notes.join(' ')).toContain('apconfig');
  });

  it('keeps the original word next to the marker for a human to compare', () => {
    const result = cleanEvidenceText('C:\\>apconfig /all');
    // Deleting the odd reading would hide the evidence; it must stay visible.
    expect(result.text).toMatch(/C:\\>apconfig \[OCR\?/);
  });

  it('does not mark real commands', () => {
    expect(cleanEvidenceText('ipconfig /all\nping 192.168.10.1').text).not.toContain('[OCR?');
  });
});

describe('stripOcrAnnotations', () => {
  it('removes the internal marker from a finished body', () => {
    const result = stripOcrAnnotations('Perintah apconfig [OCR? looks like a misread "ipconfig"] dijalankan.');
    expect(result.changed).toBe(true);
    expect(result.body).toBe('Perintah apconfig dijalankan.');
  });

  it('reports no change when there is no marker', () => {
    const result = stripOcrAnnotations('Perintah ipconfig dijalankan.');
    expect(result.changed).toBe(false);
    expect(result.body).toBe('Perintah ipconfig dijalankan.');
  });
});

describe('stripInventedQuotes', () => {
  it('removes the ??? marks the model invented around a real source line', () => {
    const body = 'Pengujian berhasil dengan respons ???Reply from 192.168.10.10???.';
    const evidence = 'Reply from 192.168.10.10 bytes=32 time<1ms TTL=127';
    const result = stripInventedQuotes(body, evidence);
    expect(result.changed).toBe(true);
    expect(result.body).not.toContain('???');
    expect(result.body).toContain('Reply from 192.168.10.10');
  });

  it('preserves marks that genuinely belong to the source', () => {
    const body = 'Data ditandai ???unknown??? pada kolom keterangan.';
    const evidence = 'keterangan: ???unknown???';
    const result = stripInventedQuotes(body, evidence);
    expect(result.changed).toBe(false);
    expect(result.body).toContain('???');
  });

  it('reports no change when the body has no marks at all', () => {
    const result = stripInventedQuotes('Tidak ada tanda kutip aneh.', 'sumber bersih');
    expect(result.changed).toBe(false);
  });
});

/**
 * The marker-strip above assumed the model copies our `[OCR? …]` note. In the
 * real run it dropped the marker and wrote the raw token ("menjalankan perintah
 * apconfig /all"), so the report presented a misread command as a fact while the
 * section's own warning admitted it was probably `ipconfig`. These cover that gap.
 */
describe('markSuspiciousInBody', () => {
  const evidence = 'C:\\>apconfig [OCR? looks like a misread "ipconfig"] /all';

  it('marks a damaged token the model restated as fact', () => {
    const body = 'Sesi menjalankan perintah apconfig /all dari prompt C:\\>.';
    const result = markSuspiciousInBody(body, evidence);
    expect(result.tokens).toEqual(['apconfig']);
    // The token stays readable but is visibly not certain.
    expect(result.body).toContain('apconfig [sic? verify against source]');
    expect(result.body).not.toMatch(/\bapconfig\b(?! \[sic\? verify)/);
  });

  it('marks every occurrence, not only the first', () => {
    const body = 'Perintah apconfig /all lalu apconfig /all lagi.';
    const result = markSuspiciousInBody(body, evidence);
    expect(result.body.match(/\[sic\? verify against source\]/g)).toHaveLength(2);
  });

  it('does not mark a body that is already marked a second time', () => {
    // A retry or a regenerate can run the scrub over its own output; marking
    // twice would produce "[sic? verify against source] [sic? verify against source]".
    const once = markSuspiciousInBody('Perintah apconfig /all dijalankan.', evidence);
    const twice = markSuspiciousInBody(once.body, evidence);
    expect(twice.tokens).toEqual([]);
    expect(twice.body).toBe(once.body);
    expect(twice.body.match(/\[sic\?/g)).toHaveLength(1);
  });

  it('leaves a body untouched when the evidence raised no doubt', () => {
    const body = 'Klien memperoleh alamat melalui DHCP.';
    const result = markSuspiciousInBody(body, 'Konfigurasi DHCP pool 192.168.10.0/24 berhasil.');
    expect(result.tokens).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('does not mark a correct command that happens to resemble another', () => {
    // `ipconfig` is the real command; the source is clean, so nothing is flagged.
    const result = markSuspiciousInBody('Jalankan ipconfig /all.', 'C:\\>ipconfig /all');
    expect(result.tokens).toEqual([]);
    expect(result.body).toBe('Jalankan ipconfig /all.');
  });

  it('marks only the token the evidence actually flagged', () => {
    const result = markSuspiciousInBody('Hal ini tidak ditemukan pada sumber.', evidence);
    expect(result.tokens).toEqual([]);
    expect(result.body).toBe('Hal ini tidak ditemukan pada sumber.');
  });
});

/**
 * Tables bypass the prose body, so a body-only scrub left the damaged token in the
 * cells. In a real export 6 of 10 `apconfig` occurrences were table cells.
 */
describe('markSuspiciousInTable', () => {
  const evidence = 'C:\\>apconfig [OCR? looks like a misread "ipconfig"] /all';

  it('marks cells, headers and the caption', () => {
    const table = {
      caption: 'Keluaran apconfig /all',
      columns: ['Perintah', 'Keterangan'],
      rows: [['apconfig /all', 'Dijalankan dari prompt']],
    };
    const result = markSuspiciousInTable(table, evidence);
    expect(result.tokens).toEqual(['apconfig']);
    expect(result.table!.caption).toContain('apconfig [sic? verify against source]');
    expect(result.table!.columns[0]).toBe('Perintah');
    expect(result.table!.rows[0]![0]).toBe('apconfig [sic? verify against source] /all');
  });

  it("marks a cell that states the misread as a fact", () => {
    // Straight from the exported report: it asserted the wrong command was read.
    const table = {
      columns: ['Temuan'],
      rows: [['Perintah pada Command Line PC terbaca apconfig, bukan ipconfig, sehingga keluaran tidak dapat diverifikasi.']],
    };
    const result = markSuspiciousInTable(table, evidence);
    expect(result.table!.rows[0]![0]).toContain('terbaca apconfig [sic? verify against source], bukan ipconfig');
  });

  it('leaves a clean table byte-identical', () => {
    const table = { columns: ['Alamat IP'], rows: [['192.168.10.10']] };
    const result = markSuspiciousInTable(table, evidence);
    expect(result.tokens).toEqual([]);
    expect(result.table).toEqual(table);
  });

  it('returns a null table untouched', () => {
    expect(markSuspiciousInTable(null, evidence).table).toBeNull();
    expect(markSuspiciousInTable(undefined, evidence).table).toBeUndefined();
  });
});
