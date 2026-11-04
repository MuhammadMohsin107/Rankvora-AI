// ─── Starting an audit run (npm test) ────────────────────────────────
// services/job.service.ts hands a new job to whatever starts runs: this process on Node, a Cloudflare
// Workflow on Workers. These tests swap in recording starters and use the in-memory database the
// helper builds from the real D1 migration. No Cloudflare, no Shopify; the rows are the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import './helpers/database.js';
import { db } from '../db/client.js';
import { jobs, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { launchAuditRun, useAuditRunStarter } from '../services/job.service.js';

/** A user, a store and one queued job — what createAuditJob leaves behind before it starts the run. */
async function queuedJob() {
  const [user] = await db.insert(users).values({ fullName: 'T', email: `t${Date.now()}${Math.random()}@example.com` }).returning();
  const [store] = await db.insert(stores).values({
    ownerId: user!.id, workspaceName: 'W', name: 'S', url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  }).returning();
  const [job] = await db.insert(jobs).values({ storeId: store!.id }).returning();
  return { storeId: store!.id, jobId: job!.id };
}

describe('launchAuditRun', () => {
  it('hands the job to the current starter and leaves the row as it was', async () => {
    const { storeId, jobId } = await queuedJob();
    const started: Array<{ id: number; storeId: number }> = [];
    useAuditRunStarter(async (job) => {
      started.push(job);
    });

    await launchAuditRun({ id: jobId, storeId });

    assert.deepEqual(started, [{ id: jobId, storeId }]);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    assert.equal(row?.status, 'queued', 'starting is the runner’s business, not this function’s');
  });

  it('marks the job failed and reports 503 when the run cannot be started', async () => {
    const { storeId, jobId } = await queuedJob();
    useAuditRunStarter(async () => {
      throw new Error('workflow create rejected');
    });

    await assert.rejects(
      launchAuditRun({ id: jobId, storeId }),
      (error: unknown) => error instanceof ApiError && error.statusCode === 503 && error.code === 'AUDIT_RUN_START_FAILED',
    );

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /could not be started: .*workflow create rejected/);
    assert.ok(row?.finishedAt instanceof Date);
  });

  it('frees the store for its next run once the failed start is recorded', async () => {
    const { storeId, jobId } = await queuedJob();
    useAuditRunStarter(async () => {
      throw new Error('workflow create rejected');
    });
    await assert.rejects(launchAuditRun({ id: jobId, storeId }));

    // The one-active-job-per-store index would refuse this if the failed job were still queued.
    const [next] = await db.insert(jobs).values({ storeId }).returning();
    assert.ok(next && next.id > jobId);
  });
});
