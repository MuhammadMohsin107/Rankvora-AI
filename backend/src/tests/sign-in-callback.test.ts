// ─── Shopify sign-in: how a failed return is reported (npm test) ─────
// Drives the REAL callback route (shopifyRouter, the real controller and services) over HTTP, for
// the failures that are decided before any database is read: a cancelled authorization, a malformed
// return, a return Shopify did not sign, and a return for a different store than the sign-in began
// with. Nothing here needs a database or Shopify, and nothing is stored or invented — the signature and
// the signed state are computed in the test from the app's own secrets, exactly as Shopify and the
// start endpoint would.
//
// What it proves: each failure ends as a REDIRECT back to the sign-in page (a browser is
// navigating, so a JSON error would strand the merchant on a blank API response), with a reason
// code the page can word, and with a reference that ties the screen to the log line.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

process.env.SHOPIFY_API_KEY ??= 'test-client-id';
process.env.SHOPIFY_API_SECRET ??= 'test-client-secret';
process.env.BACKEND_URL ??= 'http://localhost:5000';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);

const { default: express } = await import('express');
const { env } = await import('../config/env.js');
const { signShopifyLoginState } = await import('../lib/jwt.js');
const { requestLog } = await import('../middleware/requestLog.js');
const { shopifyRouter } = await import('../routes/shopify.js');
const { shopifyReportedReason, signInFailureReason } = await import('../lib/signInFailure.js');
const { ApiError } = await import('../middleware/error.js');
const { StoreDataError } = await import('../audit-engine/store-data/types.js');

const SHOP = 'sign-in-callback-test.myshopify.com';
const OTHER_SHOP = 'another-test-shop.myshopify.com';
const nonceHash = createHash('sha256').update('n'.repeat(43)).digest('hex');

/** The query string Shopify would send, signed the way Shopify signs it. */
function signedQuery(fields: Record<string, string>): URLSearchParams {
  const message = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('&');
  const hmac = createHmac('sha256', env.shopifyApiSecret!).update(message).digest('hex');
  return new URLSearchParams({ ...fields, hmac });
}

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
  const location = new URL(response.headers.get('location')!);
  return { location, requestId: response.headers.get('x-request-id') };
}

describe('Shopify sign-in callback — failures end back on the sign-in page', () => {
  const loginState = () => signShopifyLoginState(SHOP, nonceHash);

  it('reports a cancelled authorization as cancelled, not as an error', async () => {
    const { location, requestId } = await callback(new URLSearchParams({ error: 'access_denied', state: loginState() }));
    assert.equal(location.origin + location.pathname, new URL('/login', env.frontendUrl).toString());
    assert.equal(location.searchParams.get('shopify'), 'cancelled');
    assert.equal(location.searchParams.get('reason'), 'access_denied');
    assert.equal(location.searchParams.get('ref'), requestId, 'the page can quote the id of the log line');
  });

  it('reports any other refusal from Shopify as a failure with its reason', async () => {
    const { location } = await callback(new URLSearchParams({ error: 'invalid_scope', state: loginState() }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'invalid_scope');
  });

  it('never repeats an unexpected value in the reason', async () => {
    const { location } = await callback(new URLSearchParams({ error: '<script>alert(1)</script>', state: loginState() }));
    assert.equal(location.searchParams.get('reason'), 'failed');
  });

  it('reports a return missing its parts as an incomplete callback', async () => {
    const { location } = await callback(new URLSearchParams({ shop: SHOP, state: loginState() }));
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'invalid_callback');
  });

  it('refuses a return Shopify did not sign', async () => {
    const query = new URLSearchParams({ shop: SHOP, code: 'c', state: loginState(), timestamp: '1', hmac: 'f'.repeat(64) });
    const { location } = await callback(query);
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'SHOPIFY_HMAC_INVALID');
  });

  it('refuses a signed return for a different store than the sign-in began with', async () => {
    const query = signedQuery({ shop: OTHER_SHOP, code: 'c', state: loginState(), timestamp: '1' });
    const { location } = await callback(query);
    assert.equal(location.searchParams.get('shopify'), 'failed');
    assert.equal(location.searchParams.get('reason'), 'SHOPIFY_STATE_MISMATCH');
  });

  it('puts no session and no grant on a failed return', async () => {
    const { location } = await callback(new URLSearchParams({ error: 'access_denied', state: loginState() }));
    assert.equal(location.hash, '');
    assert.equal(location.searchParams.has('shopify_grant'), false);
  });
});

describe('sign-in failure reasons', () => {
  it('uses the code a deliberate refusal carries', () => {
    assert.equal(signInFailureReason(new ApiError(403, 'x', 'SHOPIFY_SCOPES_MISSING')), 'SHOPIFY_SCOPES_MISSING');
  });

  it('names a failed read of the shop after approval', () => {
    assert.equal(signInFailureReason(new StoreDataError('RATE_LIMITED', 'x', true)), 'SHOPIFY_READ_FAILED');
  });

  it('reports anything unexpected as a fault on our side', () => {
    assert.equal(signInFailureReason(new Error('connect ECONNREFUSED')), 'login_failed');
  });

  it('keeps only a plain token from Shopify’s own error', () => {
    assert.equal(shopifyReportedReason('access_denied'), 'access_denied');
    assert.equal(shopifyReportedReason(['a', 'b']), 'failed');
    assert.equal(shopifyReportedReason('x'.repeat(65)), 'failed');
    assert.equal(shopifyReportedReason(undefined), 'failed');
  });
});
