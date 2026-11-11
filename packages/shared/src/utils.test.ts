import { describe, expect, it } from 'vitest';
import { bm25Rank, chunkText, safeFilename, slugify, tokenize, countWords, formatBytes } from '../src/index.js';

describe('utils', () => {
  it('tokenizes and removes stopwords', () => {
    expect(tokenize('The report about the students was written')).toEqual(['report', 'students', 'written']);
  });

  it('ranks relevant documents first', () => {
    const docs = [
      { item: 'a', text: 'This section is about budget allocation for the event' },
      { item: 'b', text: 'Completely unrelated content regarding maintenance' },
      { item: 'c', text: 'Budget details: total Rp 5.000.000 for the event' },
    ];
    const ranked = bm25Rank('budget event', docs);
    expect(ranked[0]!.item).not.toBe('b');
    expect(ranked[2]!.item).toBe('b');
  });

  it('chunks long text without losing content', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum '.repeat(20)).join('\n\n');
    const chunks = chunkText(text, { maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('Paragraph 19');
  });

  it('sanitises filenames against traversal', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(safeFilename('')).toBe('file');
  });

  it('slugifies unicode', () => {
    expect(slugify('Laporan Praktik Kerja Lapangan — Bab 1')).toBe('laporan-praktik-kerja-lapangan-bab-1');
  });

  it('counts words for cjk and latin', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('你好世界')).toBe(4);
  });

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
