import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement object URLs, which the download helper uses.
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock', writable: true, configurable: true });
}
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  /**
   * Belt and braces around `cleanup()`.
   *
   * `cleanup()` unmounts the trees React Testing Library knows about, but if a
   * test fails or times out before its own teardown runs, an earlier tree can
   * still be attached. The visible symptom on CI was queries matching more than
   * one element ("Found multiple elements by: [data-testid=...]") in tests that
   * pass in isolation, which is both confusing and order-dependent.
   *
   * Emptying the body guarantees each test starts from a blank document whatever
   * happened before it, so one flaky test cannot cascade into its neighbours.
   */
  document.body.innerHTML = '';
});
