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
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

export function useJobPolling(projectId: string | undefined, onJobs: (jobs: JobLike[]) => void, enabled: boolean) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  const stopped = useRef(false);
  const onJobsRef = useRef(onJobs);
  onJobsRef.current = onJobs;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const tick = useCallback(async () => {
    if (!projectId || stopped.current) return;
    try {
      const { jobs } = await api.get<{ jobs: JobLike[] }>(`/api/projects/${projectId}/jobs`);
      if (stopped.current) return;
      onJobsRef.current(jobs);
      const busy = jobs.some((job) => job.status === 'queued' || job.status === 'running');
      setActive(busy);
      // Poll quickly while busy, slowly when idle (to catch jobs started in
      // another tab), and never spin.
      timer.current = window.setTimeout(() => void tick(), busy ? 1200 : 5000);
    } catch {
      // Transient polling failure: try again shortly without surfacing noise.
      timer.current = window.setTimeout(() => void tick(), 3000);
    }
  }, [projectId]);

  useEffect(() => {
    stopped.current = false;
    if (!enabled || !projectId) return;
    void tick();
    return () => {
      stopped.current = true;
      clear();
    };
  }, [enabled, projectId, tick, clear]);

  /** Immediately re-polls (used after the user starts a job). */
  const refresh = useCallback(() => {
    clear();
    void tick();
  }, [clear, tick]);

  return { active, refresh };
}
