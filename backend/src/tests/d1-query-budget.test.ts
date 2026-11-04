// ─── How many D1 queries one Worker invocation makes (npm test) ──────
// D1 allows 1,000 queries per Worker invocation on the Paid plan, and a request, a Workflow step or a
// cron tick is one invocation. A db.batch() counts as ONE query there. These tests count what the
// busiest paths really send, by counting the statements SQLite prepares — which counts every
// statement inside a batch separately, so the numbers here can only be higher than D1's. Each path
// must stay well under 1,000, and the sweeps' cost per store is pinned so a change that makes it
// dearer shows up as a failing test instead of as stores quietly skipped in production.
// Every row is the test's own.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

// Read once at module load by config/env.js — set before anything imports it.
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

await import('./helpers/database.js');
const { eq } = await import('drizzle-orm');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { aiFixProposals, audits, findings, googleConnections, jobs, shopifyConnections, stores, users } = await import('../db/schema.js');
const { env } = await import('../config/env.js');
const { encryptToken } = await import('../lib/crypto.js');
const { getDashboardSignals } = await import('../services/dashboard-signals.service.js');
const { decideFixProposals } = await import('../services/ai-fix.service.js');
const { failInterruptedJobs, failStuckJobs, useAuditRunStarter } = await import('../services/job.service.js');
const { runDueAutoAnalyses } = await import('../services/auto-analysis.service.js');
const { runWeeklySummaries } = await import('../services/weekly-summary.service.js');
const { runAuditJob } = await import('../audit-engine/runner.js');

/** D1's limit, and how much of it a single path may use before the test fails. */
const LIMIT = 1_000;
const HEADROOM = 0.8;

// Every statement SQLite prepares passes through here, which is every statement the app sends.
let statements = 0;
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function patched(this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
  statements += 1;
  return originalPrepare.apply(this, args);
};

async function count(run: () => Promise<unknown>): Promise<number> {
  statements = 0;
  await run();
  return statements;
}

const report: string[] = [];
function note(label: string, queries: number, per?: string) {
  report.push(`${label.padEnd(58)} ${String(queries).padStart(5)} queries${per ? `  (${per})` : ''}`);
}

let counter = 0;
async function owner(overrides: Partial<typeof stores.$inferInsert> = {}) {
  counter += 1;
  const user = await insertReturning(users, { fullName: 'Test', email: `budget${counter}@example.com` });
  const store = await insertReturning(stores, {
    ownerId: user.id, workspaceName: 'W', name: `Store ${counter}`, url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR', ...overrides,
  });
  return { user, store };
}

async function connectedStore(overrides: Partial<typeof stores.$inferInsert> = {}) {
  const made = await owner(overrides);
  await db.insert(shopifyConnections).values({ storeId: made.store.id, shopDomain: `budget-${counter}.myshopify.com`, accessTokenEncrypted: 'x', scope: 'x' });
  return made;
}

