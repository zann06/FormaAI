/**
 * Installs a working `window.localStorage` for tests.
 *
 * jsdom only provides a real Storage when it can compute a non-opaque origin; in
 * this project it hands back an inert object, so persistence code paths silently
 * do nothing and environment-specific bugs stay invisible. CI showed the opposite
 * behaviour, which is how a test-isolation leak reached production-shaped code
 * without ever failing locally.
 *
 * Tests that assert on persistence install this fixture so the behaviour is the
 * same on every machine and in CI.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

export function createChatStorage(): Storage {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
  return storage;
}
