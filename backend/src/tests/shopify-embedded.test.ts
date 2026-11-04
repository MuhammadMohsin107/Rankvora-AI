// ─── The embedded app: ID-token auth, opening a shop, and the webhooks that keep it right (npm test) ─
// Drives the REAL middleware, routes, controllers and services over HTTP against a real (in-memory
// SQLite) database. The only thing replaced is Shopify's side: the token endpoint and the Admin API
// are answered by a stand-in, and every request the stand-in sees is checked against what Shopify's
// documentation says that request must contain.
//
// What it proves:
//   • a request proves itself with a Shopify ID token alone — no cookie, no stored session — and is
//     the account that owns the shop, while a forged, expired, foreign or unknown-shop token is not;
//   • a shop's first open exchanges the token (and creates the account), later opens do not call
//     Shopify at all, and a shop that was granted too little opens nothing;
//   • the webhook that records new scopes accepts only Shopify's signature.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';

await import('./helpers/database.js');

const { default: express } = await import('express');
const { eq } = await import('drizzle-orm');
const { env } = await import('../config/env.js');
const { closeDatabase, db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { integrations, shopifyConnections, stores, users } = await import('../db/schema.js');
const { encryptToken, decryptToken } = await import('../lib/crypto.js');
const { authenticate } = await import('../middleware/authenticate.js');
const { errorHandler } = await import('../middleware/error.js');
const { authRouter } = await import('../routes/auth.js');
const { googleRouter } = await import('../routes/google.js');
const { shopifyRouter } = await import('../routes/shopify.js');
const { signGoogleState } = await import('../lib/jwt.js');
const { connectionIsCurrent } = await import('../services/shopify-embedded.service.js');
const { getValidAccessToken } = await import('../services/shopify-oauth.service.js');
const { SHOPIFY_API_VERSION } = await import('../audit-engine/store-data/shopify-client.js');

const RETRY_HEADER = 'x-shopify-retry-invalid-session-request';

/** Every scope the app asks for, as Shopify reports a full grant. */
const FULL_SCOPE = 'read_products,read_content,read_themes,read_metaobjects,read_legal_policies,read_online_store_navigation,write_products,write_content';

const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);
const days = (n: number) => minutes(n * 24 * 60);

// ─── Tokens the way Shopify issues them ──────────────────────────────

function idTokenFor(shop: string, overrides: Record<string, unknown> = {}, secret = env.shopifyApiSecret!) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: env.shopifyApiKey, sub: '1', exp: now + 60, nbf: now - 5, iat: now - 5, jti: `j-${Math.random()}`, ...overrides },
    secret,
    { algorithm: 'HS256' },
  );
}

// ─── A server with the real routes ───────────────────────────────────

let base = '';
let server: import('node:http').Server;
const realFetch = globalThis.fetch;

before(async () => {
  const app = express();
  // The same raw-body capture app.ts uses: Shopify signs webhooks over the exact bytes.
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request).rawBody = Buffer.from(buf); } }));
  app.get('/whoami', authenticate, (req, res) => res.json({ userId: req.user!.id }));
  app.use('/api/auth', authRouter);
  app.use('/api/google', googleRouter);
  app.use('/api/shopify', shopifyRouter);
  app.use(errorHandler);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

// ─── A stand-in for Shopify ──────────────────────────────────────────

interface ShopifyCall { url: URL; form?: URLSearchParams; query?: string; token?: string }

/**
 * Answers every request that is not to the test server itself — Shopify's token endpoint and Admin
 * API — and records it. `tokenResponse` is what the token endpoint returns.
 */
