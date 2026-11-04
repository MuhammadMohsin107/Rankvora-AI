// ─── Which stored connection is the shop that just signed in (npm test) ─
// The rule that decides whether a Shopify sign-in opens an existing store, is refused, or may create
// a new one. It is a pure function over rows, so it is tested here without a database: each case
// builds only the fields the rule reads. What these tests do NOT show is how the rule behaves on the
// real rows — that is checked separately against the live database, read-only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.SHOPIFY_API_KEY ??= 'test-client-id';
process.env.SHOPIFY_API_SECRET ??= 'test-client-secret';
process.env.BACKEND_URL ??= 'http://localhost:5000';
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

const { matchConnection } = await import('../services/shopify-login.service.js');
type Connection = Parameters<typeof matchConnection>[1][number];

const GID = 'gid://shopify/Shop/1001';
const OTHER_GID = 'gid://shopify/Shop/2002';

function connection(fields: Partial<Connection> & Pick<Connection, 'id' | 'shopDomain'>): Connection {
  return {
    storeId: fields.id,
    accessTokenEncrypted: '',
    scope: '',
    refreshTokenEncrypted: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    shopGid: null,
    lastSyncSummary: null,
    lastSyncError: null,
    installedAt: new Date(0),
    uninstalledAt: null,
    lastWebhookAt: null,
    ...fields,
  };
}

describe('matching a signed-in shop to a stored connection', () => {
  it('opens the connection stored for the address', () => {
    const row = connection({ id: 1, shopDomain: 'a.myshopify.com', shopGid: GID });
    assert.deepEqual(matchConnection(row, [], GID), { kind: 'match', connection: row });
  });

  it('accepts a connection stored before shop ids were recorded, by its address', () => {
    const row = connection({ id: 1, shopDomain: 'a.myshopify.com', shopGid: null });
    assert.deepEqual(matchConnection(row, [], GID), { kind: 'match', connection: row });
  });

  it('refuses an address that is on file for a different shop', () => {
    const row = connection({ id: 1, shopDomain: 'a.myshopify.com', shopGid: OTHER_GID });
    assert.deepEqual(matchConnection(row, [], GID), { kind: 'mismatch' });
  });

  it('finds a shop whose address was renamed, by its Shopify id', () => {
    const renamed = connection({ id: 7, shopDomain: 'old-name.myshopify.com', shopGid: GID });
    assert.deepEqual(matchConnection(undefined, [renamed], GID), { kind: 'match', connection: renamed });
  });

  it('prefers the installed connection when one shop id has several', () => {
    const lapsed = connection({ id: 3, shopDomain: 'first.myshopify.com', shopGid: GID, uninstalledAt: new Date(1) });
    const live = connection({ id: 9, shopDomain: 'second.myshopify.com', shopGid: GID });
    assert.equal((matchConnection(undefined, [lapsed, live], GID) as { connection: Connection }).connection.id, 9);
  });

  it('falls back to the oldest when none is installed', () => {
    const first = connection({ id: 3, shopDomain: 'first.myshopify.com', shopGid: GID, uninstalledAt: new Date(1) });
    const second = connection({ id: 9, shopDomain: 'second.myshopify.com', shopGid: GID, uninstalledAt: new Date(2) });
    assert.equal((matchConnection(undefined, [first, second], GID) as { connection: Connection }).connection.id, 3);
  });

  it('knows nothing of a shop with no row for its address or id', () => {
    assert.deepEqual(matchConnection(undefined, [], GID), { kind: 'none' });
  });

  it('answers by address first and never looks at ids stored for other addresses', () => {
    const byAddress = connection({ id: 1, shopDomain: 'a.myshopify.com', shopGid: GID });
    const elsewhere = connection({ id: 2, shopDomain: 'b.myshopify.com', shopGid: GID });
    assert.equal((matchConnection(byAddress, [elsewhere], GID) as { connection: Connection }).connection.id, 1);
  });
});
