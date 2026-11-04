// ─── Sign in with Shopify (npm test) ─────────────────────────────────
// Covers the pieces that decide whether a Shopify sign-in may become a session: which flow a state
// belongs to, that a state and a grant can never stand in for each other, that a grant only works
// with the nonce of the browser that started it, that request bodies are validated without
// disturbing what Shopify signed, and the launch-query HMAC. None of these touch the database — a
// rejected grant is refused before any account is read.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { env, shopifyConfigured } from '../config/env.js';
import {
  isShopifyLoginState,
  signShopifyLoginGrant,
  signShopifyLoginState,
  signShopifyState,
  verifyShopifyLoginGrant,
  verifyShopifyLoginState,
} from '../lib/jwt.js';
import type { RequestMetadata } from '../lib/requestMetadata.js';
import { ApiError } from '../middleware/error.js';
import { shopifyLoginLaunchSchema, shopifyLoginStartSchema } from '../schemas/shopify.schema.js';
import { authRouter } from '../routes/auth.js';
import { completeShopifyLogin, handleShopifyLoginCallback } from '../services/shopify-login.service.js';
import { missingScopes, verifyCallbackHmac } from '../services/shopify-oauth.service.js';

const NONCE = 'n'.repeat(43);
const OTHER_NONCE = 'm'.repeat(43);
const SHOP = 'my-store.myshopify.com';
const metadata: RequestMetadata = { ipAddress: null, userAgent: null };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const isLoginRejection = (error: unknown) => error instanceof ApiError && error.code === 'SHOPIFY_LOGIN_INVALID';

describe('shopify sign-in tokens', () => {
  it('round-trips the shop and nonce hash through the OAuth state', () => {
    const state = verifyShopifyLoginState(signShopifyLoginState(SHOP, sha256(NONCE)));
    assert.deepEqual(state, { shop: SHOP, nonceHash: sha256(NONCE) });
  });

  it('tells a sign-in state apart from a connect-a-store state', () => {
    assert.equal(isShopifyLoginState(signShopifyLoginState(SHOP, sha256(NONCE))), true);
    assert.equal(isShopifyLoginState(signShopifyState(1, 1, SHOP)), false);
    assert.equal(isShopifyLoginState('not-a-token'), false);
  });

  it('never accepts a state where a grant is expected, or the reverse', () => {
    assert.throws(() => verifyShopifyLoginGrant(signShopifyLoginState(SHOP, sha256(NONCE))));
    assert.throws(() => verifyShopifyLoginState(signShopifyLoginGrant(7, sha256(NONCE))));
  });
});

describe('completeShopifyLogin', () => {
  it('refuses a grant presented with a different browser nonce', async () => {
    const grant = signShopifyLoginGrant(7, sha256(NONCE));
    await assert.rejects(completeShopifyLogin(grant, OTHER_NONCE, metadata), isLoginRejection);
  });

  it('refuses a forged grant', async () => {
    await assert.rejects(completeShopifyLogin('forged.grant.value', NONCE, metadata), isLoginRejection);
  });

  it('refuses a sign-in state presented as a grant', async () => {
    const state = signShopifyLoginState(SHOP, sha256(NONCE));
    await assert.rejects(completeShopifyLogin(state, NONCE, metadata), isLoginRejection);
  });
});

describe('shopify sign-in request schemas', () => {
  it('normalises a typed store address', () => {
    const parsed = shopifyLoginStartSchema.parse({ shop: '  My-Store.MYSHOPIFY.com ', nonce: NONCE });
    assert.equal(parsed.shop, SHOP);
  });

  it('refuses an address that is not a myshopify domain', () => {
    assert.equal(shopifyLoginStartSchema.safeParse({ shop: 'mystore.com', nonce: NONCE }).success, false);
  });

  it('refuses a nonce that is not a base64url token', () => {
    assert.equal(shopifyLoginStartSchema.safeParse({ shop: SHOP, nonce: 'short' }).success, false);
    assert.equal(shopifyLoginStartSchema.safeParse({ shop: SHOP, nonce: `${'a'.repeat(40)}/+=` }).success, false);
  });

  it('forwards a launch query exactly as Shopify sent it', () => {
    const launch = { shop: SHOP, hmac: 'abc123', host: 'YWRtaW4uc2hvcGlmeS5jb20=', timestamp: '1789454288', locale: 'en-GB' };
    assert.deepEqual(shopifyLoginLaunchSchema.parse({ launch, nonce: NONCE }).launch, launch);
  });
});

describe('launch query HMAC', { skip: env.shopifyApiSecret ? false : 'SHOPIFY_API_SECRET is not set' }, () => {
  const sign = (query: Record<string, string>) =>
    createHmac('sha256', env.shopifyApiSecret!)
      .update(
        Object.keys(query)
          .sort()
          .map((key) => `${key}=${query[key]}`)
          .join('&'),
      )
      .digest('hex');

  it('accepts the query Shopify signed', () => {
    const query = { host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXktc3RvcmU', shop: SHOP, timestamp: '1789454288' };
    assert.equal(verifyCallbackHmac({ ...query, hmac: sign(query) }), true);
  });

  it('rejects the same signature over a different shop', () => {
    const query = { host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXktc3RvcmU', shop: SHOP, timestamp: '1789454288' };
    assert.equal(verifyCallbackHmac({ ...query, shop: 'someone-else.myshopify.com', hmac: sign(query) }), false);
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

describe('sign-in routes', () => {
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

  it('has exactly the Shopify sign-in routes, refresh and logout — nothing else can start a session', () => {
    // `/shopify/embedded` is the embedded app's entry (shopify-embedded.service.ts). It is listed
    // because it is a route, not because it starts a session: it issues no token and sets nothing —
    // the response is the account and the shop, and every request after it proves itself again with
    // a fresh Shopify ID token (asserted in shopify-embedded.test.ts, "issues no session").
    assert.deepEqual([...paths].sort(), ['/logout', '/refresh', '/shopify/complete', '/shopify/embedded', '/shopify/launch', '/shopify/start']);
  });
});

describe('Shopify sign-in callback', { skip: shopifyConfigured() ? false : 'Shopify app credentials are not set' }, () => {
  const signed = (query: Record<string, string>) => {
    const message = Object.keys(query).sort().map((key) => `${key}=${query[key]}`).join('&');
    return { ...query, hmac: createHmac('sha256', env.shopifyApiSecret!).update(message).digest('hex') };
  };
  const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

  it('refuses a return that Shopify did not sign', async () => {
    const query = { shop: SHOP, code: 'abc', state: signShopifyLoginState(SHOP, sha256(NONCE)), timestamp: '1789454288', hmac: 'forged' };
    await assert.rejects(handleShopifyLoginCallback(query), hasCode('SHOPIFY_HMAC_INVALID'));
  });

  it('refuses a return for a different store than the sign-in started with', async () => {
    const query = signed({ shop: SHOP, code: 'abc', state: signShopifyLoginState('someone-else.myshopify.com', sha256(NONCE)), timestamp: '1789454288' });
    await assert.rejects(handleShopifyLoginCallback(query), hasCode('SHOPIFY_STATE_MISMATCH'));
  });

  it('refuses a return whose state is not a sign-in state', async () => {
    const query = signed({ shop: SHOP, code: 'abc', state: signShopifyState(1, 1, SHOP), timestamp: '1789454288' });
    await assert.rejects(handleShopifyLoginCallback(query), hasCode('SHOPIFY_STATE_INVALID'));
  });
});
