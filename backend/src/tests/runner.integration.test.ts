import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../db/client.js';
import { insertReturning } from '../db/returning.js';
import { auditScores, audits, findings, jobs, stores, users } from '../db/schema.js';
import { runAuditJob } from '../audit-engine/runner.js';
import { StoreDataError, type StoreDataProvider, type StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';
import './helpers/database.js';

// Integration test: exercises the real worker against a real (in-memory SQLite) database.
// Only the external store-data provider is stubbed — everything else (the batched save,
// persistence, scoring, job lifecycle) is the genuine production code path.

function snapshotFor(storeId: number): StoreSnapshot {
  return {
    storeId,
    capturedAt: new Date(),
    shop: { domain: 'itest.myshopify.com', primaryUrl: 'https://itest.myshopify.com', name: 'ITest', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products: [],
    collections: [],
    pages: [],
    articles: [],
    policies: [],

    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'error', detail: 'not fetched in tests' },

    crawl: null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: false },
    scope: { productLimit: 100, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  };
}

function stubProvider(storeId: number): StoreDataProvider {
  return { kind: 'test', buildSnapshot: async () => snapshotFor(storeId) };
}

function passingCheck(subPillar: string, score: number): AuditCheck {
  return {
    id: `seo.${subPillar}`,
    pillar: 'seo',
    subPillar,
    execute: (): SubPillarResult => ({
      subPillar,
      status: 'ok',
      score,
      analyzedCount: 10,
      healthyCount: Math.round((score / 100) * 10),
      details: { status: 'ok', summary: `${subPillar} summary`, healthChip: 'Healthy', contextLabel: 'Checked', contextValue: '10', evidenceRows: [] },
      findings: [
        {
          title: `${subPillar} issue`,
          severity: 'medium',
          affectedCount: 3,
          affectedLabel: 'products',
          scoreLift: 2,
          problem: 'p',
          why: 'w',
          recommendation: 'r',
          evidence: ['evidence line'],
          evidenceRows: [{ id: 'r1', status: 'issue', cells: { url: 'https://itest.myshopify.com/products/a' } }],
          details: { issueType: 'Issue' },
        },
      ],
    }),
  };
}

const throwingCheck: AuditCheck = {
  id: 'seo.exploding',
  pillar: 'seo',
  subPillar: 'exploding',
  execute: () => {
    throw new Error('simulated check crash');
  },
};

async function createStoreFixture(email: string) {
  const user = await insertReturning(users, { fullName: 'ITest', email });
  const store = await insertReturning(stores, {
    ownerId: user.id,
    workspaceName: 'ITest',
    name: 'ITest store',
    url: 'https://itest.myshopify.com',
    platform: 'Shopify',
    industry: 'x',
    country: 'x',
    timezone: 'UTC',
    currency: 'USD',
  });
  return { user, store };
}

async function cleanup(userId: number) {
  await db.delete(users).where(eq(users.id, userId)); // cascades to store/jobs/audits/findings
}

after(() => {
  closeDatabase();
});

describe('audit worker (integration, real DB)', () => {
  it('persists a complete audit and marks the job succeeded', async () => {
    const { user, store } = await createStoreFixture(`itest-ok-${process.pid}@test.local`);
    try {
      const job = await insertReturning(jobs, { storeId: store.id, type: 'audit_run' });

      await runAuditJob(job.id, {
        resolveProvider: async () => stubProvider(store.id),
        checks: [passingCheck('title-tags', 90), passingCheck('meta-descriptions', 70)],
      });

      const [finished] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      assert.equal(finished.status, 'succeeded');
      assert.equal(finished.progress, 100);
      assert.ok(finished.auditId, 'job must reference the audit it produced');
      assert.ok(finished.finishedAt, 'a terminal job must record when it finished');

      const [audit] = await db.select().from(audits).where(eq(audits.id, finished.auditId!));
      assert.equal(audit.source, 'engine', 'engine output must never be labelled seed data');
      assert.equal(audit.overallScore, 80, 'overall = mean of pillar scores (90+70)/2');

      const scores = await db.select().from(auditScores).where(eq(auditScores.auditId, audit.id));
      const pillarRow = scores.find((row) => row.subPillar === null);
      assert.ok(pillarRow, 'a pillar-level row must exist');
      assert.equal(pillarRow!.score, 80);
      assert.equal(pillarRow!.checksTotal, 20, 'analyzed counts aggregate to the pillar row');

      const subRows = scores.filter((row) => row.subPillar !== null);
      assert.equal(subRows.length, 2);

      const persistedFindings = await db.select().from(findings).where(eq(findings.auditId, audit.id));
      assert.equal(persistedFindings.length, 2, 'each check contributed one finding');
      assert.deepEqual(persistedFindings[0].evidence, ['evidence line']);
      assert.ok(persistedFindings[0].evidenceRows, 'structured evidence rows must persist');
    } finally {
      await cleanup(user.id);
    }
  });

  it('isolates a crashing check: the audit still completes and other checks survive', async () => {
    const { user, store } = await createStoreFixture(`itest-isolate-${process.pid}@test.local`);
    try {
      const job = await insertReturning(jobs, { storeId: store.id, type: 'audit_run' });

      await runAuditJob(job.id, {
        resolveProvider: async () => stubProvider(store.id),
        checks: [passingCheck('title-tags', 90), throwingCheck],
      });

      const [finished] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      assert.equal(finished.status, 'succeeded', 'one broken check must not fail the whole audit');

      const scores = await db.select().from(auditScores).where(eq(auditScores.auditId, finished.auditId!));
      const exploded = scores.find((row) => row.subPillar === 'exploding');
      assert.ok(exploded, 'the failed check still gets a row, reported honestly');
      const details = exploded!.details as { status?: string; unavailableReason?: string };
      assert.equal(details.status, 'unavailable', 'a crashed check is unavailable, never a passing zero');
      assert.match(details.unavailableReason ?? '', /simulated check crash/);

      const [audit] = await db.select().from(audits).where(eq(audits.id, finished.auditId!));
      // The unavailable sub-pillar is excluded from the average rather than counted as 0.
      assert.equal(audit.overallScore, 90);
      const metadata = audit.metadata as { failedChecks?: string[] };
      assert.deepEqual(metadata.failedChecks, ['seo.exploding'], 'partial audits must disclose which checks failed');
    } finally {
      await cleanup(user.id);
    }
  });

  it('marks the job failed with a reason when the store data source is unusable', async () => {
    const { user, store } = await createStoreFixture(`itest-fail-${process.pid}@test.local`);
    try {
      const job = await insertReturning(jobs, { storeId: store.id, type: 'audit_run' });

      await runAuditJob(job.id, {
        resolveProvider: async () => {
          throw new StoreDataError('TOKEN_REVOKED', 'token revoked', false);
        },
        checks: [passingCheck('title-tags', 90)],
      });

      const [finished] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      assert.equal(finished.status, 'failed');
      assert.match(finished.error ?? '', /TOKEN_REVOKED/);
      assert.ok(finished.finishedAt, 'a failed job must never be left stuck in running');

      const produced = await db.select().from(audits).where(eq(audits.storeId, store.id));
      assert.equal(produced.length, 0, 'a failed run must not persist a misleading audit');
    } finally {
      await cleanup(user.id);
    }
  });

  it('keeps historical audits instead of overwriting them', async () => {
    const { user, store } = await createStoreFixture(`itest-history-${process.pid}@test.local`);
    try {
      for (const score of [60, 95]) {
        const job = await insertReturning(jobs, { storeId: store.id, type: 'audit_run' });
        await runAuditJob(job.id, {
          resolveProvider: async () => stubProvider(store.id),
          checks: [passingCheck('title-tags', score)],
        });
        await db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, job.id));
      }

      const history = await db.select().from(audits).where(eq(audits.storeId, store.id));
      assert.equal(history.length, 2, 'each run adds a new audit; trends depend on this');
      assert.deepEqual(history.map((a) => a.overallScore).sort((a, b) => a - b), [60, 95]);
    } finally {
      await cleanup(user.id);
    }
  });
});
