import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { insertReturning, updateReturning } from '../db/returning.js';
import { jobs } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { runAuditJob } from '../audit-engine/runner.js';
import { hasStoreDataSource } from '../audit-engine/store-data/index.js';
import { describeError, describeErrorWithStack } from '../lib/logger.js';

/**
 * ─── How an audit run is started ─────────────────────────────────────
 *
 * Once the job row exists, something has to actually run the audit. Two runtimes, two answers:
 *
 *   Node (server.ts)          In this process, fire-and-forget — what the API has always done.
 *   Cloudflare (worker.ts)    A Cloudflare Workflow. A Worker lives only as long as the request,
 *                             so work left running after the response would be cut off; the
 *                             Workflow is Cloudflare's own long-running job that outlives it.
 *
 * worker.ts swaps the starter in with useAuditRunStarter(); Node never calls it, so its behaviour is
 * unchanged. Either way runAuditJob owns the job's lifecycle once it starts — progress, results and
 * the terminal status.
 */
export type AuditRunStarter = (job: { id: number; storeId: number }) => Promise<void>;

const runInThisProcess: AuditRunStarter = async (job) => {
  // Fire-and-forget: the HTTP response returns immediately with the job id for polling.
  // runAuditJob owns the job's full lifecycle (including writing 'failed' on any error), so
  // this .catch is only a last-resort safety net against a rejection before its own try/catch runs.
  // The ids are what make this line findable: without them it named no job and no store, and the
  // job row it describes could not be located from the log.
  void runAuditJob(job.id).catch((error) => {
    console.error(`[scorelo-api] audit job ${job.id} (store ${job.storeId}) crashed before entering its own error handling — ${describeErrorWithStack(error)}`);
  });
};

let startAuditRun: AuditRunStarter = runInThisProcess;

/** Replaces how runs are started. Called by worker.ts; Node keeps the in-process default. */
export function useAuditRunStarter(starter: AuditRunStarter): void {
  startAuditRun = starter;
}

/**
 * Starts the run for a job that was just created, or closes the job out if it cannot be started.
 *
 * In-process starting cannot fail, but asking Cloudflare for a Workflow can. Without this, the job
 * would stay `queued` for good — and the "one active job per store" index would then refuse every
 * later run for that store with 409. So the row is marked failed, the reason is logged, and the
 * caller gets an error it can show.
 */
export async function launchAuditRun(job: { id: number; storeId: number }): Promise<void> {
  try {
    await startAuditRun(job);
  } catch (error) {
    console.error(`[scorelo-api] audit job ${job.id} (store ${job.storeId}) could not be started — ${describeErrorWithStack(error)}`);
    await db
      .update(jobs)
      .set({ status: 'failed', error: `The analysis could not be started: ${describeError(error)}`, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    throw new ApiError(503, 'The analysis could not be started. Please try again in a moment.', 'AUDIT_RUN_START_FAILED');
  }
}

export async function createAuditJob(userId: number, storeId?: number) {
  // getCurrentStoreId scopes to stores this user owns, so a customer can never trigger
  // an audit against another customer's store by passing an arbitrary storeId.
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  // Reject up-front rather than queueing a job that would inevitably fail in the worker.
  if (!(await hasStoreDataSource(resolvedStoreId))) {
    throw new ApiError(400, 'Connect a Shopify store before running an audit', 'STORE_NOT_CONNECTED');
  }

  // The upfront SELECT is just a fast-path for the common case (nicer error before doing any
  // insert work) — it is NOT what prevents the race. `jobs_store_active_unique_idx` (a partial
  // unique index in schema.ts) is what actually makes "at most one active job per store" atomic;
  // the catch below turns its violation into the same clean 409 for the concurrent case.
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.storeId, resolvedStoreId), inArray(jobs.status, ['queued', 'running'])))
    .limit(1);
  if (existing) throw new ApiError(409, 'An audit run is already in progress for this store', 'AUDIT_RUN_IN_PROGRESS');

  let job;
  try {
    job = await insertReturning(jobs, { storeId: resolvedStoreId, type: 'audit_run' });
  } catch (error) {
    // A UNIQUE violation here means jobs_store_active_unique_idx rejected a second active job for
    // this store — the race two concurrent requests can both pass the check above in.
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'An audit run is already in progress for this store', 'AUDIT_RUN_IN_PROGRESS');
    }
    throw error;
  }
  if (!job) throw new ApiError(500, 'Unable to start audit run', 'AUDIT_RUN_CREATE_FAILED');

  await launchAuditRun({ id: job.id, storeId: resolvedStoreId });

  return job;
}

