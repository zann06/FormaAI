import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement object URLs, which the download helper uses.
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock', writable: true, configurable: true });
}
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true, configurable: true });
}

/**
 * Every test must start from a blank document.
 *
 * Checking *before* each test (rather than silently clearing after) turns a
 * leaked render tree into one clear failure that names the problem, instead of a
 * confusing "Found multiple elements by: ..." in an unrelated test twenty cases
 * later. That is exactly how eleven workspace tests failed on CI while passing in
 * isolation.
 */
beforeEach(() => {
  if (document.body.childElementCount > 0) {
    const leftovers = Array.from(document.body.children)
      .map((node) => node.tagName.toLowerCase() + (node.getAttribute('data-testid') ? `[${node.getAttribute('data-testid')}]` : ''))
      .join(', ');
    // Clear anyway so the following assertions are not also poisoned, but fail
    // loudly: the previous test did not tear down.
    document.body.innerHTML = '';
    throw new Error(
      `A test leaked its render tree into the next one (unexpected elements: ${leftovers}). ` +
        'This means a previous test did not unmount — usually because an assertion threw ' +
        'before teardown or an async update resolved after the test finished.',
    );
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Belt and braces: unmount whatever React Testing Library knows about, then
  // make sure nothing at all survives into the next test.
  document.body.innerHTML = '';
  /**
   * Clear web storage as well.
   *
   * The chat panel persists its transcript to localStorage under the project id,
   * and the workspace tests all use the same project. Whether that is a leak
   * depends on the environment: in this jsdom build `localStorage` is an inert
   * stub, so nothing is ever written, but on CI it is a real Storage — so the
   * first chat test's transcript was restored by the next one and its panel held
   * *two* reasoning trails. Queries like `[data-testid="chat-steps"]` then failed
   * with "Found multiple elements", eleven tests at a time, on CI only.
   *
   * Every test should start from a fresh browser, so reset storage either way.
   */
  try {
    window.localStorage?.clear?.();
    window.sessionStorage?.clear?.();
  } catch {
    // A stub without clear() is already empty; nothing to do.
  }
});