describe('requests that touch many rows', () => {
  it('closing stuck and interrupted jobs is one statement each, however many there are', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (let index = 0; index < 120; index += 1) {
      const { store } = await owner();
      await insertReturning(jobs, { storeId: store.id, status: 'running', startedAt: old });
    }

    const stuck = await count(() => failStuckJobs(new Date()));
    const { store } = await owner();
    await insertReturning(jobs, { storeId: store.id, status: 'queued' });
    const interrupted = await count(() => failInterruptedJobs());

    note('close 120 stuck jobs', stuck);
    note('close the jobs a restart left behind', interrupted);
    assert.equal(stuck, 1);
    assert.equal(interrupted, 1);
  });

  it('approving 100 fixes and rejecting 100 more in one request stays under the limit', async () => {
    const { user, store } = await owner();
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine' });
    const ids: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const finding = await insertReturning(findings, {
        auditId: audit.id, pillar: 'seo', subPillar: 'title-tags', title: `T${index}`, severity: 'high',
        affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
      });
      ids.push((await insertReturning(aiFixProposals, {
        findingId: finding.id, storeId: store.id, resourceType: 'product', resourceId: `gid://${index}`, field: 'seo.title',
        currentValue: 'Old title', proposedValue: `A clearer product title number ${index}`, reason: 'r',
      })).id);
    }

    let result!: Awaited<ReturnType<typeof decideFixProposals>>;
    const queries = await count(async () => {
      result = await decideFixProposals(user.id, { approve: ids.slice(0, 100), reject: ids.slice(100) }, { storeId: store.id });
    });

    note('approve 100 fixes + reject 100 fixes (one request)', queries, `${(queries / 200).toFixed(1)} per decision`);
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed.slice(0, 2)));
    assert.equal(result.approved.length, 100);
    assert.equal(result.rejected.length, 100);
    assert.ok(queries < LIMIT * HEADROOM, `${queries} queries; D1 allows ${LIMIT}`);
  });

  it('the four dashboard cards read with the same few queries however much data sits behind them', async () => {
    // Search Console configured and connected, so its whole path is counted — the connection read,
    // the two reads of Google (not database queries) and the bookkeeping after them.
    const mutable = env as unknown as Record<string, unknown>;
    const saved = { id: mutable.googleClientId, secret: mutable.googleClientSecret };
    mutable.googleClientId = 'budget-client';
    mutable.googleClientSecret = 'budget-secret';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ rows: [{ clicks: 10 }] }), { status: 200 })) as typeof fetch;
    try {
      const { user, store } = await owner();
      await db.insert(googleConnections).values({
        storeId: store.id, siteUrl: 'sc-domain:example.com', scope: 'webmasters.readonly',
        accessTokenEncrypted: encryptToken('token'), accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine' });
      for (let index = 0; index < 120; index += 1) {
        const finding = await insertReturning(findings, {
          auditId: audit.id, pillar: 'seo', subPillar: `area-${index % 12}`, title: `T${index}`, severity: 'high',
          affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
        });
        await insertReturning(aiFixProposals, {
          findingId: finding.id, storeId: store.id, resourceType: 'product', resourceId: `gid://${index}`, field: 'seo.title',
          currentValue: 'Old', proposedValue: `A clearer title ${index}`, reason: 'r',
        });
      }

      let signals!: Awaited<ReturnType<typeof getDashboardSignals>>;
      const queries = await count(async () => { signals = await getDashboardSignals(user.id, store.id); });

      note('dashboard cards: 4 signals, 120 drafts waiting in 12 areas', queries);
      assert.equal(signals.searchTraffic.status, 'ready');
      assert.equal(signals.approvals.status === 'ready' && signals.approvals.data.total, 120);
      // Grouped in the database, so 120 drafts in 12 areas come back as 12 rows and cost one query.
      assert.equal(signals.approvals.status === 'ready' && signals.approvals.data.areas.length, 12);
      // Far under D1's 1,000 — and under the Free plan's 50 as well, which a request on the
      // Free plan (the deployed test address, until Workers Paid is on) is held to.
      assert.ok(queries < 30, `${queries} queries for one dashboard load`);
    } finally {
      globalThis.fetch = realFetch;
      mutable.googleClientId = saved.id;
      mutable.googleClientSecret = saved.secret;
    }
  });
});