/**
 * Closes out audit jobs a previous process left behind as queued or running.
 *
 * Jobs run INSIDE the API process (createAuditJob above), so when that process stops — a deploy,
 * a pm2 restart, a crash — every job it was running stops with it, but its row still says
 * 'running'. `jobs_store_active_unique_idx` then refuses every later run for that store with 409
 * AUDIT_RUN_IN_PROGRESS, scheduled ones included, and the store's dashboard keeps showing its last
 * audit for good while the Refresh button reports a run that is not happening.
 *
 * Called once at startup, before this process has started any job of its own, so every active row
 * at that moment belongs to a process that no longer exists. That holds while the API runs as ONE
 * process (deploy.sh starts a single pm2 fork); a multi-process deployment would need a per-process
 * owner on the job instead. Nothing was persisted for these runs — runner.ts writes the audit only
 * on success — so the previous audit remains the store's latest, and the message says so.
 */
export async function failInterruptedJobs(): Promise<number> {
  // One statement that finds and closes them, not a read followed by an update naming every id:
  // after an outage there can be more than D1's 100 bound values' worth, and a job that finished
  // between the two steps would have been overwritten.
  const interrupted = await updateReturning(
    jobs,
    {
      status: 'failed',
      error: 'The analysis was interrupted because the Rankvora AI server restarted. Nothing from it was saved, so your previous results still stand — run the analysis again.',
      finishedAt: new Date(),
    },
    inArray(jobs.status, ['queued', 'running']),
  );
  return interrupted.length;
}

/**
 * Closes out audit jobs that can no longer be alive — the Cloudflare counterpart of
 * failInterruptedJobs(), run by the scheduled sweep rather than at start-up.
 *
 * A Workflow that dies without reaching runAuditJob's own error handling (out of memory, say), or
 * that never started at all, leaves its row 'running' or 'queued'. Left alone, that row would block
 * every later run for the store with 409. Two cut-offs, because the two states mean different things:
 *
 *   running   longer than STUCK_JOB_RUNNING_MS (90 min) — past the Workflow step's one-hour timeout
 *   queued    longer than STUCK_JOB_QUEUED_MS (15 min)  — a Workflow picks a job up in seconds
 *
 * The update re-checks the status, so a job that finished between the read and the write keeps its
 * real result. Nothing was persisted for these runs (runner.ts saves only on success), so the
 * previous audit stays the store's latest, and the message says so.
 */
export async function failStuckJobs(now: Date = new Date()): Promise<number> {
  const runningBefore = new Date(now.getTime() - env.stuckJobRunningMs);
  const queuedBefore = new Date(now.getTime() - env.stuckJobQueuedMs);

  // One statement that finds and closes them. It re-checks the status in the same breath, so a job
  // that finishes mid-sweep keeps its real result, and it names no ids, so how many are stuck can
  // never run into D1's 100-bound-values limit.
  const stuck = await updateReturning(
    jobs,
    {
      status: 'failed',
      error: 'The analysis stopped before it finished and was closed out. Nothing from it was saved, so your previous results still stand — run the analysis again.',
      finishedAt: now,
    },
    and(
      inArray(jobs.status, ['queued', 'running']),
      or(
        and(eq(jobs.status, 'running'), lt(jobs.startedAt, runningBefore)),
        and(eq(jobs.status, 'queued'), lt(jobs.createdAt, queuedBefore)),
      ),
    ),
  );
  return stuck.length;
}

export async function getJob(userId: number, id: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.storeId, resolvedStoreId))).limit(1);
  if (!job) throw new ApiError(404, 'Job not found', 'JOB_NOT_FOUND');
  return job;
}
