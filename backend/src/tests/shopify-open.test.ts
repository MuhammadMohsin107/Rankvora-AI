// ─── The bare site's store form (npm test) ───────────────────────────
// A visitor outside the Shopify admin names their store; the server says which Shopify address to go to,
// so that SHOPIFY authenticates them (and installs the app, if it is not installed). Drives the real
// route, controller and service over HTTP against a real (in-memory SQLite) database.
//
// What it proves:
//   • every way of writing a store address reads down to the same handle, and nothing that merely
//     CONTAINS a Shopify address gets through;
//   • an installed shop is sent to the app inside its admin, anything else to Shopify's install screen;
//   • the only thing taken from the request is the handle — the answer is always an address on Shopify,
//     and the route issues no session, sets no cookie and never calls Shopify;
//   • it is rate limited, because it reads the database and anyone can call it.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

await import('./helpers/database.js');

const { default: express } = await import('express');
const { env } = await import('../config/env.js');
const { closeDatabase } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { shopifyConnections, stores, users } = await import('../db/schema.js');
const { encryptToken } = await import('../lib/crypto.js');
const { parseShopHandle } = await import('../lib/shopify-shop.js');
const { errorHandler } = await import('../middleware/error.js');
const { shopifyRouter } = await import('../routes/shopify.js');

// ─── Reading an address ──────────────────────────────────────────────

describe('parseShopHandle', () => {
  const GOOD: Array<[string, string]> = [
    ['my-store', 'my-store'],
    ['my-store.myshopify.com', 'my-store'],
    ['  My-Store.MyShopify.com  ', 'my-store'],
    ['https://my-store.myshopify.com', 'my-store'],
    ['http://my-store.myshopify.com/admin/products?x=1#top', 'my-store'],
    ['my-store.myshopify.com/', 'my-store'],
    ['admin.shopify.com/store/my-store', 'my-store'],
    ['https://admin.shopify.com/store/my-store/apps/rankvora-ai', 'my-store'],
    ['store42', 'store42'],
    ['9-lives', '9-lives'],
  ];
  for (const [typed, handle] of GOOD) {
    it(`reads ${JSON.stringify(typed)} as ${handle}`, () => assert.equal(parseShopHandle(typed), handle));
  }

  const BAD = [
    '',
    '   ',
    '.myshopify.com',
    '-leading-hyphen',
    'has space',
    'under_score',
    'a.b.myshopify.com',
    // The text names a Shopify address without BEING one — each is how an open redirect would be smuggled in.
    'my-store.myshopify.com.evil.example',
    'evil.example/my-store.myshopify.com',
    'https://evil.example/store/my-store',
    'evil.example',
    'https://my-store.myshopify.com@evil.example',
    'my-store.myshopify.com:8080',
    'admin.shopify.com',
    'admin.shopify.com/store',
    'admin.shopify.com/store/',
    'admin.shopify.com/apps/my-store',
    'admin.shopify.com.evil.example/store/my-store',
    'www.some-brand.com',
    'javascript:alert(1)',
    'my-store\nHost: evil.example',
    'a'.repeat(61),
    `${'a'.repeat(400)}.myshopify.com`,
  ];
  for (const typed of BAD) {
    it(`refuses ${JSON.stringify(typed.length > 40 ? `${typed.slice(0, 37)}…` : typed)}`, () => assert.equal(parseShopHandle(typed), null));
  }
});

// ─── The route ───────────────────────────────────────────────────────

let base = '';
let server: import('node:http').Server;
const realFetch = globalThis.fetch;