describe('the cron sweeps', () => {
  /** A Monday, so every store's weekly summary is due. */
  const MONDAY = new Date('2026-10-26T10:00:00Z');

  it('auto-analysis: what it costs per connected store that is not due', async () => {
    useAuditRunStarter(async () => undefined);
    const fresh = [];
    for (let index = 0; index < 30; index += 1) {
      const { store } = await connectedStore();
      await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine', runAt: new Date(MONDAY.getTime() - 60_000) });
      fresh.push(store.id);
    }
    const others = (await db.select({ id: stores.id }).from(stores).where(eq(stores.autoAnalysis, true))).length;

    let sweep!: Awaited<ReturnType<typeof runDueAutoAnalyses>>;
    const queries = await count(async () => { sweep = await runDueAutoAnalyses(MONDAY); });

    const perStore = queries / sweep.considered;
    note(`auto-analysis tick over ${sweep.considered} stores, none due`, queries, `${perStore.toFixed(1)} per store; connected stores cost 3 each, so a tick reaches ~${Math.floor((LIMIT * HEADROOM) / 3)} of them`);
    assert.ok(sweep.considered >= 30 && others >= 30);
    assert.ok(perStore <= 3.2, `${perStore.toFixed(2)} queries per store — a tick of 1,000 reaches ${Math.floor(LIMIT / perStore)} stores`);
  });

  it('weekly summaries: what it costs per store whose summary is due', async () => {
    const due = [];
    for (let index = 0; index < 20; index += 1) {
      const made = await connectedStore();
      await insertReturning(audits, { storeId: made.store.id, overallScore: 60, source: 'engine', runAt: new Date(MONDAY.getTime() - 3 * 86_400_000) });
      due.push(made.store.id);
    }

    let sweep!: Awaited<ReturnType<typeof runWeeklySummaries>>;
    const queries = await count(async () => { sweep = await runWeeklySummaries(MONDAY); });

    // A store with no connection costs one query (the data-source check) and is counted as skipped; a
    // store that is not due costs none. What is left is the cost of each summary written.
    const perWritten = (queries - sweep.skipped - 1) / sweep.written;
    note(`weekly summaries, ${sweep.written} written and ${sweep.skipped} skipped`, queries, `${perWritten.toFixed(1)} per summary written; a tick reaches ~${Math.floor((LIMIT * HEADROOM) / perWritten)} due stores`);
    assert.ok(sweep.written >= 20, JSON.stringify(sweep));
    assert.ok(perWritten <= 9, `${perWritten.toFixed(2)} queries per summary — a tick of 1,000 reaches ${Math.floor(LIMIT / perWritten)} stores`);
  });
});

describe('one audit run', () => {
  it('a 307-finding audit uses a small share of one Workflow step’s budget', async () => {
    const { store } = await connectedStore();
    const job = await insertReturning(jobs, { storeId: store.id });
    const check = (subPillar: string, total: number, severity = 'medium') => ({
      id: `seo.${subPillar}`, pillar: 'seo', subPillar,
      execute: () => ({
        subPillar, status: 'ok', score: 70, analyzedCount: total, healthyCount: 0,
        details: { status: 'ok', summary: 's', healthChip: 'x', contextLabel: 'x', contextValue: 'x', evidenceRows: [] },
        findings: Array.from({ length: total }, (_, index) => ({
          title: `${subPillar} ${index}`, severity, affectedCount: 1, affectedLabel: 'pages', scoreLift: 1, problem: 'p', why: 'w',
          recommendation: 'r', evidence: [`line ${index}`], evidenceRows: [{ id: `r${index}`, status: 'issue', cells: { url: `https://t/p/${index}` } }], details: {},
        })),
      }),
    });
    const snapshot = {
      storeId: store.id, capturedAt: new Date(),
      shop: { domain: 'b.myshopify.com', primaryUrl: 'https://b.myshopify.com', name: 'B', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
      products: [], collections: [], pages: [], articles: [], policies: [], policyAccess: { available: true }, theme: null, storefront: null,
      redirects: { available: false, reason: 'error', detail: 'stand-in' }, crawl: null,
      coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: false },
      scope: { productLimit: 100, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
      warnings: [],
    };

    const queries = await count(() => runAuditJob(job.id, {
      resolveProvider: async () => ({ kind: 'test', buildSnapshot: async () => snapshot }) as never,
      checks: [check('titles', 180), check('metas', 120, 'high'), check('alts', 7, 'low')] as never,
    }));

    const [finished] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    note('one audit run, 307 findings', queries);
    assert.equal(finished?.status, 'succeeded');
    assert.ok(queries < LIMIT * 0.5, `${queries} queries in one Workflow step`);
  });
});

describe('budget report', () => {
  it('prints what was measured', () => {
    console.log(`\n${report.join('\n')}\n`);
  });
});
