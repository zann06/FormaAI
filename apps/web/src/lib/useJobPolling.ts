import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * Polls the project's job list while any job is active.
 *
 * The API is the source of truth for job state; this hook only decides *when*
 * to ask again. It backs off while idle and stops entirely when nothing is
 * queued or running, so a quiet workspace makes no requests.
 */
export interface JobLike {
  id: string;
  /** Job kind, e.g. `map_evidence` or `generate_section`. */
  kind?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  finishedAt?: string | null;
  result?: Record<string, unknown>;
}

export function useJobPolling(projectId: string | undefined, onJobs: (jobs: JobLike[]) => void, enabled: boolean) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  // A monotonically increasing run id, not a boolean. A boolean was reset to
  // false by the *next* mount, so a request issued by a previous mount that
  // resolved late would see `stopped === false`, deliver its stale job list to
  // the new component and schedule another timer. In tests that leaked a second
  // assistant reply into the following test's DOM; in the app it could apply one
  // project's job state to another after a fast project switch.
  const runId = useRef(0);
  const onJobsRef = useRef(onJobs);
  onJobsRef.current = onJobs;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const tick = useCallback(
    async (forRun: number) => {
      if (!projectId || runId.current !== forRun) return;
      try {
        const { jobs } = await api.get<{ jobs: JobLike[] }>(`/api/projects/${projectId}/jobs`);
        if (runId.current !== forRun) return;
        onJobsRef.current(jobs);
        const busy = jobs.some((job) => job.status === 'queued' || job.status === 'running');
        setActive(busy);
        // Poll quickly while busy, slowly when idle (to catch jobs started in
        // another tab), and never spin.
        timer.current = window.setTimeout(() => void tick(forRun), busy ? 1200 : 5000);
      } catch {
        if (runId.current !== forRun) return;
        // Transient polling failure: try again shortly without surfacing noise.
        timer.current = window.setTimeout(() => void tick(forRun), 3000);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!enabled || !projectId) return;
    runId.current += 1;
    const myRun = runId.current;
    void tick(myRun);
    return () => {
      // Invalidate this run so any in-flight response is ignored, and stop the timer.
      if (runId.current === myRun) runId.current += 1;
      clear();
    };
  }, [enabled, projectId, tick, clear]);

  /** Immediately re-polls (used after the user starts a job). */
  const refresh = useCallback(() => {
    clear();
    void tick(runId.current);
  }, [clear, tick]);

  return { active, refresh };
}
