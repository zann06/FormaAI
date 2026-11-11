/**
 * Minimal fetch mock that routes on (method, path) and records every call, so
 * tests assert on the real request shapes the UI sends.
 */
import { vi } from 'vitest';

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (init: { body: unknown }) => { status?: number; json?: unknown } | undefined;

export function installFetchMock(routes: Record<string, Handler>) {
  const calls: MockCall[] = [];

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      body = init.body;
    }
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${key}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const result = handler({ body });
    if (!result) return new Response('', { status: 204 });
    return new Response(JSON.stringify(result.json ?? null), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}
