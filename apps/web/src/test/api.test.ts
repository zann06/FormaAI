import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';

/**
 * Regression tests for the JSON request builder.
 *
 * Fastify rejects a request that declares `content-type: application/json` but
 * sends no body with "Body cannot be empty when content-type is set to
 * 'application/json'". The client used to always send that header, so every
 * bodyless POST/DELETE (delete provider, sign out, archive, re-extract, ...)
 * failed with that confusing error.
 */
function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api request builder', () => {
  it('sends no JSON content-type and no body for a bodyless POST', async () => {
    const { calls } = captureFetch();
    await api.post('/api/auth/signout');

    expect(calls).toHaveLength(1);
    const { init } = calls[0]!;
    expect(init.body).toBeUndefined();
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('sends no JSON content-type for a bodyless DELETE', async () => {
    const { calls } = captureFetch();
    await api.del('/api/provider-credentials/abc');

    const { init } = calls[0]!;
    expect(init.body).toBeUndefined();
    expect(((init.headers ?? {}) as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('still sends JSON content-type and a body when a body is provided', async () => {
    const { calls } = captureFetch();
    await api.post('/api/projects', { title: 'Report' });

    const { init } = calls[0]!;
    expect(init.body).toBe(JSON.stringify({ title: 'Report' }));
    expect(((init.headers ?? {}) as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('keeps sending a JSON body for PATCH with a payload', async () => {
    const { calls } = captureFetch();
    await api.patch('/api/auth/password', { currentPassword: 'a', newPassword: 'b' });

    const { init } = calls[0]!;
    expect(init.method).toBe('PATCH');
    expect(typeof init.body).toBe('string');
    expect(((init.headers ?? {}) as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('always sends credentials same-origin so session cookies are included', async () => {
    const { calls } = captureFetch();
    await api.post('/api/auth/signout');
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });
});
