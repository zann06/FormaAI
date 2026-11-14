import type { StorageAdapter } from './index.js';

/**
 * Process-wide storage handle.
 *
 * Services that need storage outside of a request scope (background worker) use
 * this registry. It is initialised once at boot with the configured adapter, so
 * there is exactly one storage backend per process.
 */
class StorageRegistry {
  private adapter: StorageAdapter | null = null;

  set(adapter: StorageAdapter): void {
    this.adapter = adapter;
  }

  get(): StorageAdapter {
    if (!this.adapter) throw new Error('Storage adapter has not been initialised');
    return this.adapter;
  }

  isInitialised(): boolean {
    return this.adapter !== null;
  }
}

export const storageRegistry = new StorageRegistry();
