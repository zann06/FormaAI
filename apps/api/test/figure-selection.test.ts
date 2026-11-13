/**
 * Unit tests for the two pure functions behind the cover identity and figure
 * placement.
 *
 * Both were written to fix defects seen on a real report: the cover still read
 * "[ Tuliskan Nama Lengkap Anda ]" after the user supplied their name, and every
 * section carried three screenshots (108 figures for 44 sections) because a single
 * image produces dozens of OCR chunks. These tests pin the behaviour so neither
 * regression can return quietly.
 */
import { describe, expect, it } from 'vitest';
import { looksLikeDiagram, selectFiguresForSection } from '../src/services/generation/index.js';
import { identityReplacements } from '../src/services/export/index.js';

/** Builds the evidence shape the generator produces: one chunk per OCR line. */
function imageChunks(name: string, lines: string[]) {
  return lines.map((text, index) => ({
    id: `${name}-${index}`,
    documentId: `doc-${name}`,
    documentName: name,
    mimeType: 'image/png',
    text,
  }));
}

describe('identityReplacements', () => {
  it('turns the stored identity into literal cover replacements', () => {
    const replacements = identityReplacements('Nama: Farid Rizky Fauzan\nNIM: 124140210\nKelas: RA');
    const asMap = new Map(replacements.map((r) => [r.find, r.replace]));

    expect(asMap.get('[ Tuliskan Nama Lengkap Anda ]')).toBe('Farid Rizky Fauzan');
    expect(asMap.get('[ Tuliskan NIM Anda ]')).toBe('124140210');
    expect(asMap.get('[ RA / RB / RC / RD ]')).toBe('RA');
  });

  it('skips fields the user did not provide instead of writing empty text', () => {
    const replacements = identityReplacements('Nama: Farid Rizky Fauzan');
    expect(replacements).toHaveLength(1);
    expect(replacements[0]!.find).toBe('[ Tuliskan Nama Lengkap Anda ]');
  });

  it('returns nothing when no identity was supplied', () => {
    expect(identityReplacements(null)).toEqual([]);
    expect(identityReplacements('')).toEqual([]);
    // Ordinary guidance is not an identity field.
    expect(identityReplacements('please write in formal Indonesian')).toEqual([]);
  });
});

