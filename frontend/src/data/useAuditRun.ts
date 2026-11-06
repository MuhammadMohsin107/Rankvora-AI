import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ApiError } from '../lib/api';
import { startAuditRun, waitForAuditRun } from './audits.repository';

/**
 * Starts a REAL audit run and waits for it to finish.
 *
 * Extracted so every control that claims to (re)analyse the store shares one implementation:
 * the sub-pillar "Run an audit" button and the "Re-analyze" button on the dashboards.
 * Before this, that button only re-fetched the audit that was already stored — it re-read the same
 * rows and rendered the same numbers, which is why clicking it appeared to do nothing.
 *
 * ONE RUN, ONE STATE, FOR THE WHOLE APP. The state lives here, outside any component, because an
 * audit belongs to the store and not to the page that started it. That is what lets the processing
 * banner (components/audit/AnalysisBanner.tsx) stay up while the customer moves between pages, and
 * what disables every Re-analyze button at once while a run is going — a second click on any of
 * them is refused here before it reaches the server. Everything the state says is the job's own:
 * its progress and its stage come from polling the audit job, never from a timer.
 *
 * The BACKEND still has the last word on duplicates: it refuses a second concurrent run with
 * `AUDIT_RUN_IN_PROGRESS` (a run started in another tab, say), and that refusal is shown as is.
 */

export type AuditRunState = 'idle' | 'running' | 'error';

export interface AuditRunError {
  message: string;
  /** True when the store has no live Shopify connection — the caller should link to /integrations. */
  needsConnection: boolean;
}

export interface AuditRunSnapshot {
  state: AuditRunState;
  /** 0-100, from the job's own progress field. */
  progress: number;
  /** The job's own description of the step it is on, with the counts read so far. */
  stage: string | null;
  error: AuditRunError | null;
  /** Counts the runs that have finished successfully since the page loaded, so a page can tell that new results exist. */
  completed: number;
}

export interface UseAuditRun {
  state: AuditRunState;
  running: boolean;
  progress: number;
  stage: string | null;
  error: AuditRunError | null;
  /**
   * Runs an audit and awaits it. `onComplete` fires only if THIS call's run succeeded. Does nothing
   * when a run is already going — whoever started it, the one run is the one the customer sees.
   */
  run: (onComplete?: () => void | Promise<void>) => Promise<void>;
  /** Clears a failed run's message. */
  reset: () => void;
}

// ─── The shared state ────────────────────────────────────────────────

let snapshot: AuditRunSnapshot = { state: 'idle', progress: 0, stage: null, error: null, completed: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<AuditRunSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribeAuditRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAuditRunSnapshot(): AuditRunSnapshot {
  return snapshot;
}

/** Clears a failed run's message. A run in progress is not touched. */
export function dismissAuditRunError(): void {
  if (snapshot.state === 'error') set({ state: 'idle', error: null });
}

/**
 * Starts a run unless one is going. Resolves to what happened to THIS call's run: 'succeeded',
 * 'failed', or 'busy' when a run was already going and nothing was started.
 */
async function startAnalysis(): Promise<'succeeded' | 'failed' | 'busy'> {
  // Checked and set in the same tick, before any await, so two clicks in one frame cannot both start.
  if (snapshot.state === 'running') return 'busy';
  set({ state: 'running', progress: 0, stage: null, error: null });

  let job;
  try {
    job = await startAuditRun();
  } catch (err) {
    set({
      state: 'error',
      error: {
        message: err instanceof ApiError ? err.message : 'Could not start the audit. Try again.',
        needsConnection: err instanceof ApiError && err.code === 'STORE_NOT_CONNECTED',
      },
    });
    return 'failed';
  }

  return trackJob(job.id);
}

/** A job the server queued while another was still being followed; followed as soon as that one ends. */
let pendingJobId: number | null = null;

/** Polls one audit job to its end, mirroring its progress into the shared state. */
async function trackJob(jobId: number): Promise<'succeeded' | 'failed'> {
  const outcome = await trackToEnd(jobId);
  const next = pendingJobId;
  pendingJobId = null;
  if (next !== null && next !== jobId) followAuditRun(next);
  return outcome;
}

async function trackToEnd(jobId: number): Promise<'succeeded' | 'failed'> {
  try {
    const finished = await waitForAuditRun(jobId, (update) => {
      set({ progress: update.progress, stage: update.stage ?? null });
    });
    if (finished.status === 'failed') {
      // The job's own error is written by the runner and is already merchant-safe.
      set({ state: 'error', error: { message: finished.error ?? 'The audit failed. Try again.', needsConnection: false } });
      return 'failed';
    }
    set({ state: 'idle', progress: 100, stage: null, completed: snapshot.completed + 1 });
    return 'succeeded';
  } catch {
    // The run itself may well be fine; what failed is asking how it is going.
    set({
      state: 'error',
      error: { message: 'Could not check on the analysis. Reload in a moment.', needsConnection: false },
    });
    return 'failed';
  }
}

/**
 * Follows an audit the SERVER started — the re-audit queued when fixes are saved to the store — as
 * if it had been started here: the banner shows its progress, Re-analyze stays disabled, and every
 * page showing results reloads when it finishes. While another run is being followed, this one is
 * followed straight after it.
 */
export function followAuditRun(jobId: number): void {
  if (snapshot.state === 'running') {
    // Not dropped: the run being followed may already be over on the server, with only the next
    // poll still to notice. The newer job is picked up the moment this one is done.
    pendingJobId = jobId;
    return;
  }
  set({ state: 'running', progress: 0, stage: null, error: null });
  void trackJob(jobId);
}

// ─── Hooks ───────────────────────────────────────────────────────────

export function useAuditRun(): UseAuditRun {
  const current = useSyncExternalStore(subscribeAuditRun, getAuditRunSnapshot);

  const run = useCallback(async (onComplete?: () => void | Promise<void>) => {
    if ((await startAnalysis()) === 'succeeded') await onComplete?.();
  }, []);

  return {
    state: current.state,
    running: current.state === 'running',
    progress: current.progress,
    stage: current.stage,
    error: current.error,
    run,
    reset: dismissAuditRunError,
  };
}

/**
 * Calls `callback` each time an analysis finishes successfully while this component is on screen —
 * whichever page started it. A page that shows audit results uses it to load the new ones, so it
 * is never left showing the previous audit beside an idle Re-analyze button.
 */
export function useAuditCompletion(callback: () => void | Promise<void>): void {
  const completed = useSyncExternalStore(subscribeAuditRun, () => getAuditRunSnapshot().completed);
  const seen = useRef(completed);
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (completed === seen.current) return;
    seen.current = completed;
    void latest.current();
  }, [completed]);
}
