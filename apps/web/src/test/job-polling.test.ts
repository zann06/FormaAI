/**
 * Regression cover for a stale-polling leak.
 *
 * `useJobPolling` used a boolean `stopped` ref to ignore responses after unmount.
 * The next mount reset that boolean to false, so a request issued by a previous
 * mount that resolved late was treated as current: it delivered the old project's
 * job list to the new component and scheduled another timer. On CI that leaked a
 * second assistant reply into the following test, and 11 workspace tests failed
 * with `Found multiple elements by: [data-testid="chat-steps"]`.
 *
 * The hook now compares a run id, so a response is only applied by the mount that
 * asked for it. These tests drive that directly rather than relying on timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useJobPolling } from '../lib/useJobPolling';

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return {
    promise,
    respond: (jobs: Array<{ id: string; status: string }>) =>
      resolve(
        new Response(JSON.stringify({ jobs }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useJobPolling', () => {
  it('ignores a response that arrives after the hook unmounted', async () => {
    const pending = deferredResponse();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onJobs = vi.fn();
    const { unmount } = renderHook(() => useJobPolling('project-a', onJobs, true));

    // Let the first request start, then unmount before it resolves — this is the
    // window CI widened enough to interleave two tests.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();

    pending.respond([{ id: 'stale', status: 'succeeded' }]);
    await new Promise((r) => setTimeout(r, 10));

    expect(onJobs).not.toHaveBeenCalled();
  });

  it('does not let a superseded mount deliver jobs to the next one', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    // Route by URL: the two hook instances poll different projects, so call order
    // is irrelevant and the stale response can be resolved last on purpose.
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('project-a') ? first.promise : second.promise,
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onJobsA = vi.fn();
    const a = renderHook(() => useJobPolling('project-a', onJobsA, true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Switch projects: a new run starts while the first request is still pending.
    a.unmount();
    const onJobsB = vi.fn();
    renderHook(() => useJobPolling('project-b', onJobsB, true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The stale response resolves last. It must be discarded; only B's own data
    // may reach B's callback.
    first.respond([{ id: 'from-a', status: 'succeeded' }]);
    second.respond([{ id: 'from-b', status: 'succeeded' }]);
    await new Promise((r) => setTimeout(r, 10));

    expect(onJobsB).toHaveBeenCalled();
    const deliveredIds = onJobsB.mock.calls.flatMap((c) =>
      (c[0] as Array<{ id: string }>).map((j) => j.id),
    );
    expect(deliveredIds).not.toContain('from-a');
    expect(deliveredIds).toContain('from-b');
    // A's callback must never have been reached after it unmounted.
    expect(onJobsA).not.toHaveBeenCalled();
  });
});
