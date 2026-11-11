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
});
