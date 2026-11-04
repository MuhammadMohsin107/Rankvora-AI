// ─── Cloudflare D1's limits, met by the app's own queries (npm test) ──
// D1 refuses a statement that binds more than 100 values, a statement over 100 KB, and a LIKE
// pattern over 50 bytes. Plain SQLite accepts all three, so a query that breaks them passes any test
// that does not look — until it runs on D1 for a merchant with enough data. The local test database
// now refuses the first two (db/client.ts), and these tests give each query that used to grow without
// bound a store big enough to hit the limit: more than 100 audits, 100 ids in one request, 120 stuck
// jobs, a search phrase longer than 50 bytes. Every row is the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('./helpers/database.js');
const { and, eq, inArray, isNull, sql } = await import('drizzle-orm');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { D1_ID_LIST_SIZE, D1_MAX_BOUND_PARAMETERS, chunkForD1 } = await import('../db/limits.js');
const { aiFixProposals, audits, findings, jobs, notifications, stores, userSessions, users } = await import('../db/schema.js');
const { ApiError } = await import('../middleware/error.js');
const { findingListQuerySchema } = await import('../schemas/finding.schema.js');
const { bulkUpdateFindingStatus, listFindings, updateFindingStatus } = await import('../services/finding.service.js');
const { failInterruptedJobs, failStuckJobs } = await import('../services/job.service.js');
const { revokeAllSessions } = await import('../services/session.service.js');
const { notifyAuditOutcome } = await import('../services/notification.service.js');
const { clearAiRecommendations } = await import('../services/ai-recommendation.service.js');
const { loadStoreProposals } = await import('../services/fix-apply.service.js');

let counter = 0;

async function owner() {
  counter += 1;
  const user = await insertReturning(users, { fullName: 'Test', email: `limits${counter}@example.com`, passwordHash: 'x' });
  const store = await insertReturning(stores, {
    ownerId: user.id, workspaceName: 'W', name: `Store ${counter}`, url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  });
  return { user, store };
}

const newFinding = (auditId: number, overrides: Partial<typeof findings.$inferInsert> = {}) =>
  insertReturning(findings, {
    auditId, pillar: 'seo', subPillar: 'title-tags', title: 'T', severity: 'high',
    affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r', ...overrides,
  });

/** A store with one engine audit holding `count` findings. */
async function storeWithFindings(count: number) {
  const { user, store } = await owner();
  const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine' });
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(await newFinding(audit.id, { subPillar: `sub-${index}` }));
  return { user, store, audit, rows };
}

describe('the local database refuses what D1 refuses', () => {
  const marks = (count: number) => sql.join(Array.from({ length: count }, (_, index) => sql`${index}`), sql`, `);

  it('accepts a statement that binds exactly 100 values', async () => {
    await db.run(sql`select ${marks(D1_MAX_BOUND_PARAMETERS)}`);
  });

  // Drizzle wraps the driver's error, so the real message sits on `cause`.
  const refusedWith = (pattern: RegExp) => (error: unknown) => {
    for (let current = error as { message?: string; cause?: unknown } | undefined; current; current = current.cause as typeof current) {
      if (pattern.test(String(current.message))) return true;
    }
    return false;
  };

  it('refuses one that binds 101, naming the limit', async () => {
    await assert.rejects(db.run(sql`select ${marks(D1_MAX_BOUND_PARAMETERS + 1)}`), refusedWith(/at most 100 bound values/));
  });

  it('refuses a statement longer than 100,000 bytes', async () => {
    await assert.rejects(db.run(sql.raw(`select '${'x'.repeat(100_001)}'`)), refusedWith(/at most 100000 bytes/));
  });
});

describe('chunkForD1', () => {
  it('splits a list into pieces of at most 90, keeping every value in order', () => {
    assert.deepEqual(chunkForD1([]), []);
    assert.deepEqual(chunkForD1([1]), [[1]]);
    const ids = Array.from({ length: 250 }, (_, index) => index);
    const chunks = chunkForD1(ids);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [90, 90, 70]);
    assert.deepEqual(chunks.flat(), ids);
    assert.equal(D1_ID_LIST_SIZE, 90);
  });
});

