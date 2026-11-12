import { describe, expect, it } from 'vitest';
import { describeDraftFailures } from '../src/services/worker/pipeline.js';

/**
 * Taken from a real run: 38 sections "could not be drafted" and the UI said only
 * that. Every one of them had the same cause — the daily AI request quota — and
 * that reason was stored on each failed result and then discarded when the
 * summary was built, leaving the user with nothing to act on.
 */
describe('describeDraftFailures', () => {
  it('states the shared cause once instead of once per section', () => {
    const results = Array.from({ length: 38 }, () => ({
      ok: false,
      error: 'Daily AI request quota reached (500).',
    }));
    const note = describeDraftFailures(results);
    expect(note).toContain('38 × Daily AI request quota reached (500)');
    // A trailing full stop is not doubled.
    expect(note).not.toContain('(500)..');
    expect(note.match(/quota/g)).toHaveLength(1);
  });

  it('reports each distinct cause with its own count', () => {
    const note = describeDraftFailures([
      { ok: false, error: 'Daily AI request quota reached (500).' },
      { ok: false, error: 'Daily AI request quota reached (500).' },
      { ok: false, error: 'The model did not return a valid section payload.' },
    ]);
    expect(note).toContain('2 × Daily AI request quota reached (500)');
    expect(note).toContain('1 × The model did not return a valid section payload');
  });

  it('says nothing when every section succeeded', () => {
    expect(describeDraftFailures([{ ok: true }, { ok: true }])).toBe('');
    expect(describeDraftFailures([])).toBe('');
  });

  it('still explains a failure whose message was empty', () => {
    expect(describeDraftFailures([{ ok: false }])).toBe(' Reason: 1 × unknown error.');
  });

  it('reads as a sentence that can follow a failure count', () => {
    const note = describeDraftFailures([{ ok: false, error: 'Provider rejected the key.' }]);
    expect(`38 could not be drafted.${note}`).toBe('38 could not be drafted. Reason: 1 × Provider rejected the key.');
  });
});