function standInForShopify(shop: string, tokenResponse: Record<string, unknown> | null) {
  const calls: ShopifyCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);

    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    assert.equal(url.hostname, shop, 'only the shop that opened the app may be called');

    if (url.pathname === '/admin/oauth/access_token') {
      calls.push({ url, form: new URLSearchParams(String(init?.body)) });
      return tokenResponse ? json(tokenResponse) : json({ error: 'invalid_request' }, 400);
    }

    const body = JSON.parse(String(init?.body)) as { query: string };
    const headers = new Headers(init?.headers);
    calls.push({ url, query: body.query, token: headers.get('X-Shopify-Access-Token') ?? undefined });
    if (body.query.includes('ScoreloShopOwner')) return json({ data: { shop: { email: ownerEmailFor(shop), shopOwnerName: 'Olive Owner' } } });
    if (body.query.includes('ScoreloShopIdentity')) {
      return json({
        data: {
          shop: {
            id: `gid://shopify/Shop/${shop.length}`,
            name: 'Embedded Test Shop',
            contactEmail: 'hello@embedded-test.example',
            myshopifyDomain: shop,
            currencyCode: 'USD',
            ianaTimezone: 'America/New_York',
            plan: { displayName: 'Basic' },
            billingAddress: { country: 'United States' },
            primaryDomain: { url: 'https://embedded-test.example', host: 'embedded-test.example' },
          },
        },
      });
    }
    return json({ errors: [{ message: `unexpected query in test: ${body.query.slice(0, 40)}` }] });
  }) as typeof fetch;
  return calls;
}

/** One owner email can belong to one account, so every shop in these tests has its own owner. */
function ownerEmailFor(shop: string) {
  return `owner-${shop.split('.')[0]}@embedded-test.example`;
}

function noCallsToShopify() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    throw new Error(`must not contact Shopify: ${url}`);
  }) as typeof fetch;
}

// ─── Fixtures ────────────────────────────────────────────────────────

let counter = 0;

/** A shop that has already opened the app: owner, store and connection. */
async function installedShop(overrides: Partial<typeof shopifyConnections.$inferInsert> = {}) {
  counter += 1;
  const shop = `embedded-${process.pid}-${counter}.myshopify.com`;
  const owner = await insertReturning(users, { fullName: 'Owner', email: `owner-${process.pid}-${counter}@embedded.example`, jobTitle: 'QA' });
  const store = await insertReturning(stores, {
    ownerId: owner.id,
    workspaceName: 'w',
    name: 'n',
    url: `https://${shop}`,
    platform: 'Shopify',
    industry: 'i',
    country: 'c',
    timezone: 't',
    currency: 'u',
  });
  const connection = await insertReturning(shopifyConnections, {
    storeId: store.id,
    shopDomain: shop,
    accessTokenEncrypted: encryptToken('stored-access-token'),
    refreshTokenEncrypted: encryptToken('stored-refresh-token'),
    accessTokenExpiresAt: minutes(45),
    refreshTokenExpiresAt: days(80),
    scope: FULL_SCOPE,
    ...overrides,
  });
  return { shop, owner, store, connection };
}

const get = (path: string, token?: string) => realFetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (path: string, token?: string, init: RequestInit = {}) =>
  realFetch(`${base}${path}`, { method: 'POST', ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });

// ─── authenticate ────────────────────────────────────────────────────

