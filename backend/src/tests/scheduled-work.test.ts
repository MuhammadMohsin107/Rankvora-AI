// ─── The scheduled sweep and stuck jobs (npm test) ───────────────────
// What the Cloudflare cron trigger runs every 30 minutes. The sweeps are swapped for recording stand-ins,
// and the stuck-job sweep runs against the in-memory database the helper builds from the real D1
// migration, on jobs the test writes with known ages — no Cloudflare, and no data beyond its own rows.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import './helpers/database.js';
import { db } from '../db/client.js';
import { jobs, stores, users } from '../db/schema.js';
import { failStuckJobs } from '../services/job.service.js';
import { runScheduledWork } from '../services/scheduled-work.service.js';

const NOW = new Date('2026-10-27T10:00:00.000Z');
const autoSweep = { considered: 2, started: 1, skipped: 1 };
const weeklySweep = { considered: 2, written: 0, skipped: 2 };

describe('runScheduledWork', () => {
  it('closes stuck jobs first, then runs auto-analysis and the weekly summary, all at the tick time', async () => {
    const calls: string[] = [];
    const result = await runScheduledWork(NOW, {
      failStuckJobs: async (now) => { calls.push(`stuck ${now.toISOString()}`); return 0; },
      runDueAutoAnalyses: async (now) => { calls.push(`auto ${now.toISOString()}`); return autoSweep; },
      runWeeklySummaries: async (now) => { calls.push(`weekly ${now.toISOString()}`); return weeklySweep; },
    });

    assert.deepEqual(calls, [
      'stuck 2026-10-27T10:00:00.000Z',
      'auto 2026-10-27T10:00:00.000Z',
      'weekly 2026-10-27T10:00:00.000Z',
    ]);
    assert.deepEqual(result, { stuckJobsClosed: 0, autoAnalysis: autoSweep, weeklySummary: weeklySweep, failures: [] });
  });

  it('keeps going when one part fails, records why, and never throws', async () => {
    const result = await runScheduledWork(NOW, {
      failStuckJobs: async () => { throw new Error('database unreachable'); },
      runDueAutoAnalyses: async () => autoSweep,
      runWeeklySummaries: async () => { throw new Error('summary write failed'); },
    });

    assert.equal(result.stuckJobsClosed, null);
    assert.deepEqual(result.autoAnalysis, autoSweep);
    assert.equal(result.weeklySummary, null);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0] ?? '', /^stuck jobs: .*database unreachable/);
    assert.match(result.failures[1] ?? '', /^weekly summary: .*summary write failed/);
  });
});

const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** One store per job, so the one-active-job-per-store rule never gets in the way of the setup. */
async function jobInState(state: { status: string; startedAt?: Date; createdAt: Date }): Promise<number> {
  const [user] = await db.insert(users).values({ fullName: 'T', email: `t${Math.random()}@example.com` }).returning();
  const [store] = await db.insert(stores).values({
    ownerId: user!.id, workspaceName: 'W', name: 'S', url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  }).returning();
  const [job] = await db.insert(jobs).values({ storeId: store!.id, ...state }).returning();
  return job!.id;
}

describe('failStuckJobs', () => {
  it('fails running jobs past 40 minutes and queued jobs past 15, and nothing younger or finished', async () => {
    const ids = {
      runningOld: await jobInState({ status: 'running', startedAt: minutesBefore(41), createdAt: minutesBefore(42) }),
      runningYoung: await jobInState({ status: 'running', startedAt: minutesBefore(39), createdAt: minutesBefore(40) }),
      queuedOld: await jobInState({ status: 'queued', createdAt: minutesBefore(16) }),
      queuedYoung: await jobInState({ status: 'queued', createdAt: minutesBefore(14) }),
      succeededOld: await jobInState({ status: 'succeeded', startedAt: minutesBefore(500), createdAt: minutesBefore(500) }),
    };

    const closed = await failStuckJobs(NOW);
    assert.equal(closed, 2);

    const rows = await db.select({ id: jobs.id, status: jobs.status, error: jobs.error, finishedAt: jobs.finishedAt })
      .from(jobs).where(inArray(jobs.id, Object.values(ids)));
    const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    assert.equal(status[ids.runningOld], 'failed');
    assert.equal(status[ids.queuedOld], 'failed');
    assert.equal(status[ids.runningYoung], 'running');
    assert.equal(status[ids.queuedYoung], 'queued');
    assert.equal(status[ids.succeededOld], 'succeeded', 'a finished job keeps its real result');

    const [failed] = await db.select().from(jobs).where(eq(jobs.id, ids.runningOld));
    assert.match(failed?.error ?? '', /stopped before it finished/);
    assert.equal(failed?.finishedAt?.getTime(), NOW.getTime());
  });

  it('changes nothing when no job is stuck', async () => {
    assert.equal(await failStuckJobs(NOW), 0);
  });
});