describe('selectFiguresForSection', () => {
  const evidence = [
    ...imageChunks('1.png', ['Laptop-PT', 'Smartphone-PT', 'Router0', 'Switch0', 'Server-PT', 'PC0', 'PC1']),
    ...imageChunks('2.png', ['R-KABEL>show ip interface brief', 'GigabitEthernet0/0 192.168.10.1 up up']),
    ...imageChunks('5.png', ['DHCP', 'Pool Name', 'Default Gateway', 'Start IP Address']),
    ...imageChunks('8.png', ['R-KABEL>show ip route', 'Codes: L - local, C - connected, S - static']),
    ...imageChunks('12.png', ['C:\\>tracert 192.168.10.10', 'Tracing route to 192.168.10.10']),
    ...imageChunks('16.png', ['R-KABEL>show ip ospf neighbor', 'Neighbor ID Pri State Dead Time']),
  ];

  it('matches a screenshot to the section that discusses it', () => {
    const picked = selectFiguresForSection(evidence, '2.4 Perancangan Layanan DHCP Server');
    expect(picked.map((p) => p.caption)).toContain('Sumber: 5.png');
  });

  it('picks the topology diagram for the topology section', () => {
    const picked = selectFiguresForSection(evidence, '2.1 Desain Arsitektur Topologi Jaringan');
    expect(picked.map((p) => p.caption)).toContain('Sumber: 1.png');
  });

  /**
   * The reported Test 6 export filled ten of eleven reserved boxes and left
   * "[ TEMPELKAN SCREENSHOT: Diagram Topologi … ]" — the first one — empty. OCR of a
   * Packet Tracer canvas is only device labels and interface names, so a rule that
   * required the word "topologi" in the image text never selected it.
   */
  it('claims the diagram from its drawn labels, not from the word "topologi"', () => {
    const canvas = imageChunks('1.png', ['PC-0', 'PC-1', '2911', '2960', 'Gi0/0', 'Fa0/1', 'Server0']);
    const picked = selectFiguresForSection(canvas, '2.1 Desain Arsitektur Topologi Jaringan');
    expect(picked.map((p) => p.caption)).toEqual(['Sumber: 1.png']);
  });

  it('does not mistake a CLI capture for a diagram', () => {
    // A command prompt means a terminal, however many device names it mentions.
    const cli = imageChunks('2.png', ['R-KABEL#show ip interface brief', 'GigabitEthernet0/0 192.168.10.1 up up']);
    const picked = selectFiguresForSection(cli, '2.1 Desain Arsitektur Topologi Jaringan');
    expect(picked).toEqual([]);
  });

  /**
   * The real Test 6 image pool: only 1.png and 13.png are canvases. 15.png is a
   * `C:\> ping` + `C:\> tracert` capture that still names servers and interfaces, so
   * it outscored the real diagram and the topology box was the one left empty.
   */
  const REAL_OCR: Record<string, string[]> = {
    '1.png': [
      'Gi90/0 | 1941 | 1941 | Roytert | ort | Gigd/1 | GI90/1',
      'Fa0v1 | Fa0/1 | Fad | Fa0/2 | 2960p24TT | Fa0\'3 | Server-PT',
      'Fa0/2 | Serverd | Fa0/4 | Fad | Acc | PT | Agtess P dirt0 | PCPT | PCO | PC1',
    ],
    '13.png': [
      '1941 | Router0 | Gi0/0 | Gi0/1 | 2960p24TT | Fa0/1 | Fa0/2 | PC-PT | Server-PT',
      'Router1 | Gi0/0 | AccessPoint-PT | PC0 | PC1 | Laptop0 | Smartphone0',
    ],
    '15.png': [
      'C:\\> ping 192.168.10.10',
      'Pinging 192.168.10.10 with 32 bytes of data',
      'Reply from 192.168.10.10 TTL=128',
      'Minimum = Oms, Maximum = Oms, Average = Oms | C:\\> tracert 192.168.10.10',
      'Tracing route to 192.168.10.10 over a maximum of 30 hops:',
      '1 Ooms ons ons 192.168.10.10 | Trace complete.',
    ],
  };
  const realPool = Object.entries(REAL_OCR).flatMap(([name, lines]) => imageChunks(name, lines));

  it('recognises the real canvases and rejects the real ping capture', () => {
    expect(looksLikeDiagram(REAL_OCR['1.png']!.join('\n'))).toBe(true);
    expect(looksLikeDiagram(REAL_OCR['13.png']!.join('\n'))).toBe(true);
    expect(looksLikeDiagram(REAL_OCR['15.png']!.join('\n'))).toBe(false);
  });

  it('prefers the real canvas over the real ping capture for the topology section', () => {
    const picked = selectFiguresForSection(realPool, '2.1 Desain Arsitektur Topologi Jaringan');
    expect(picked.map((p) => p.caption)).not.toContain('Sumber: 15.png');
    expect(picked.map((p) => p.caption).sort()).toEqual(['Sumber: 1.png', 'Sumber: 13.png']);
  });

  it('does not pull a traceroute capture into an unrelated section', () => {
    const picked = selectFiguresForSection(evidence, '4.1.1 Konsep dan Desain Rute Statis');
    expect(picked.map((p) => p.caption)).not.toContain('Sumber: 12.png');
  });

  it('leaves sections without a matching picture empty', () => {
    expect(selectFiguresForSection(evidence, '6.1 Kesimpulan')).toEqual([]);
    expect(selectFiguresForSection(evidence, '6.2 Saran dan Pengembangan Lanjutan')).toEqual([]);
  });

  it('gives a chapter divider no figure, so it is not printed twice in a row', () => {
    expect(selectFiguresForSection(evidence, 'BAB II: PERANCANGAN TOPOLOGI DAN SKEMA PENGALAMATAN')).toEqual([]);
  });

  it('ignores text documents, which are never embedded as pictures', () => {
    const textOnly = [
      { id: 't1', documentId: 'doc-notes', documentName: 'notes.txt', mimeType: 'text/plain', text: 'DHCP pool' },
    ];
    expect(selectFiguresForSection(textOnly, '2.4 Perancangan Layanan DHCP Server')).toEqual([]);
  });

  it('returns no more than the maximum, even when several images tie', () => {
    const twins = [...imageChunks('7.png', ['show ip route', 'Codes: C - connected']), ...evidence];
    const picked = selectFiguresForSection(twins, '4.1.3 Verifikasi Forwarding Table (show ip route)', 1);
    expect(picked).toHaveLength(1);
  });
});