before(async () => {
  const app = express();
  // So a test can be a caller of its own (X-Forwarded-For): the limiter counts by address.
  app.set('trust proxy', true);
  app.use(express.json());
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

let counter = 0;

/** A shop that has opened the app: owner, store and connection. */
async function installedShop(overrides: Partial<typeof shopifyConnections.$inferInsert> = {}) {
  counter += 1;
  const handle = `open-${process.pid}-${counter}`;
  const shop = `${handle}.myshopify.com`;
  const owner = await insertReturning(users, { fullName: 'Owner', email: `owner-${handle}@open.example`, jobTitle: 'QA' });
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
  await insertReturning(shopifyConnections, {
    storeId: store.id,
    shopDomain: shop,
    accessTokenEncrypted: encryptToken('stored-access-token'),
    scope: 'read_products',
    ...overrides,
  });
  return { handle, shop };
}

let callers = 0;
/** Each call comes from a new address unless one is given, so the rate limit sees them as strangers. */
const open = (body: unknown, from = `10.1.${Math.floor(++callers / 250)}.${callers % 250}`) =>
  realFetch(`${base}/api/shopify/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
    body: JSON.stringify(body),
  });

interface Answer { data: { url: string; installed: boolean } }

describe('POST /api/shopify/open', () => {
  it('sends an installed shop to the app inside its own admin', async () => {
    const { shop } = await installedShop();
    const response = await open({ shop });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { url: `https://${shop}/admin/apps/${env.shopifyApiKey}`, installed: true } });
  });

  it('finds the same shop however the address was typed', async () => {
    const { handle, shop } = await installedShop();
    for (const typed of [handle, shop.toUpperCase(), `https://${shop}/admin`, `admin.shopify.com/store/${handle}`]) {
      const { data } = (await (await open({ shop: typed })).json()) as Answer;
      assert.equal(data.installed, true, typed);
      assert.equal(data.url, `https://${shop}/admin/apps/${env.shopifyApiKey}`, typed);
    }
  });

  it('sends a shop that has not installed the app to Shopify’s install screen for this app', async () => {
    const response = await open({ shop: 'never-installed-store' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { url: `https://admin.shopify.com/store/never-installed-store/oauth/install?client_id=${env.shopifyApiKey}`, installed: false },
    });
  });

  it('treats a shop that uninstalled the app as one that has not installed it', async () => {
    const { handle } = await installedShop({ uninstalledAt: new Date() });
    const { data } = (await (await open({ shop: handle })).json()) as Answer;
    assert.equal(data.installed, false);
    assert.match(data.url, new RegExp(`^https://admin\\.shopify\\.com/store/${handle}/oauth/install\\?client_id=`));
  });

  it('only ever answers with an address on Shopify, whatever it is given', async () => {
    for (const typed of ['my-store', 'my-store.myshopify.com', 'admin.shopify.com/store/my-store', 'x'.repeat(60)]) {
      const { data } = (await (await open({ shop: typed })).json()) as Answer;
      const { protocol, hostname } = new URL(data.url);
      assert.equal(protocol, 'https:');
      assert.ok(hostname === 'admin.shopify.com' || hostname.endsWith('.myshopify.com'), data.url);
    }
  });

  it('refuses text that is not a store address, in words the visitor can act on', async () => {
    for (const typed of ['', 'www.some-brand.com', 'my-store.myshopify.com.evil.example', 'evil.example/my-store.myshopify.com']) {
      const response = await open({ shop: typed });
      assert.equal(response.status, 400, JSON.stringify(typed));
      const body = (await response.json()) as { error: string; code: string };
      assert.equal(body.code, 'SHOPIFY_SHOP_INVALID');
      assert.match(body.error, /my-store\.myshopify\.com/);
    }
  });

  it('refuses a body that is not exactly { shop }', async () => {
    for (const body of [{}, { shop: 5 }, { shop: ['a'] }, { shop: 'a'.repeat(301) }, { shop: 'my-store', redirect: 'https://evil.example' }]) {
      assert.equal((await open(body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  it('is anonymous, calls nothing on Shopify, and issues no session', async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      throw new Error(`must not contact Shopify: ${url}`);
    }) as typeof fetch;
    try {
      const { shop } = await installedShop();
      const response = await open({ shop });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null, 'no cookie is set');
      assert.equal(response.headers.get('authorization'), null);
      assert.deepEqual(Object.keys(((await response.json()) as Answer).data).sort(), ['installed', 'url']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('is rate limited per caller, and one caller’s burst does not lock out another', async () => {
    const noisy = '10.9.9.9';
    let limited: Response | null = null;
    let allowed = 0;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await open({ shop: 'rate-limit-probe' }, noisy);
      if (response.status === 429) limited = response;
      else allowed += 1;
    }
    assert.ok(limited, 'a burst of calls is eventually refused');
    assert.equal(allowed, 20, 'twenty a minute are allowed');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(((await limited.json()) as { code: string }).code, 'RATE_LIMITED');
    assert.equal((await open({ shop: 'rate-limit-probe' }, '10.9.9.10')).status, 200, 'someone else is unaffected');
  });
});