describe('authenticate with a Shopify ID token', () => {
  it('is the account that owns the shop, with nothing but the token', async () => {
    const { shop, owner } = await installedShop();
    const response = await get('/whoami', idTokenFor(shop));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: owner.id });
  });

  it('does not call Shopify to decide that', async () => {
    const { shop } = await installedShop();
    noCallsToShopify();
    assert.equal((await get('/whoami', idTokenFor(shop))).status, 200);
  });

  it('refuses a token signed with another secret, and tells App Bridge to fetch a fresh one and retry', async () => {
    const { shop } = await installedShop();
    const response = await get('/whoami', idTokenFor(shop, {}, 'forged-secret'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(RETRY_HEADER), '1');
    assert.equal(((await response.json()) as { code: string }).code, 'SHOPIFY_ID_TOKEN_INVALID');
  });

  it('refuses an expired token the same way', async () => {
    const { shop } = await installedShop();
    const past = Math.floor(Date.now() / 1000) - 600;
    const response = await get('/whoami', idTokenFor(shop, { exp: past + 30, nbf: past - 60, iat: past - 60 }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(RETRY_HEADER), '1');
  });

  it('refuses a valid token for a shop that has not opened the app, without asking for a retry', async () => {
    const response = await get('/whoami', idTokenFor('never-opened.myshopify.com'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(RETRY_HEADER), null, 'a new token would change nothing');
    assert.equal(((await response.json()) as { code: string }).code, 'SHOPIFY_NOT_INSTALLED');
  });

  it('refuses a shop that was uninstalled', async () => {
    const { shop } = await installedShop({ uninstalledAt: new Date() });
    const response = await get('/whoami', idTokenFor(shop));
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { code: string }).code, 'SHOPIFY_NOT_INSTALLED');
  });

  it('cannot be used to act as a different shop than the token names', async () => {
    const mine = await installedShop();
    const theirs = await installedShop();
    const response = await get('/whoami', idTokenFor(mine.shop));
    assert.deepEqual(await response.json(), { userId: mine.owner.id });
    assert.notEqual(mine.owner.id, theirs.owner.id);
  });

  it('accepts nothing but a Shopify ID token: the app issues no token of its own, and never honours one', async () => {
    const { owner } = await installedShop();
    // A token shaped like the session tokens the app used to issue, signed with the app's own secret.
    const own = jwt.sign({ sub: owner.id, type: 'access' }, env.jwtAccessSecret, { expiresIn: '15m' });
    const response = await get('/whoami', own);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(RETRY_HEADER), null, 'a new token from the same place would change nothing');
  });

  it('refuses a request with no token at all', async () => {
    assert.equal((await get('/whoami')).status, 401);
  });
});

// ─── Opening the app ─────────────────────────────────────────────────

