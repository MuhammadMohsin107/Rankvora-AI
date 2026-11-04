// ─── Shopify ID tokens (npm test) ────────────────────────────────────
// The embedded app proves who is calling with a JWT Shopify signs and App Bridge attaches to every
// request. These tests mint tokens exactly as Shopify does — HS256, signed with the app's client
// secret, `aud` the client id, `iss` and `dest` naming one shop — and check what is accepted and,
// more importantly, what is refused. A token that gets through here is a request that is treated as
// coming from a merchant's admin, so every way of forging or mis-using one is covered.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

const { env } = await import('../config/env.js');
const { ShopifyIdTokenError, looksLikeShopifyIdToken, verifyShopifyIdToken } = await import('../lib/shopify-id-token.js');

const SHOP = 'id-token-test.myshopify.com';

/** A token shaped like the session tokens this app used to issue — a numeric subject, no `dest`. */
const ownToken = () => jwt.sign({ sub: 7, type: 'access' }, env.jwtAccessSecret, { expiresIn: '15m' });

/** A token as Shopify issues it, with any field overridable. */
function shopifyToken(overrides: Record<string, unknown> = {}, secret = env.shopifyApiSecret!, options: jwt.SignOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: `https://${SHOP}/admin`,
      dest: `https://${SHOP}`,
      aud: env.shopifyApiKey,
      sub: '42',
      exp: now + 60,
      nbf: now - 5,
      iat: now - 5,
      jti: 'test-jti',
      sid: 'test-session',
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', ...options },
  );
}

describe('verifyShopifyIdToken', () => {
  it('accepts a token Shopify signed for this app, and returns the shop and staff member', () => {
    assert.deepEqual(verifyShopifyIdToken(shopifyToken()), { shop: SHOP, staffId: '42' });
  });

  it('accepts a token with no staff id', () => {
    assert.equal(verifyShopifyIdToken(shopifyToken({ sub: undefined })).staffId, null);
  });

  it('refuses a token signed with any other secret', () => {
    assert.throws(() => verifyShopifyIdToken(shopifyToken({}, 'not-the-client-secret')), ShopifyIdTokenError);
  });

  it('refuses a token issued to a different app', () => {
    assert.throws(() => verifyShopifyIdToken(shopifyToken({ aud: 'some-other-client-id' })), ShopifyIdTokenError);
  });

  it('refuses an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.throws(() => verifyShopifyIdToken(shopifyToken({ exp: past + 30, nbf: past - 60, iat: past - 60 })), ShopifyIdTokenError);
  });

  it('refuses a token that is not valid yet', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    assert.throws(() => verifyShopifyIdToken(shopifyToken({ nbf: future, exp: future + 60 })), ShopifyIdTokenError);
  });

  it('refuses a token whose issuer and destination are different shops', () => {
    assert.throws(() => verifyShopifyIdToken(shopifyToken({ iss: 'https://someone-else.myshopify.com/admin' })), ShopifyIdTokenError);
  });

  it('refuses a destination that is not a myshopify.com shop, even when issuer and destination agree', () => {
    const token = shopifyToken({ iss: 'https://evil.example.com/admin', dest: 'https://evil.example.com' });
    assert.throws(() => verifyShopifyIdToken(token), ShopifyIdTokenError);
  });

  it('refuses a destination that only ends in .myshopify.com by trickery', () => {
    const token = shopifyToken({ iss: 'https://evil.com/.myshopify.com', dest: 'https://evil.com/.myshopify.com' });
    assert.throws(() => verifyShopifyIdToken(token), ShopifyIdTokenError);
  });

  it('refuses a token with no destination', () => {
    assert.throws(() => verifyShopifyIdToken(shopifyToken({ dest: undefined })), ShopifyIdTokenError);
  });

  it('refuses an unsigned token (alg: none)', () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = jwt.sign({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: env.shopifyApiKey, exp: now + 60 }, '', { algorithm: 'none' });
    assert.throws(() => verifyShopifyIdToken(unsigned), ShopifyIdTokenError);
  });

  it('refuses a token signed with a different algorithm, even with the right secret', () => {
    assert.throws(() => verifyShopifyIdToken(shopifyToken({}, env.shopifyApiSecret!, { algorithm: 'HS512' })), ShopifyIdTokenError);
  });

  it('refuses garbage', () => {
    for (const junk of ['', 'abc', 'a.b.c', 'Bearer x']) assert.throws(() => verifyShopifyIdToken(junk), ShopifyIdTokenError);
  });

  it('refuses a token signed with this app’s own secret — the two are not interchangeable', () => {
    assert.throws(() => verifyShopifyIdToken(ownToken()), ShopifyIdTokenError);
  });
});

describe('looksLikeShopifyIdToken', () => {
  it('recognises the shape of a Shopify ID token, without trusting it', () => {
    assert.equal(looksLikeShopifyIdToken(shopifyToken()), true);
    // The shape only: a forged token looks right and is then refused by verifyShopifyIdToken.
    assert.equal(looksLikeShopifyIdToken(shopifyToken({}, 'forged')), true);
  });

  it('does not mistake a token of this app’s own shape for one', () => {
    assert.equal(looksLikeShopifyIdToken(ownToken()), false);
  });

  it('does not mistake garbage for one', () => {
    assert.equal(looksLikeShopifyIdToken('not-a-jwt'), false);
    assert.equal(looksLikeShopifyIdToken(''), false);
  });
});
