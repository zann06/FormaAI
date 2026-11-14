/**
 * Regression cover for the CI-only chat-trail failure.
 *
 * The chat panel persists its transcript to localStorage keyed by project id, and
 * every workspace test uses the same project. In this jsdom build localStorage is
 * an inert stub, so the tests never saw the effect locally — but on CI it is a
 * real Storage, so a later test restored an earlier test's transcript and its
 * panel contained two reasoning trails. Eleven tests failed with
 * "Found multiple elements by: [data-testid=\"chat-steps\"]", on CI only.
 *
 * These tests install a *working* Storage so the behaviour is reproduced
 * deterministically on any machine, instead of depending on which environment
 * happens to implement localStorage.
 *
 * The storage is installed once, at module load, NOT in a beforeEach: replacing it
 * per test would give every test a brand new empty store and hide the leak the
 * harness is supposed to prevent.
 */
import { describe, expect, it } from 'vitest';
import { createChatStorage } from './chatStorageFixture';

createChatStorage();
window.localStorage.clear();

const KEY = 'formaai:chat:p1';

describe('chat transcript storage', () => {
  it('persists a transcript under the project key', () => {
    const transcript = [{ id: 'm1', role: 'assistant', text: 'Stored reply' }];
    window.localStorage.setItem(KEY, JSON.stringify(transcript));
    expect(JSON.parse(window.localStorage.getItem(KEY) as string)).toEqual(transcript);
  });

  it('starts the next test from empty storage', () => {
    // This is the assertion that failed on CI: the previous test's transcript must
    // not be visible here, or the chat panel restores it and renders a second trail.
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});