describe('POST /api/auth/shopify/embedded', () => {
  it('opens a shop that is already connected without contacting Shopify', async () => {
    const { shop, owner } = await installedShop();
    noCallsToShopify();
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { user: Record<string, unknown> & { id: number }; shop: string } };
    assert.equal(body.data.user.id, owner.id);
    assert.equal(body.data.shop, shop);
    assert.deepEqual(Object.keys(body.data.user).filter((key) => /password|secret|token|hash|credential/i.test(key)), [], 'the account carries no credential, under any name');
  });

  it('issues no session: no token, no refresh token, no cookie — only the account and the shop', async () => {
    const { shop } = await installedShop();
    noCallsToShopify();
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    const body = (await response.json()) as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.data).sort(), ['shop', 'user']);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(JSON.stringify(body), /accessToken|refreshToken|"token"/i);
  });

  it('exchanges the ID token for an expiring offline token the first time, and creates the account from the shop', async () => {
    const shop = `first-open-${process.pid}.myshopify.com`;
    const token = idTokenFor(shop);
    const calls = standInForShopify(shop, {
      access_token: 'shpat_exchanged',
      scope: FULL_SCOPE,
      expires_in: 3600,
      refresh_token: 'shprt_exchanged',
      refresh_token_expires_in: 7_776_000,
    });

    const response = await post('/api/auth/shopify/embedded', token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { user: { id: number; email: string; fullName: string } } };
    assert.equal(body.data.user.email, ownerEmailFor(shop));

    // What Shopify's documentation says a token exchange must contain.
    const exchange = calls.find((call) => call.form)!;
    assert.equal(exchange.url.toString(), `https://${shop}/admin/oauth/access_token`);
    assert.equal(exchange.form!.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(exchange.form!.get('subject_token'), token);
    assert.equal(exchange.form!.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:id_token');
    assert.equal(exchange.form!.get('requested_token_type'), 'urn:shopify:params:oauth:token-type:offline-access-token');
    assert.equal(exchange.form!.get('expiring'), '1', 'public apps must use expiring tokens');
    assert.equal(exchange.form!.get('client_id'), env.shopifyApiKey);
    assert.equal(exchange.form!.get('client_secret'), env.shopifyApiSecret);

    // The token was used (proved) against the right API version, and then stored encrypted.
    assert.ok(calls.some((call) => call.query && call.url.pathname === `/admin/api/${SHOPIFY_API_VERSION}/graphql.json` && call.token === 'shpat_exchanged'));
    const [connection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shop));
    assert.ok(connection, 'the connection is recorded');
    assert.notEqual(connection!.accessTokenEncrypted, 'shpat_exchanged', 'never stored in the clear');
    assert.equal(decryptToken(connection!.accessTokenEncrypted), 'shpat_exchanged');
    assert.equal(decryptToken(connection!.refreshTokenEncrypted!), 'shprt_exchanged');
    assert.equal(connection!.scope, FULL_SCOPE);
    assert.ok(connection!.accessTokenExpiresAt && connection!.accessTokenExpiresAt.getTime() > Date.now());
    const [store] = await db.select().from(stores).where(eq(stores.id, connection!.storeId));
    assert.equal(store!.platform, 'Shopify');
  });

  it('does not exchange again once the shop is open: the second open makes no call to Shopify', async () => {
    const shop = `second-open-${process.pid}.myshopify.com`;
    standInForShopify(shop, { access_token: 'shpat_2', scope: FULL_SCOPE, expires_in: 3600, refresh_token: 'shprt_2', refresh_token_expires_in: 7_776_000 });
    const first = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(first.status, 200);

    noCallsToShopify();
    const second = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(second.status, 200);
    const [a, b] = [(await first.json()) as { data: { user: { id: number } } }, (await second.json()) as { data: { user: { id: number } } }];
    assert.equal(a.data.user.id, b.data.user.id, 'the same account both times');
  });

  it('opens nothing for a shop that was granted fewer scopes than the app needs', async () => {
    const shop = `short-scopes-${process.pid}.myshopify.com`;
    standInForShopify(shop, { access_token: 'shpat_short', scope: 'read_products', expires_in: 3600, refresh_token: 'r', refresh_token_expires_in: 7_776_000 });
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, 'SHOPIFY_SCOPES_MISSING');
    const rows = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shop));
    assert.equal(rows.length, 0, 'no connection is recorded for a shop that cannot be audited');
  });

  it('exchanges again for a reinstalled shop, and clears the uninstall stamp', async () => {
    const { shop, connection } = await installedShop({ uninstalledAt: new Date() });
    standInForShopify(shop, { access_token: 'shpat_back', scope: FULL_SCOPE, expires_in: 3600, refresh_token: 'shprt_back', refresh_token_expires_in: 7_776_000 });
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(response.status, 200);
    const [after] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(after!.uninstalledAt, null);
    assert.equal(decryptToken(after!.accessTokenEncrypted), 'shpat_back');
  });

  it('answers a forged token with 401 and the retry header, and never reaches Shopify', async () => {
    noCallsToShopify();
    const response = await post('/api/auth/shopify/embedded', idTokenFor('forged.myshopify.com', {}, 'not-the-secret'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(RETRY_HEADER), '1');
  });

  it('answers a request with no token with 401', async () => {
    const response = await post('/api/auth/shopify/embedded');
    assert.equal(response.status, 401);
  });

  it('reports a refused exchange as a failure of Shopify’s side, not as an account problem', async () => {
    const shop = `exchange-refused-${process.pid}.myshopify.com`;
    standInForShopify(shop, null);
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { code: string }).code, 'SHOPIFY_TOKEN_EXCHANGE_FAILED');
  });
});

// ─── When a stored connection can be used as it is ───────────────────