describe('findings of a store with a long history', () => {
  it('changes one finding’s status after more than 100 audits — the old query listed every audit id', async () => {
    const { user, store } = await owner();
    for (let index = 0; index < 120; index += 1) await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine' });
    const [latest] = await db.select({ id: sql<number>`max(${audits.id})` }).from(audits).where(eq(audits.storeId, store.id));
    const finding = await newFinding(latest!.id);

    const updated = await updateFindingStatus(user.id, finding.id, { status: 'reviewed' }, store.id);

    assert.equal(updated.status, 'reviewed');
  });

  it('still refuses another store’s finding', async () => {
    const mine = await owner();
    const theirs = await storeWithFindings(1);
    await assert.rejects(
      updateFindingStatus(mine.user.id, theirs.rows[0]!.id, { status: 'ignored' }, mine.store.id),
      (error: unknown) => error instanceof ApiError && error.statusCode === 404 && error.code === 'FINDING_NOT_FOUND',
    );
    const [untouched] = await db.select().from(findings).where(eq(findings.id, theirs.rows[0]!.id));
    assert.equal(untouched?.status, 'open');
  });

  it('changes 100 findings at once — the most a request may name', async () => {
    const { user, store, rows } = await storeWithFindings(100);

    const updated = await bulkUpdateFindingStatus(user.id, { ids: rows.map((row) => row.id), status: 'resolved' }, store.id);

    assert.equal(updated.length, 100);
    assert.ok(updated.every((row) => row.status === 'resolved'));
    const stored = await db.select().from(findings).where(and(inArray(findings.id, rows.slice(0, 50).map((row) => row.id)), eq(findings.status, 'resolved')));
    assert.equal(stored.length, 50);
  });

  it('changes nothing when one of the ids belongs to another store', async () => {
    const mine = await storeWithFindings(3);
    const theirs = await storeWithFindings(1);
    const ids = [...mine.rows.map((row) => row.id), theirs.rows[0]!.id];

    await assert.rejects(
      bulkUpdateFindingStatus(mine.user.id, { ids, status: 'ignored' }, mine.store.id),
      (error: unknown) => error instanceof ApiError && error.statusCode === 404 && error.code === 'FINDINGS_NOT_FOUND',
    );

    const stored = await db.select().from(findings).where(inArray(findings.id, ids));
    assert.ok(stored.every((row) => row.status === 'open'));
  });

  it('clears AI text from 150 findings in one call', async () => {
    const { audit } = await storeWithFindings(0);
    const rows = [];
    for (let index = 0; index < 150; index += 1) rows.push(await newFinding(audit.id, { subPillar: `ai-${index}`, aiModel: 'test-model' }));

    await clearAiRecommendations(rows.map((row) => row.id));

    const stored = await db.select().from(findings).where(and(eq(findings.auditId, audit.id), isNull(findings.aiModel)));
    assert.equal(stored.length, 150);
  });
});

describe('searching findings', () => {
  const search = (userId: number, storeId: number, text: string) =>
    listFindings(userId, findingListQuerySchema.parse({ search: text }), storeId);

  it('finds a phrase longer than D1’s 50-byte LIKE pattern', async () => {
    const { user, store, audit } = await storeWithFindings(0);
    const phrase = 'Product titles repeat the brand name so many times that search results cannot tell them apart';
    assert.ok(Buffer.byteLength(phrase) > 50);
    await newFinding(audit.id, { title: phrase, subPillar: 'long-title' });
    await newFinding(audit.id, { title: 'Something else', subPillar: 'other' });

    const found = await search(user.id, store.id, phrase);

    assert.deepEqual(found.items.map((item) => item.title), [phrase]);
  });

  it('ignores letter case, and looks in the title, the sub-pillar and the recommendation', async () => {
    const { user, store, audit } = await storeWithFindings(0);
    await newFinding(audit.id, { title: 'Organic COTTON tee', subPillar: 'a' });
    await newFinding(audit.id, { title: 'x', subPillar: 'cotton-handles' });
    await newFinding(audit.id, { title: 'y', subPillar: 'b', recommendation: 'Switch to cotton' });
    await newFinding(audit.id, { title: 'z', subPillar: 'c' });

    const found = await search(user.id, store.id, 'Cotton');

    assert.equal(found.items.length, 3);
    assert.equal(found.pagination.total, 3);
  });

  it('reads % and _ as the characters they are, not as wildcards', async () => {
    const { user, store, audit } = await storeWithFindings(0);
    await newFinding(audit.id, { title: '100% cotton', subPillar: 'p' });
    await newFinding(audit.id, { title: 'abc', subPillar: 'q' });

    assert.equal((await search(user.id, store.id, '100%')).items.length, 1);
    assert.equal((await search(user.id, store.id, '1%0')).items.length, 0, '% in the search is not a wildcard');
    assert.equal((await search(user.id, store.id, 'a_c')).items.length, 0, '_ in the search is not a wildcard');
  });
});

