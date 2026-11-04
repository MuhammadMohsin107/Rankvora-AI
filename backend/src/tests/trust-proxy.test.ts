// ─── Caller address behind the proxies (npm test) ────────────────────
// In production every request reaches the API from loopback (edge proxy → server.cjs → API). These
// tests run a real Express server and send real requests, so they show what the rate limiter would
// see — without a database, and without any stored or invented data: the only inputs are headers
// the test itself writes.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import express from 'express';
import { parseTrustProxy, type TrustProxySetting } from '../lib/trustProxy.js';
import { rateLimit } from '../middleware/rateLimit.js';

describe('TRUST_PROXY setting', () => {
  it('trusts loopback hops when unset or blank', () => {
    assert.equal(parseTrustProxy(undefined), 'loopback');
    assert.equal(parseTrustProxy(''), 'loopback');
    assert.equal(parseTrustProxy('   '), 'loopback');
  });

  it('reads false, a hop count, or an address list', () => {
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy(' 10.0.0.0/8, loopback '), '10.0.0.0/8, loopback');
  });

  it('refuses to trust every proxy header, which would let a caller pick their own bucket', () => {
    assert.throws(() => parseTrustProxy('true'), /TRUST_PROXY=true/);
  });
});

/** An API with one route that answers with the address Express attributes to the caller. */
async function serve(setting: TrustProxySetting, max = 1_000) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  app.post('/limited', rateLimit({ name: 'test:limited', windowMs: 60_000, max }), (_req, res) => res.json({ ok: true }));

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The address the server attributes to a caller whose proxies forwarded `forwardedFor`. */
async function addressSeenFor(base: string, forwardedFor: string): Promise<string> {
  const response = await fetch(`${base}/ip`, { headers: { 'X-Forwarded-For': forwardedFor } });
  return ((await response.json()) as { ip: string }).ip;
}

const servers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of servers) await close();
});

// RFC 5737 documentation addresses: reserved for examples, never a real host.
const CLIENT_A = '192.0.2.10';
const CLIENT_B = '192.0.2.20';
const SPOOFED = '198.51.100.99';

describe('caller address behind the proxies', () => {
  it('without trust proxy every caller is the loopback hop — the bug being fixed', async () => {
    const { base, close } = await serve(false);
    servers.push(close);

    const seen = new Set<string>();
    for (const client of [CLIENT_A, CLIENT_B]) {
      seen.add(await addressSeenFor(base, `${client}, 127.0.0.1`));
    }
    assert.equal(seen.size, 1, 'both callers collapsed to one address');
  });

  it('with the loopback default each caller keeps their own address', async () => {
    const { base, close } = await serve(parseTrustProxy(undefined));
    servers.push(close);

    assert.equal(await addressSeenFor(base, `${CLIENT_A}, 127.0.0.1`), CLIENT_A);
    assert.equal(await addressSeenFor(base, `${CLIENT_B}, 127.0.0.1`), CLIENT_B);
  });

  it('ignores an X-Forwarded-For the caller typed themselves', async () => {
    const { base, close } = await serve(parseTrustProxy(undefined));
    servers.push(close);

    // The caller prepends a forged address; the proxies append the real one after it.
    assert.equal(await addressSeenFor(base, `${SPOOFED}, ${CLIENT_A}, 127.0.0.1`), CLIENT_A);
  });

  it('gives each caller their own rate-limit allowance', async () => {
    const { base, close } = await serve(parseTrustProxy(undefined), 2);
    servers.push(close);

    const post = (client: string) =>
      fetch(`${base}/limited`, { method: 'POST', headers: { 'X-Forwarded-For': `${client}, 127.0.0.1` } });

    assert.equal((await post(CLIENT_A)).status, 200);
    assert.equal((await post(CLIENT_A)).status, 200);
    assert.equal((await post(CLIENT_A)).status, 429, 'the third request from one caller is refused');
    assert.equal((await post(CLIENT_B)).status, 200, 'another caller is unaffected');
  });
});
