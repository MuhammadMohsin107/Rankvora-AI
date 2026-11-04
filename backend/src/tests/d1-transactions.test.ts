// ─── Writes that belong together, as D1 batches (npm test) ───────────
// Cloudflare D1 refuses an interactive transaction (BEGIN ... COMMIT), so every place that wrote
// several rows "together" now writes them in one db.batch(): all of it, or none. These tests run each
// of those places through the app's own functions, on the in-memory database the helper builds from
// the real D1 migration, and check both halves of the promise — everything written when it succeeds,
// nothing written when any part fails. Shopify is a stand-in client; every row is the test's own.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Read once at module load by config/env.js — set before anything imports it (the database helper too).
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

await import('./helpers/database.js');
const { eq } = await import('drizzle-orm');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { groupForD1 } = await import('../db/limits.js');
const schema = await import('../db/schema.js');
const { auditScores, audits, findings, integrations, jobs, shopifyConnections, stores, users } = schema;
const { createAccountForShop } = await import('../services/shopify-login.service.js');
const { ShopifyClient } = await import('../audit-engine/store-data/shopify-client.js');
const { runAuditJob } = await import('../audit-engine/runner.js');

let counter = 0;

async function account(overrides: Partial<typeof users.$inferInsert> = {}) {
  counter += 1;
  return insertReturning(users, { fullName: 'T', email: `tx${counter}@example.com`, ...overrides });
}

async function storeOf(ownerId: number) {
  return insertReturning(stores, {
    ownerId, workspaceName: 'W', name: 'S', url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  });
}

describe('Shopify sign-in for a shop never seen before', () => {
  /** A Shopify client whose Admin API answers the owner query with this email. */
  const shopifyAnswering = (email: string) => new ShopifyClient({
    shopDomain: 'unused.myshopify.com',
    accessToken: 'unused',
    fetchImpl: async () => new Response(JSON.stringify({ data: { shop: { email, shopOwnerName: 'Owner Name' } } }), { status: 200 }),
  });
  const identity = (shop: string) => ({
    gid: `gid://shopify/Shop/${shop.length}${counter}`, name: 'New Shop', contactEmail: null, myshopifyDomain: shop,
    currencyCode: 'PKR', ianaTimezone: 'Asia/Karachi', country: 'Pakistan', planName: null, primaryUrl: `https://${shop}`,
  });
  const tokens = { accessToken: 'shpat_test', scope: 'read_products', accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null };

  it('writes the account, its store, the connection and the integration, all linked', async () => {
    const shop = 'brand-new.myshopify.com';
    const userId = await createAccountForShop(shop, tokens, identity(shop), shopifyAnswering('Owner@Brand-New.com'));

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(user?.email, 'owner@brand-new.com', 'stored lower-case');
    const owned = await db.select().from(stores).where(eq(stores.ownerId, userId));
    assert.equal(owned.length, 1);
    const store = owned[0]!;
    assert.equal(store.name, 'New Shop');
    const [connection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, store.id));
    assert.equal(connection?.shopDomain, shop);
    assert.notEqual(connection?.accessTokenEncrypted, 'shpat_test', 'the token is stored encrypted');
    const [integration] = await db.select().from(integrations).where(eq(integrations.storeId, store.id));
    assert.equal(integration?.provider, 'shopify');
    assert.equal(integration?.status, 'connected');
  });

  it('writes nothing at all when one part fails — no account without its store and connection', async () => {
    // The shop's domain is already held by another store's connection, so the connection insert —
    // the third of four statements — is refused by the unique index.
    const shop = 'already-connected.myshopify.com';
    const other = await storeOf((await account()).id);
    await db.insert(shopifyConnections).values({ storeId: other.id, shopDomain: shop, accessTokenEncrypted: 'x', scope: 'x' });

    await assert.rejects(createAccountForShop(shop, tokens, identity(shop), shopifyAnswering('half@built.example')));

    assert.equal((await db.select().from(users).where(eq(users.email, 'half@built.example'))).length, 0, 'no orphan account');
    assert.equal((await db.select().from(stores).where(eq(stores.name, 'New Shop'))).filter((s) => s.ownerId !== other.ownerId).length, 1,
      'only the store from the previous test exists — none was half-created here');
  });
});