describe('bookkeeping that used to list every id', () => {
  it('folds 120 unread notices into one when an audit finishes', async () => {
    const { store } = await owner();
    for (let index = 0; index < 120; index += 1) {
      await insertReturning(notifications, { storeId: store.id, type: 'analysis_complete', title: `Old ${index}`, message: 'm' });
    }

    await notifyAuditOutcome(store.id, { auditId: 1, pillarCount: 3, findingCount: 5, critical: [] });

    const unread = await db.select().from(notifications).where(and(eq(notifications.storeId, store.id), eq(notifications.type, 'analysis_complete'), eq(notifications.isRead, false)));
    assert.equal(unread.length, 1);
  });

  it('loads 100 fix proposals for a store, and none that belong to another', async () => {
    const mine = await storeWithFindings(1);
    const theirs = await storeWithFindings(1);
    const proposal = (storeId: number, findingId: number, index: number) => insertReturning(aiFixProposals, {
      findingId, storeId, resourceType: 'product', resourceId: `gid://${index}`, field: 'seo_title',
      currentValue: 'a', proposedValue: 'b', reason: 'r',
    });
    const mineIds: number[] = [];
    for (let index = 0; index < 100; index += 1) mineIds.push((await proposal(mine.store.id, mine.rows[0]!.id, index)).id);
    const theirId = (await proposal(theirs.store.id, theirs.rows[0]!.id, 0)).id;

    const loaded = await loadStoreProposals(mine.store.id, [...mineIds, theirId]);

    assert.equal(loaded.length, 100);
    assert.ok(!loaded.some((row) => row.id === theirId));
  });
});

describe('closing out jobs and sessions in bulk', () => {
  async function activeJobs(count: number, status: 'queued' | 'running', startedAt: Date | null) {
    const ids: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const { store } = await owner();
      ids.push((await insertReturning(jobs, { storeId: store.id, status, startedAt, createdAt: startedAt ?? new Date() })).id);
    }
    return ids;
  }
  const statusOf = async (ids: number[]) => (await db.select({ status: jobs.status }).from(jobs).where(inArray(jobs.id, ids.slice(0, 90)))).map((row) => row.status);

  it('closes 120 stuck jobs and leaves a fresh one alone', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const stuck = await activeJobs(120, 'running', old);
    const [fresh] = await activeJobs(1, 'running', now);
    const stale = await activeJobs(5, 'queued', old);

    const closed = await failStuckJobs(now);

    assert.ok(closed >= 125, `closed ${closed}`);
    assert.ok((await statusOf(stuck)).every((status) => status === 'failed'));
    assert.ok((await statusOf(stale)).every((status) => status === 'failed'));
    assert.deepEqual(await statusOf([fresh!]), ['running']);
  });

  it('closes every job a restart left behind, however many', async () => {
    const running = await activeJobs(110, 'running', new Date());
    const before = (await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ['queued', 'running']))).length;

    const closed = await failInterruptedJobs();

    assert.equal(closed, before);
    assert.ok(before >= 111);
    assert.ok((await statusOf(running)).every((status) => status === 'failed'));
    assert.equal((await db.select().from(jobs).where(inArray(jobs.status, ['queued', 'running']))).length, 0);
  });

  it('signs a user out of 150 sessions at once, and no one else’s', async () => {
    const { user } = await owner();
    const other = await owner();
    const expiresAt = new Date(Date.now() + 86_400_000);
    for (let index = 0; index < 150; index += 1) await db.insert(userSessions).values({ userId: user.id, tokenHash: `limits-a-${counter}-${index}`, expiresAt });
    await db.insert(userSessions).values({ userId: user.id, tokenHash: `limits-revoked-${counter}`, expiresAt, revokedAt: new Date() });
    await db.insert(userSessions).values({ userId: other.user.id, tokenHash: `limits-b-${counter}`, expiresAt });

    const revoked = await revokeAllSessions(user.id);

    assert.equal(revoked, 150, 'the session that was already revoked is not counted');
    assert.equal((await db.select().from(userSessions).where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)))).length, 0);
    assert.equal((await db.select().from(userSessions).where(and(eq(userSessions.userId, other.user.id), isNull(userSessions.revokedAt)))).length, 1);
  });
});
