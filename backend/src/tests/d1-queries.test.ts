// ─── The queries rewritten for D1, on a real SQLite database (npm test) ─
// Moving from MySQL to Cloudflare D1 changed the SQL behind these app functions: insert-or-update
// (ON CONFLICT instead of ON DUPLICATE KEY), rows read back with RETURNING, row-count checks, the
// unique-violation check, the severity ordering, a JSON lookup, and text compared ignoring case.
// Each is exercised here through the app's own function, on the in-memory database the helper builds
// from the real D1 migration — SQLite, the engine D1 runs. The rows are the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import './helpers/database.js';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { insertReturning, updateReturning } from '../db/returning.js';
import {
  aiDiscoverySettings, aiFixProposals, audits, findings, integrations, jobs, pageSettings, schemaTemplates,
  stores, userSessions, users,
} from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { addPromptQuery, setIndexNowKey } from '../services/ai-discovery.service.js';
import { listPriorityFindings } from '../services/finding.service.js';
import { markConnectorState, markConnectorSynced } from '../services/integration.service.js';
import { readOnboardingPreferences, writeOnboardingPreferences } from '../services/onboarding-preferences.service.js';
import { saveSchemaTemplate } from '../services/schema-template.service.js';
import { createSession, rotateSession } from '../services/session.service.js';
import { findRememberedStore } from '../services/shopify-login.service.js';
import { updateUserById } from '../services/user.service.js';

let counter = 0;
/** A user with one store, unique per call. */
async function owner(email?: string) {
  counter += 1;
  const user = await insertReturning(users, { fullName: 'Test', email: email ?? `owner${counter}@example.com` });
  const store = await insertReturning(stores, {
    ownerId: user.id, workspaceName: 'W', name: `Store ${counter}`, url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  });
  return { user, store };
}

describe('insert-or-update (ON CONFLICT DO UPDATE)', () => {
  it('integrations: the second write updates the store+provider row instead of adding one', async () => {
    const { store } = await owner();
    await markConnectorState(store.id, 'pagespeed', 'needs_attention', 'quota');
    await markConnectorState(store.id, 'pagespeed', 'connected', null);
    await markConnectorSynced(store.id, 'pagespeed', 'account-1');

    const rows = await db.select().from(integrations).where(and(eq(integrations.storeId, store.id), eq(integrations.provider, 'pagespeed')));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'connected');
    assert.equal(rows[0]?.accountDetail, 'account-1');
    assert.ok(rows[0]?.lastSyncedAt instanceof Date);
  });

  it('ai_discovery_settings: one row per store, the key replaced on the second write', async () => {
    const { store } = await owner();
    await setIndexNowKey(store.id, 'a'.repeat(32));
    await setIndexNowKey(store.id, 'b'.repeat(32));
    const rows = await db.select().from(aiDiscoverySettings).where(eq(aiDiscoverySettings.storeId, store.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.indexNowKey, 'b'.repeat(32));
  });

  it('page_settings: onboarding preferences upsert on store+slug', async () => {
    const { store } = await owner();
    await writeOnboardingPreferences(store.id, { protectedPaths: ['/a'] });
    await writeOnboardingPreferences(store.id, { protectedPaths: ['/b'] });
    const rows = await db.select().from(pageSettings).where(eq(pageSettings.storeId, store.id));
    assert.equal(rows.length, 1);
    assert.deepEqual((await readOnboardingPreferences(store.id)).protectedPaths, ['/b']);
  });

  it('schema_templates: upsert on store+type+context', async () => {
    const { user, store } = await owner();
    await saveSchemaTemplate(user.id, 'Organization', 'shop', { enabled: false, properties: {} }, store.id);
    const saved = await saveSchemaTemplate(user.id, 'Organization', 'shop', { enabled: true, properties: {} }, store.id);
    const rows = await db.select().from(schemaTemplates).where(eq(schemaTemplates.storeId, store.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.enabled, true);
    assert.equal(saved.enabled, true);
  });

  it('ai_fix_proposals: the upsert returns the row id whether it inserted or updated (fix-apply)', async () => {
    const { store } = await owner();
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50 });
    const finding = await insertReturning(findings, {
      auditId: audit.id, pillar: 'seo', subPillar: 'title-tags', title: 'T', severity: 'high',
      affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
    });
    // The same statement services/fix-apply.service.ts runs.
    const write = (value: string) => db
      .insert(aiFixProposals)
      .values({
        findingId: finding.id, storeId: store.id, resourceType: 'product', resourceId: '1', field: 'seo.title',
        currentValue: 'old', proposedValue: value, reason: 'Written by the merchant.', status: 'approved', decidedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [aiFixProposals.findingId, aiFixProposals.resourceType, aiFixProposals.resourceId, aiFixProposals.field],
        set: { proposedValue: value, status: 'approved' },
      })
      .returning({ id: aiFixProposals.id });

    const [first] = await write('one');
    const [second] = await write('two');
    assert.ok(first && first.id > 0);
    assert.equal(second?.id, first.id, 'editing the draft returns the same row, not 0');
    const [row] = await db.select().from(aiFixProposals).where(eq(aiFixProposals.id, first.id));
    assert.equal(row?.proposedValue, 'two');
  });
});

