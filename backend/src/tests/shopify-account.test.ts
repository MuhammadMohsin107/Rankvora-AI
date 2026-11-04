// ─── Shopify accounts: what stays routed, what is signed, and how a connect returns (npm test) ───
// Sign-in is Shopify only and happens by ID token (shopify-embedded.test.ts covers that). What this
// file pins down is everything around it that must not change by accident:
//   • the permission check, which decides whether a shop may be opened at all;
//   • Shopify's HMAC over a callback query;
//   • the API's auth routes — exactly one, with no way back to email, passwords, a second factor, a
//     refresh token or a stored session;
//   • the connect-a-store callback, which is a browser redirect and so must END in a page, with a
//     reason code, whatever went wrong — and must carry the merchant back into their Shopify admin.
// None of it needs a database: every refusal here happens before an account is read.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.SHOPIFY_API_KEY ??= 'test-client-id';
process.env.SHOPIFY_API_SECRET ??= 'test-client-secret';
process.env.BACKEND_URL ??= 'http://localhost:5000';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

const { default: express } = await import('express');
const { env } = await import('../config/env.js');
const { signShopifyState } = await import('../lib/jwt.js');
const { requestLog } = await import('../middleware/requestLog.js');
const { authRouter } = await import('../routes/auth.js');
const { shopifyRouter } = await import('../routes/shopify.js');
const { missingScopes, verifyCallbackHmac } = await import('../services/shopify-oauth.service.js');

const SHOP = 'my-store.myshopify.com';
const OTHER_SHOP = 'another-test-shop.myshopify.com';

/** The query Shopify would send, signed the way Shopify signs it. */
function signedQuery(fields: Record<string, string>): URLSearchParams {
  const message = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('&');
  const hmac = createHmac('sha256', env.shopifyApiSecret!).update(message).digest('hex');
  return new URLSearchParams({ ...fields, hmac });
}