describe('connectionIsCurrent', () => {
  type Connection = typeof shopifyConnections.$inferSelect;
  const template: Connection = {
    id: 1,
    storeId: 1,
    shopDomain: 'x.myshopify.com',
    shopGid: null,
    accessTokenEncrypted: 'a',
    refreshTokenEncrypted: 'r',
    accessTokenExpiresAt: minutes(30),
    refreshTokenExpiresAt: days(60),
    scope: FULL_SCOPE,
    installedAt: new Date(),
    uninstalledAt: null,
    lastWebhookAt: null,
    lastSyncSummary: null,
    lastSyncError: null,
  } as Connection;
  const with_ = (changes: Partial<Connection>): Connection => ({ ...template, ...changes });

  it('is current with a live access token', () => assert.equal(connectionIsCurrent(template), true));
  it('is current with a legacy token that never expires', () => {
    assert.equal(connectionIsCurrent(with_({ accessTokenExpiresAt: null, refreshTokenEncrypted: null, refreshTokenExpiresAt: null })), true);
  });
  it('is current when the access token lapsed but a refresh token can renew it', () => {
    assert.equal(connectionIsCurrent(with_({ accessTokenExpiresAt: minutes(-5) })), true);
  });
  it('is not current when both tokens have lapsed', () => {
    assert.equal(connectionIsCurrent(with_({ accessTokenExpiresAt: minutes(-5), refreshTokenExpiresAt: minutes(-1) })), false);
  });
  it('is not current when the access token lapsed and there is no refresh token', () => {
    assert.equal(connectionIsCurrent(with_({ accessTokenExpiresAt: minutes(-5), refreshTokenEncrypted: null })), false);
  });
  it('is not current once uninstalled', () => assert.equal(connectionIsCurrent(with_({ uninstalledAt: new Date() })), false));
  it('is not current when the granted scopes no longer cover what the app asks for', () => {
    assert.equal(connectionIsCurrent(with_({ scope: 'read_products' })), false);
  });
});

// ─── app/scopes_update ───────────────────────────────────────────────

describe('POST /api/shopify/webhooks/app-scopes-update', () => {
  const sign = (body: string) => createHmac('sha256', env.shopifyApiSecret!).update(body).digest('base64');
  const send = (shop: string, body: string, hmac: string) =>
    post('/api/shopify/webhooks/app-scopes-update', undefined, {
      body,
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Shop-Domain': shop },
    });

  it('records the scopes Shopify says are now granted', async () => {
    const { shop, connection } = await installedShop();
    const body = JSON.stringify({ id: 1, current: ['read_products', 'write_products'], previous: [], updated_at: new Date().toISOString() });
    assert.equal((await send(shop, body, sign(body))).status, 200);
    const [row] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(row!.scope, 'read_products,write_products');
  });

  it('refuses a request Shopify did not sign, and changes nothing', async () => {
    const { shop, connection } = await installedShop();
    const body = JSON.stringify({ current: ['read_products'] });
    assert.equal((await send(shop, body, sign('a different body'))).status, 401);
    const [row] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(row!.scope, FULL_SCOPE);
  });

  it('ignores a signed payload with no usable scope list, rather than guessing', async () => {
    const { shop, connection } = await installedShop();
    for (const payload of [{}, { current: 'read_products' }, { current: [1, 2] }]) {
      const body = JSON.stringify(payload);
      assert.equal((await send(shop, body, sign(body))).status, 200);
    }
    const [row] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(row!.scope, FULL_SCOPE);
  });

  it('answers 200 for a shop it does not know', async () => {
    const body = JSON.stringify({ current: ['read_products'] });
    assert.equal((await send('unknown-shop.myshopify.com', body, sign(body))).status, 200);
  });
});

// ─── Coming back from Google ─────────────────────────────────────────

