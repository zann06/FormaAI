import { describe, expect, it } from 'vitest';
import { buildTopicPool, rankEvidence, type EvidenceChunk } from '../src/services/mapping/retrieval.js';

/**
 * Retrieval decides whether a section has anything to write from. Real templates
 * use structural headings ("BAB I PENDAHULUAN", "1.1 Latar Belakang") whose words
 * appear nowhere in a case document, which used to score 0 and leave the section
 * empty even when the sources were full of relevant material. These tests pin the
 * keyword path *and* the topical fallback that replaced the silent gap.
 */

function chunk(id: string, text: string, ordinal: number, documentId = 'doc-1'): EvidenceChunk {
  return {
    id,
    documentId,
    documentName: `${documentId}.txt`,
    text,
    page: null,
    paragraphIndex: ordinal,
    headingPath: null,
    ordinal,
  };
}

const caseChunks: EvidenceChunk[] = [
  chunk(
    'c1',
    'KASUS 1: Analisis jaringan LAN di laboratorium komputer. Laboratorium memiliki 40 workstation yang terhubung ke switch utama. Topologi yang digunakan adalah star dengan satu switch backbone.',
    0,
  ),
  chunk(
    'c2',
    'Masalah yang ditemukan: broadcast storm akibat loop pada dua port switch. Solusi: mengaktifkan Spanning Tree Protocol pada kedua switch. Hasil pengujian: latensi turun dari 120 ms menjadi 12 ms.',
    1,
  ),
  chunk(
    'c3',
    'Kesimpulan: penerapan STP berhasil menghilangkan loop dan menstabilkan jaringan laboratorium.',
    2,
    'doc-2',
  ),
];

describe('rankEvidence', () => {
  it('matches a section whose heading shares words with the sources', () => {
    const ranked = rankEvidence({ heading: '3.1 Kesimpulan' }, caseChunks);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.chunk.id).toBe('c3');
  });

  it('returns nothing for a structural heading when no fallback pool is given', () => {
    // The old behaviour, kept explicit: without a pool there is genuinely no
    // overlap, and pretending otherwise would be fabrication.
    expect(rankEvidence({ heading: 'BAB I PENDAHULUAN' }, caseChunks)).toEqual([]);
  });

  it('falls back to the most on-topic chunks when the heading has no overlap', () => {
    const pool = buildTopicPool(caseChunks);
    const ranked = rankEvidence({ heading: 'BAB I PENDAHULUAN' }, caseChunks, {
      fallback: pool,
      fallbackK: 2,
    });
    expect(ranked.length).toBe(2);
    // Real evidence, not an empty section: the source text is what gets drafted.
    expect(ranked.every((entry) => entry.chunk.text.length > 20)).toBe(true);
    // Scores stay at the fallback floor so the UI can flag it as topical.
    expect(ranked.every((entry) => entry.score <= 0.01)).toBe(true);
  });

  it('prefers a keyword match over the fallback', () => {
    const pool = buildTopicPool(caseChunks);
    const ranked = rankEvidence({ heading: 'Kesimpulan' }, caseChunks, { fallback: pool, fallbackK: 2 });
    expect(ranked[0]!.chunk.id).toBe('c3');
    expect(ranked[0]!.score).toBeGreaterThan(0.01);
  });

  it('still returns nothing when there is no evidence at all', () => {
    expect(rankEvidence({ heading: 'BAB I PENDAHULUAN' }, [], { fallback: buildTopicPool([]) })).toEqual([]);
  });

  it('finds the evidence that answers a heading even when it shares no words', () => {
    // The real failure: the heading says "Subnetting VLSM", the answering screenshot
    // says "Pool Name / Default Gateway / Start IP Address". BM25 scored it 0.000, so
    // the section was drafted from unrelated ping screenshots.
    const noisy: EvidenceChunk[] = [];
    for (let i = 0; i < 20; i += 1) {
      noisy.push(chunk(`noisy-${i}`, `ping reply bytes ttl baris ${i}`, i, 'screenshot-ping'));
    }
    noisy.push(
      chunk('pool', 'Pool Name serverPool Default Gateway 192.168.10.1 Start IP Address 192.168.10.10', 0, 'dhcp-table'),
    );

    const ranked = rankEvidence({ heading: '2.2 Desain Subnetting Berbasis VLSM' }, noisy, { topK: 4 });
    expect(ranked.map((entry) => entry.chunk.documentId)).toContain('dhcp-table');
  });

  it('keeps the most relevant chunk of each document first', () => {
    const uneven: EvidenceChunk[] = [
      chunk('a1', 'routing ospf neighbor tabel', 0, 'doc-a'),
      chunk('a2', 'routing ospf neighbor detail', 1, 'doc-a'),
      chunk('a3', 'routing ospf neighbor lanjutan', 2, 'doc-a'),
      chunk('b1', 'routing ospf neighbor', 0, 'doc-b'),
    ];
    const ranked = rankEvidence({ heading: 'routing ospf neighbor' }, uneven, { topK: 2 });
    expect(new Set(ranked.map((entry) => entry.chunk.documentId))).toEqual(new Set(['doc-a', 'doc-b']));
  });
});

describe('buildTopicPool', () => {
  it('takes the opening chunks of each source document', () => {
    const many: EvidenceChunk[] = [
      chunk('a1', 'opening of doc a', 0, 'a'),
      chunk('a2', 'second of doc a', 1, 'a'),
      chunk('a3', 'third of doc a', 2, 'a'),
      chunk('a4', 'fourth of doc a', 3, 'a'),
      chunk('b1', 'opening of doc b', 0, 'b'),
    ];
    const pool = buildTopicPool(many);
    // Never more than three chunks per document, so the pool stays small.
    expect(pool.filter((entry) => entry.documentId === 'a').length).toBeLessThanOrEqual(3);
    expect(pool.some((entry) => entry.documentId === 'b')).toBe(true);
  });

  it('is deterministic regardless of input order', () => {
    const forward = buildTopicPool(caseChunks).map((entry) => entry.id);
    const reversed = buildTopicPool([...caseChunks].reverse()).map((entry) => entry.id);
    expect(reversed).toEqual(forward);
  });
});