describe('Shopify callback query HMAC', () => {
  const query = { host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXktc3RvcmU', shop: SHOP, timestamp: '1789454288' };

  it('accepts the query Shopify signed', () => {
    assert.equal(verifyCallbackHmac({ ...query, hmac: signedQuery(query).get('hmac')! }), true);
  });

  it('rejects the same signature over a different shop', () => {
    assert.equal(verifyCallbackHmac({ ...query, shop: OTHER_SHOP, hmac: signedQuery(query).get('hmac')! }), false);
  });

  it('rejects a query with no signature at all', () => {
    assert.equal(verifyCallbackHmac(query), false);
  });
});

describe('required Shopify permissions', () => {
  const ALL = 'read_products,read_content,read_themes,read_metaobjects,read_legal_policies,read_online_store_navigation,write_products,write_content';

  it('accepts a grant that covers every requested scope', () => {
    assert.deepEqual(missingScopes(ALL), []);
  });

  it('counts a write scope as covering its read scope', () => {
    const writeOnly = 'read_themes,read_metaobjects,read_legal_policies,read_online_store_navigation,write_products,write_content';
    assert.deepEqual(missingScopes(writeOnly), []);
  });

  it('names every scope the merchant did not grant', () => {
    assert.deepEqual(missingScopes('read_products,read_content'), [
      'read_themes',
      'read_metaobjects',
      'read_legal_policies',
      'read_online_store_navigation',
      'write_products',
      'write_content',
    ]);
  });

  it('treats an empty grant as missing everything', () => {
    assert.equal(missingScopes('').length, ALL.split(',').length);
  });
});

describe('the auth routes', () => {
  const paths = authRouter.stack
    .map((layer) => (layer as { route?: { path?: string } }).route?.path)
    .filter((path): path is string => typeof path === 'string');

  it('offers no email sign-up, password sign-in, password reset or email verification', () => {
    for (const removed of ['/signup', '/login', '/forgot-password', '/verify-reset-code', '/reset-password', '/verify-email', '/resend-verification']) {
      assert.equal(paths.includes(removed), false, `${removed} must not be routed`);
    }
  });

  it('offers no second factor: no sign-in code, no recovery code, no resend', () => {
    for (const removed of ['/login/2fa', '/login/2fa/send', '/login/2fa/resend']) {
      assert.equal(paths.includes(removed), false, `${removed} must not be routed`);
    }
  });

  it('offers no redirect sign-in, refresh token or logout: the app issues no session of its own', () => {
    for (const removed of ['/shopify/start', '/shopify/launch', '/shopify/complete', '/refresh', '/logout']) {
      assert.equal(paths.includes(removed), false, `${removed} must not be routed`);
    }
  });

  it('has exactly one route: the embedded app’s entry', () => {
    // It issues no token and sets nothing — the response is the account and the shop, and every
    // request after it proves itself again with a fresh Shopify ID token (shopify-embedded.test.ts,
    // "issues no session").
    assert.deepEqual(paths, ['/shopify/embedded']);
  });
});

describe('the connect-a-store callback', () => {
  let base = '';
  let server: import('node:http').Server;

  before(async () => {
    const app = express();
    app.use(requestLog);
    app.use('/api/shopify', shopifyRouter);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** Calls the callback and returns where it sent the browser. */
  async function callback(query: URLSearchParams) {
    const response = await fetch(`${base}/api/shopify/callback?${query}`, { redirect: 'manual' });
    assert.equal(response.status, 302, 'the callback answers a browser with a redirect, never a JSON error');
    return new URL(response.headers.get('location')!);
  }

  const state = (shop = SHOP) => signShopifyState(7, 7, shop);
  const siteIntegrations = () => new URL('/integrations', env.frontendUrl);

  it('reports a cancelled authorization as cancelled, not as an error', async () => {
    const location = await callback(new URLSearchParams({ error: 'access_denied', state: state() }));
    assert.equal(location.origin + location.pathname, siteIntegrations().toString());
    assert.equal(location.searchParams.get('shopify'), 'cancelled');
    assert.equal(location.searchParams.get('reason'), 'access_denied');
  });

  it('reports any other refusal from Shopify as a failure with its reason', async () => {
    const location = await callback(new URLSearchParams({ error: 'invalid_scope', state: state() }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'invalid_scope');
  });

  it('never repeats an unexpected value in the reason', async () => {
    const location = await callback(new URLSearchParams({ error: '<script>alert(1)</script>', state: state() }));
    assert.equal(location.searchParams.get('reason'), 'failed');
  });

  it('reports a return missing its parts as an incomplete callback', async () => {
    const location = await callback(new URLSearchParams({ shop: SHOP, state: state() }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'invalid_callback');
  });

  it('refuses a return Shopify did not sign', async () => {
    const location = await callback(new URLSearchParams({ shop: SHOP, code: 'c', state: state(), timestamp: '1', hmac: 'f'.repeat(64) }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'SHOPIFY_HMAC_INVALID');
  });

  it('refuses a signed return for a different store than the connect began with', async () => {
    const location = await callback(signedQuery({ shop: OTHER_SHOP, code: 'c', state: state(), timestamp: '1' }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'SHOPIFY_STATE_MISMATCH');
  });

  it('refuses a signed return whose state is not one this app made', async () => {
    const location = await callback(signedQuery({ shop: SHOP, code: 'c', state: 'forged.state.value', timestamp: '1' }));
    assert.equal(location.searchParams.get('reason'), 'SHOPIFY_STATE_INVALID');
  });

  it('brings the merchant back into their Shopify admin, not to the bare site', async () => {
    // They left the admin to reach Shopify's permission screen; the bare site has no session and
    // nothing to show outside the admin's iframe.
    const location = await callback(signedQuery({ shop: SHOP, code: 'c', state: state(OTHER_SHOP), timestamp: '1' }));
    assert.equal(location.origin, `https://${SHOP}`);
    assert.equal(location.pathname, `/admin/apps/${env.shopifyApiKey}/integrations`);
    assert.equal(location.searchParams.get('shopify'), 'failed');
  });

  it('only ever names a real myshopify.com shop when it does that', async () => {
    const location = await callback(new URLSearchParams({ error: 'access_denied', shop: 'evil.example.com', state: state() }));
    assert.equal(location.origin, new URL(env.frontendUrl).origin, 'an address that is not a shop is ignored');
  });

  it('puts no session and no grant on a failed return', async () => {
    const location = await callback(new URLSearchParams({ error: 'access_denied', state: state() }));
    assert.equal(location.hash, '');
    assert.equal(location.searchParams.has('shopify_grant'), false);
  });
});
