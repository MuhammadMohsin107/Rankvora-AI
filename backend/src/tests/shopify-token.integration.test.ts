import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// The Shopify config is read once at module load, so it must be set before anything that
// imports config/env.js is pulled in — the database helper included, since it opens the database.
// Hence the dynamic imports below.
process.env.SHOPIFY_API_KEY ??= 'test-client-id';
process.env.SHOPIFY_API_SECRET ??= 'test-client-secret';
process.env.BACKEND_URL ??= 'http://localhost:5000';
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

await import('./helpers/database.js');

const { eq } = await import('drizzle-orm');
const { closeDatabase, db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { integrations, shopifyConnections, stores, users } = await import('../db/schema.js');
const { encryptToken, decryptToken } = await import('../lib/crypto.js');
const { getValidAccessToken } = await import('../services/shopify-oauth.service.js');

// Integration test: exercises the real expiring-offline-token lifecycle against a real (in-memory
// SQLite) database. Only Shopify's HTTP endpoint is stubbed — the encryption, persistence and
// decision logic are the genuine production code path.

const created: number[] = [];

async function makeConnection(overrides: Partial<typeof shopifyConnections.$inferInsert> = {}) {
  const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const user = await insertReturning(users, {
    fullName: 'Token Test',
    email: `token-${stamp}@example.test`,
    passwordHash: 'x',
    jobTitle: 'QA',
  });
  created.push(user.id);

  const store = await insertReturning(stores, {
    ownerId: user.id,
    workspaceName: 'w',
    name: 'n',
    url: 'https://x.myshopify.com',
    platform: 'Shopify',
    industry: 'i',
    country: 'c',
    timezone: 't',
    currency: 'u',
  });

  await db.insert(integrations).values({ storeId: store.id, provider: 'shopify', status: 'connected' });

  const connection = await insertReturning(shopifyConnections, {
    storeId: store.id,
    shopDomain: `token-${stamp}.myshopify.com`,
    accessTokenEncrypted: encryptToken('live-access-token'),
    scope: 'read_products',
    ...overrides,
  });

  return { connection, storeId: store.id };
}

/** Replaces global fetch for one call and restores it afterwards. */
async function withFetch<T>(impl: typeof fetch, task: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await task();
  } finally {
    globalThis.fetch = original;
  }
}

const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);

after(async () => {
  for (const id of created) await db.delete(users).where(eq(users.id, id));
  closeDatabase();
});

describe('expiring offline access tokens', () => {
  it('returns a legacy non-expiring token untouched instead of treating it as expired', async () => {
    // Connections created before expiring tokens have NULL expiry and NO refresh token. Reading
    // NULL as "expired at epoch" would send every one of them down a refresh path they cannot
    // complete, breaking stores that were working fine.
    const { connection } = await makeConnection({ accessTokenExpiresAt: null, refreshTokenEncrypted: null });

    const token = await withFetch(
      async () => {
        throw new Error('must not contact Shopify for a non-expiring token');
      },
      () => getValidAccessToken(connection),
    );

    assert.equal(token, 'live-access-token');
  });

  it('returns a still-valid expiring token without spending a refresh', async () => {
    const { connection } = await makeConnection({
      accessTokenExpiresAt: minutes(45),
      refreshTokenEncrypted: encryptToken('refresh-me'),
      refreshTokenExpiresAt: minutes(60 * 24 * 80),
    });

    const token = await withFetch(
      async () => {
        throw new Error('must not refresh a token that is still valid');
      },
      () => getValidAccessToken(connection),
    );

    assert.equal(token, 'live-access-token');
  });

  it('refreshes inside the skew window and persists the new encrypted pair', async () => {
    // Two minutes of life left is inside the five-minute skew: a long audit run started now would
    // otherwise have its token die mid-flight.
    const { connection } = await makeConnection({
      accessTokenExpiresAt: minutes(2),
      refreshTokenEncrypted: encryptToken('refresh-me'),
      refreshTokenExpiresAt: minutes(60 * 24 * 80),
    });

    let sentBody = '';
    const token = await withFetch(
      (async (_url: string, init: RequestInit) => {
        sentBody = String(init.body);
        return new Response(
          JSON.stringify({
            access_token: 'rotated-access-token',
            scope: 'read_products',
            expires_in: 3600,
            refresh_token: 'rotated-refresh-token',
            refresh_token_expires_in: 7_776_000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
      () => getValidAccessToken(connection),
    );

    assert.equal(token, 'rotated-access-token');
    assert.match(sentBody, /grant_type=refresh_token/);
    assert.match(sentBody, /refresh_token=refresh-me/);

    const [stored] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id)).limit(1);
    assert.equal(decryptToken(stored!.accessTokenEncrypted), 'rotated-access-token');
    assert.equal(decryptToken(stored!.refreshTokenEncrypted!), 'rotated-refresh-token');
    // Stored encrypted, never in the clear.
    assert.ok(!stored!.accessTokenEncrypted.includes('rotated-access-token'));
    assert.ok(stored!.accessTokenExpiresAt!.getTime() > Date.now());
  });

  it('demands re-authorization when the token expired and there is no refresh token', async () => {
    const { connection, storeId } = await makeConnection({
      accessTokenExpiresAt: minutes(-1),
      refreshTokenEncrypted: null,
    });

    const error = await getValidAccessToken(connection).catch((e) => e);
    assert.equal(error.code, 'SHOPIFY_REAUTH_REQUIRED');

    // The merchant has to see why audits stopped, so the integration row is flagged.
    const [integration] = await db.select().from(integrations).where(eq(integrations.storeId, storeId)).limit(1);
    assert.equal(integration!.status, 'needs_attention');
    assert.match(integration!.notice ?? '', /Reconnect/i);
  });

  it('demands re-authorization when the refresh token itself has expired', async () => {
    const { connection } = await makeConnection({
      accessTokenExpiresAt: minutes(-1),
      refreshTokenEncrypted: encryptToken('long-dead'),
      refreshTokenExpiresAt: minutes(-10),
    });

    const error = await withFetch(
      async () => {
        throw new Error('must not attempt a refresh with an expired refresh token');
      },
      () => getValidAccessToken(connection).catch((e) => e),
    );

    assert.equal(error.code, 'SHOPIFY_REAUTH_REQUIRED');
  });

  it('demands re-authorization when Shopify rejects the refresh token', async () => {
    const { connection } = await makeConnection({
      accessTokenExpiresAt: minutes(-1),
      refreshTokenEncrypted: encryptToken('revoked'),
      refreshTokenExpiresAt: minutes(60 * 24 * 80),
    });

    const error = await withFetch(
      (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch,
      () => getValidAccessToken(connection).catch((e) => e),
    );

    assert.equal(error.code, 'SHOPIFY_REAUTH_REQUIRED');
  });
});
