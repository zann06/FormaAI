import { describe, expect, it } from 'vitest';
import { sectionDraftZod } from '../src/services/generation/schemas.js';

/**
 * The reported run ended with section 5.2 empty and `warnings: []`. The model had
 * answered, but the payload carried one extra key and the `.strict()` schema threw
 * the whole draft away — the assistant then gave up instead of using the prose it
 * had already written.
 */
describe('sectionDraftZod', () => {
  it('accepts a real draft that carries harmless extra keys', () => {
    const parsed = sectionDraftZod.safeParse({
      body: 'Berdasarkan hasil pengujian, akar masalahnya adalah konfigurasi DHCP pool yang salah.',
      // Models routinely add these even when the schema does not ask for them.
      title: '5.2 Analisis Penyebab Masalah',
      heading: '5.2 Analisis Penyebab Masalah',
      notes: 'internal reasoning',
      citedChunkIds: ['chunk-1'],
      warnings: [],
      placeholders: [],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toContain('akar masalahnya');
      // Unknown keys are stripped, not persisted into the report.
      expect(parsed.data).not.toHaveProperty('title');
      expect(parsed.data).not.toHaveProperty('heading');
      expect(parsed.data).not.toHaveProperty('notes');
    }
  });

  it('fills the optional arrays so callers never receive undefined', () => {
    const parsed = sectionDraftZod.safeParse({ body: 'Isi seksi yang valid.' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.citedChunkIds).toEqual([]);
      expect(parsed.data.warnings).toEqual([]);
      expect(parsed.data.placeholders).toEqual([]);
    }
  });

  it('still rejects a draft with no body, so an empty answer is not saved as content', () => {
    expect(sectionDraftZod.safeParse({ body: '' }).success).toBe(false);
    expect(sectionDraftZod.safeParse({ body: '   ' }).success).toBe(false);
    expect(sectionDraftZod.safeParse({ title: 'only a title' }).success).toBe(false);
  });
});
