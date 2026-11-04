import { api } from '../lib/api';
import type { JobRow } from './api.types';

const POLL_INTERVAL_MS = 2000;

/**
 * Queues an audit run for the active store. The backend responds 202 with the job — the run
 * itself happens asynchronously, so callers pair this with `waitForAuditRun`.
 *
 * Throws `ApiError` with code `STORE_NOT_CONNECTED` when the store has no live Shopify
 * connection, or `AUDIT_RUN_IN_PROGRESS` when a run is already queued or running.
 */
export function startAuditRun(): Promise<JobRow> {
  return api.post<JobRow>('/audits/run');
}

export function fetchJob(id: number): Promise<JobRow> {
  return api.get<JobRow>(`/jobs/${id}`);
}

/**
 * Polls a job until it reaches a terminal state. Resolves with the finished job rather than
 * throwing on 'failed', so the caller can surface the job's own error message.
 */
export async function waitForAuditRun(
  jobId: number,
  onProgress?: (job: JobRow) => void,
): Promise<JobRow> {
  for (;;) {
    const job = await fetchJob(jobId);
    onProgress?.(job);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