describe('GET /api/google/callback — where the merchant lands', () => {
  // The merchant leaves the Shopify admin to reach Google. Back on the bare site there is no session
  // and nothing to show outside the admin's iframe, so a shop that has the app installed is sent back
  // to the app INSIDE its admin.
  const callback = async (state: string) => {
    const response = await realFetch(`${base}/api/google/callback?state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(response.status, 302, 'a browser navigation always ends in a redirect');
    return new URL(response.headers.get('location')!);
  };

  it('returns an installed shop to the app inside its Shopify admin', async () => {
    const { shop, owner, store } = await installedShop();
    const location = await callback(signGoogleState(owner.id, store.id));
    assert.equal(location.origin, `https://${shop}`);
    assert.equal(location.pathname, `/admin/apps/${env.shopifyApiKey}/integrations`);
    assert.equal(location.searchParams.get('google'), 'failed', 'a callback with no code is reported, not hidden');
  });

  it('returns guided setup to guided setup', async () => {
    const { shop, owner, store } = await installedShop();
    const location = await callback(signGoogleState(owner.id, store.id, 'onboarding'));
    assert.equal(location.origin, `https://${shop}`);
    assert.equal(location.pathname, `/admin/apps/${env.shopifyApiKey}/onboarding`);
  });

  it('does not send a shop that was uninstalled to its admin', async () => {
    const { owner, store } = await installedShop({ uninstalledAt: new Date() });
    const location = await callback(signGoogleState(owner.id, store.id));
    assert.equal(location.origin, new URL(env.frontendUrl).origin);
    assert.equal(location.pathname, '/integrations');
  });

  it('sends a store with no Shopify connection back to the site, as before', async () => {
    const owner = await insertReturning(users, { fullName: 'No Shop', email: `noshop-${process.pid}@embedded.example`, jobTitle: 'QA' });
    const store = await insertReturning(stores, { ownerId: owner.id, workspaceName: 'w', name: 'n', url: 'https://x.example', platform: 'Shopify', industry: 'i', country: 'c', timezone: 't', currency: 'u' });
    const location = await callback(signGoogleState(owner.id, store.id));
    assert.equal(location.origin, new URL(env.frontendUrl).origin);
    assert.equal(location.pathname, '/integrations');
  });

  it('trusts nothing in a state it cannot verify: the site, and the default page', async () => {
    const location = await callback('not-a-signed-state');
    assert.equal(location.origin, new URL(env.frontendUrl).origin);
    assert.equal(location.pathname, '/integrations');
  });
});

// ─── A refresh token Shopify refused ─────────────────────────────────

describe('recovering when Shopify refuses the refresh token', () => {
  // A revoked refresh token still looks valid by its dates, so nothing would say the connection is
  // dead — and inside the admin there is no Reconnect button to press. What recovers it is the next
  // time the app is opened: the ID token that carries is exchanged for fresh tokens.
  it('re-exchanges the next time the app is opened, and clears the warning', async () => {
    const { shop, connection, store } = await installedShop({ accessTokenExpiresAt: minutes(-10) });
    await db.insert(integrations).values({ storeId: store.id, provider: 'shopify', status: 'connected' });

    // Shopify refuses the refresh token: the connection is recorded as dead, not only reported.
    standInForShopify(shop, null);
    await assert.rejects(
      () => getValidAccessToken(connection),
      (error: { code?: string }) => error.code === 'SHOPIFY_REAUTH_REQUIRED',
    );
    const [dead] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(connectionIsCurrent(dead!), false, 'it no longer passes as current');
    assert.equal(dead!.refreshTokenEncrypted, null);
    const [warned] = await db.select().from(integrations).where(eq(integrations.storeId, store.id));
    assert.equal(warned!.status, 'needs_attention');

    // The merchant opens the app again: fresh tokens, and the warning goes.
    const calls = standInForShopify(shop, { access_token: 'shpat_healed', scope: FULL_SCOPE, expires_in: 3600, refresh_token: 'shprt_healed', refresh_token_expires_in: 7_776_000 });
    const response = await post('/api/auth/shopify/embedded', idTokenFor(shop));
    assert.equal(response.status, 200);
    assert.ok(calls.some((call) => call.form?.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange'));
    const [healed] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    assert.equal(decryptToken(healed!.accessTokenEncrypted), 'shpat_healed');
    assert.equal(connectionIsCurrent(healed!), true);
    const [fine] = await db.select().from(integrations).where(eq(integrations.storeId, store.id));
    assert.equal(fine!.status, 'connected');
    assert.equal(fine!.notice, null);
  });
});
