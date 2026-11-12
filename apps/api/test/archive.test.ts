import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { expandArchive } from '../src/lib/archive.js';
import { validateUpload } from '../src/lib/upload-validation.js';

/**
 * A ZIP is how a student actually receives a case packet, so the archive has to
 * become real sources. These tests cover the happy path, the parts that must be
 * refused, and the guard rails that stop a zip bomb.
 */

const MAX = 25 * 1024 * 1024;

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

describe('archive uploads', () => {
  it('accepts a real zip as a source', () => {
    const bytes = makeZip({ 'kasus/readme.txt': 'hello' });
    const result = validateUpload('Dokumen Kasus.zip', 'application/zip', bytes, { kind: 'source', maxBytes: MAX });
    expect(result.extension).toBe('.zip');
    expect(result.mimeType).toBe('application/zip');
  });

  it('rejects a file that claims to be a zip but is not', () => {
    const notZip = strToU8('%PDF-1.4 definitely not an archive');
    expect(() =>
      validateUpload('fake.zip', 'application/zip', notZip, { kind: 'source', maxBytes: MAX }),
    ).toThrow(/not a valid ZIP/i);
  });
});

describe('archive expansion', () => {
  it('extracts supported files and preserves their names', async () => {
    const zip = makeZip({
      'kasus/laporan.txt': 'isi laporan',
      'kasus/nota.txt': 'isi nota',
    });
    const expansion = await expandArchive(zip);
    expect(expansion.entries.map((entry) => entry.name).sort()).toEqual(['laporan.txt', 'nota.txt']);
    const laporan = expansion.entries.find((entry) => entry.name === 'laporan.txt');
    expect(new TextDecoder().decode(laporan!.bytes)).toBe('isi laporan');
  });

  it('skips unsupported files with a reason instead of failing the whole archive', async () => {
    const zip = makeZip({
      'kasus/bukti.txt': 'valid evidence',
      'kasus/skrip.exe': 'MZ binary',
      'kasus/data.xlsx': 'not supported yet',
    });
    const expansion = await expandArchive(zip);
    expect(expansion.entries).toHaveLength(1);
    expect(expansion.entries[0]!.name).toBe('bukti.txt');
    expect(expansion.skipped).toHaveLength(2);
    expect(expansion.skipped.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['kasus/skrip.exe', 'kasus/data.xlsx']),
    );
    expect(expansion.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('ignores macOS metadata and directory entries', async () => {
    const zip = makeZip({
      '__MACOSX/kasus/._bukti.txt': 'junk',
      'kasus/.DS_Store': 'junk',
      'kasus/bukti.txt': 'real',
    });
    const expansion = await expandArchive(zip);
    expect(expansion.entries.map((entry) => entry.name)).toEqual(['bukti.txt']);
  });

  it('refuses an archive with no usable files and says what was found', async () => {
    const zip = makeZip({ 'kasus/skrip.exe': 'MZ', 'kasus/setup.msi': 'MZ' });
    await expect(expandArchive(zip)).rejects.toThrow(/No usable files.*skrip\.exe/s);
  });

  it('refuses an empty archive', async () => {
    const zip = zipSync({});
    await expect(expandArchive(zip)).rejects.toThrow(/empty/i);
  });

  it('stops at the entry limit rather than queuing hundreds of documents', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) files[`kasus/f${index}.txt`] = `content ${index}`;
    const expansion = await expandArchive(makeZip(files), { maxEntries: 5 });
    expect(expansion.entries).toHaveLength(5);
    expect(expansion.skipped.some((entry) => /more than 5 files/.test(entry.reason))).toBe(true);
  });

  it('rejects an archive that expands past the allowed ratio (zip bomb)', async () => {
    // Highly compressible content: 2 MB of zeros compresses to a few KB.
    const bomb = zipSync({ 'kasus/huge.txt': new Uint8Array(2 * 1024 * 1024) });
    await expect(expandArchive(bomb, { maxExpansionRatio: 2 })).rejects.toThrow(/zip bomb|expands to far more/i);
  });

  it('rejects a single entry larger than the per-file limit', async () => {
    const zip = makeZip({ 'kasus/big.txt': 'x'.repeat(2048) });
    await expect(expandArchive(zip, { maxEntryBytes: 1024 })).rejects.toThrow(/per-file limit/i);
  });

  it('rejects corrupt archive bytes with a readable message', async () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
    await expect(expandArchive(corrupt)).rejects.toThrow(/ZIP archive could not be read|empty/i);
  });

  it('nests archives out of the expansion (a zip inside a zip is not evidence)', async () => {
    const inner = makeZip({ 'a.txt': 'inner' });
    const outer = zipSync({ 'kasus/inner.zip': inner, 'kasus/real.txt': strToU8('real') });
    const expansion = await expandArchive(outer);
    expect(expansion.entries.map((entry) => entry.name)).toEqual(['real.txt']);
    expect(expansion.skipped.some((entry) => entry.path.endsWith('inner.zip'))).toBe(true);
  });
});