describe('rows read back with RETURNING', () => {
  it('insertReturning returns the stored row with its defaults', async () => {
    const { store } = await owner();
    const job = await insertReturning(jobs, { storeId: store.id });
    assert.equal(job.status, 'queued');
    assert.equal(job.progress, 0);
    assert.ok(job.createdAt instanceof Date);
  });

  it('updateReturning returns exactly the rows it changed, even when it changes the column it matched on', async () => {
    const { store } = await owner();
    const job = await insertReturning(jobs, { storeId: store.id });
    const changed = await updateReturning(jobs, { status: 'failed' }, and(eq(jobs.id, job.id), eq(jobs.status, 'queued')));
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.status, 'failed');
    assert.deepEqual(await updateReturning(jobs, { status: 'failed' }, and(eq(jobs.id, job.id), eq(jobs.status, 'queued'))), []);
  });
});

describe('checks that depended on how many rows an update changed', () => {
  it('a refresh token rotates once; the old token cannot rotate it again', async () => {
    const { user } = await owner();
    const expires = new Date(Date.now() + 86_400_000);
    await createSession(user.id, 'token-1', expires, { ipAddress: null, userAgent: null });
    assert.equal(await rotateSession('token-1', 'token-2', expires, { ipAddress: null, userAgent: null }), true);
    assert.equal(await rotateSession('token-1', 'token-3', expires, { ipAddress: null, userAgent: null }), false);
    const sessions = await db.select().from(userSessions).where(eq(userSessions.userId, user.id));
    assert.equal(sessions.length, 1);
  });
});

describe('the unique-violation check', () => {
  it('recognises SQLite refusing a second active job for a store', async () => {
    const { store } = await owner();
    await insertReturning(jobs, { storeId: store.id });
    let caught: unknown;
    try {
      await insertReturning(jobs, { storeId: store.id });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'the one-active-job index refused the second job');
    assert.equal(isUniqueViolation(caught), true);
    assert.equal(isUniqueViolation(new Error('something else')), false);
  });
});

describe('severity ordering (CASE instead of MySQL FIELD())', () => {
  it('lists critical, then high, then medium, then low — not alphabetically', async () => {
    const { user, store } = await owner();
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50, source: 'engine' });
    for (const severity of ['low', 'medium', 'critical', 'high']) {
      await insertReturning(findings, {
        auditId: audit.id, pillar: 'seo', subPillar: `x-${severity}`, title: severity, severity,
        affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
      });
    }
    const listed = await listPriorityFindings(user.id, store.id, 10);
    assert.deepEqual(listed.map((finding) => finding.severity), ['critical', 'high', 'medium', 'low']);
  });
});

describe('JSON lookup (json_extract instead of JSON_UNQUOTE(JSON_EXTRACT()))', () => {
  it('finds the store whose recorded Shopify profile names the shop', async () => {
    const { store } = await owner();
    await db.update(stores).set({ shopifyProfile: { shopDomain: 'remembered-shop.myshopify.com' } }).where(eq(stores.id, store.id));
    const found = await findRememberedStore('remembered-shop.myshopify.com');
    assert.equal(found?.id, store.id);
    assert.equal(await findRememberedStore('nobody.myshopify.com'), null);
  });
});

describe('text compared ignoring case, as MySQL did', () => {
  it('an email another account holds is refused whatever its case', async () => {
    await owner('taken@example.com');
    const { user } = await owner();
    await assert.rejects(
      updateUserById(user.id, { email: 'Taken@Example.com' }),
      (error: unknown) => error instanceof ApiError && error.code === 'EMAIL_IN_USE',
    );
  });

  it('the same tracked question in different case is refused, a new one is saved', async () => {
    const { store } = await owner();
    const first = await addPromptQuery(store.id, 'Best waterproof dog coat', 'Brand');
    assert.ok(first.id > 0);
    await assert.rejects(
      addPromptQuery(store.id, 'best WATERPROOF dog coat', 'Brand'),
      (error: unknown) => error instanceof ApiError && error.statusCode === 409 && error.code === 'PROMPT_QUERY_DUPLICATE',
    );
    const second = await addPromptQuery(store.id, 'Warmest dog coat', 'Brand');
    assert.ok(second.id > first.id);
  });
});