describe('saving a finished audit', () => {
  /** A stand-in store snapshot: the runner reads nothing else from Shopify. */
  const snapshotFor = (storeId: number) => ({
    storeId, capturedAt: new Date(),
    shop: { domain: 'tx.myshopify.com', primaryUrl: 'https://tx.myshopify.com', name: 'TX', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products: [], collections: [], pages: [], articles: [], policies: [],
    policyAccess: { available: true }, theme: null, storefront: null,
    redirects: { available: false, reason: 'error', detail: 'not fetched in tests' },
    crawl: null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: false },
    scope: { productLimit: 100, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  });

  /** A check that reports `count` findings, each with the given severity. */
  const checkWithFindings = (subPillar: string, count: number, severity = 'medium') => ({
    id: `seo.${subPillar}`, pillar: 'seo' as const, subPillar,
    execute: () => ({
      subPillar, status: 'ok' as const, score: 70, analyzedCount: count, healthyCount: 0,
      details: { status: 'ok', summary: 's', healthChip: 'x', contextLabel: 'x', contextValue: 'x', evidenceRows: [] },
      findings: Array.from({ length: count }, (_, i) => ({
        title: `${subPillar} finding ${i}`, severity, affectedCount: 1, affectedLabel: 'pages', scoreLift: 1,
        problem: 'p', why: 'w', recommendation: 'r', evidence: [`line ${i}`],
        evidenceRows: [{ id: `r${i}`, status: 'issue', cells: { url: `https://tx.myshopify.com/p/${i}` } }], details: { issueType: 'Issue' },
      })),
    }),
  });

  async function runWith(checks: ReturnType<typeof checkWithFindings>[]) {
    const store = await storeOf((await account()).id);
    const job = await insertReturning(jobs, { storeId: store.id });
    await runAuditJob(job.id, {
      resolveProvider: async () => ({ kind: 'test', buildSnapshot: async () => snapshotFor(store.id) }) as never,
      checks: checks as never,
    });
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    return { storeId: store.id, job: after! };
  }

  it('saves a large audit whole: every score and every finding, linked to the new audit', async () => {
    const { storeId, job } = await runWith([checkWithFindings('titles', 180), checkWithFindings('metas', 120, 'high'), checkWithFindings('alts', 7, 'low')]);

    assert.equal(job.status, 'succeeded', job.error ?? '');
    const saved = await db.select().from(audits).where(eq(audits.storeId, storeId));
    assert.equal(saved.length, 1);
    assert.equal(job.auditId, saved[0]!.id);
    const savedFindings = await db.select().from(findings).where(eq(findings.auditId, saved[0]!.id));
    assert.equal(savedFindings.length, 307, 'every finding, across many grouped statements');
    const scores = await db.select().from(auditScores).where(eq(auditScores.auditId, saved[0]!.id));
    assert.equal(scores.length, 4, 'one pillar row and three sub-pillar rows');
  });

  it('saves nothing when any part of the save fails, and fails the job — no half-written audit', async () => {
    // 'urgent' breaks findings_severity_valid, so the LAST group of the batch is refused.
    const { storeId, job } = await runWith([checkWithFindings('titles', 40), checkWithFindings('broken', 1, 'urgent')]);

    assert.equal(job.status, 'failed');
    assert.equal((await db.select().from(audits).where(eq(audits.storeId, storeId))).length, 0, 'no audit row');
    const orphanScores = await db.select().from(auditScores).innerJoin(audits, eq(auditScores.auditId, audits.id)).where(eq(audits.storeId, storeId));
    assert.equal(orphanScores.length, 0);
  });
});

describe('the D1 statement limit', () => {
  it('groups rows so no statement binds more than 100 values, keeping every row in order', () => {
    const rows = Array.from({ length: 23 }, (_, i) => i);
    const groups = groupForD1(rows, () => 17);
    assert.deepEqual(groups.flat(), rows);
    assert.ok(groups.every((group) => group.length * 17 <= 100));
    assert.equal(groups[0]?.length, 5);
  });

  it('refuses a single row that could never fit', () => {
    assert.throws(() => groupForD1([1], () => 101), /D1 accepts at most 100/);
  });
});

describe('no interactive transactions left', () => {
  it('nothing in the app calls .transaction() — D1 refuses it', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'tests') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const code = fs.readFileSync(full, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
          if (/\.transaction\(/.test(code)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
