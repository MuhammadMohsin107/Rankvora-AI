// ─── Rate limits counted in a shared store (npm test) ────────────────
// On Cloudflare, middleware/rateLimit.ts counts in a store every copy of the Worker shares (a Durable
// Object). Here that store is a stand-in with the same fixed-window rule, so what is proved is the
// middleware's side: which name and key it counts, when it refuses, and what it does if the store
// fails. No database, no network, no stored data.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { rateLimit, useSharedRateLimitStore, withinLimit, type SharedRateLimitStore } from '../middleware/rateLimit.js';
import { ApiError } from '../middleware/error.js';

/** The same rule the Durable Object applies, in a Map, recording every call. */
function fakeStore() {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const calls: Array<{ name: string; key: string; windowMs: number }> = [];
  const store: SharedRateLimitStore = {
    async hit(name, key, windowMs) {
      calls.push({ name, key, windowMs });
      const id = `${name}|${key}`;
      const now = Date.now();
      const current = windows.get(id);
      const next = !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
      windows.set(id, next);
      return next;
    },
  };
  return { store, calls };
}

/** Runs the middleware and resolves with what it passed to `next`, plus the headers it set. */
function run(middleware: ReturnType<typeof rateLimit>, req: { ip?: string; body?: unknown }) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => { headers[name] = value; } };
  return new Promise<{ forwarded: unknown; headers: Record<string, string> }>((resolve) => {
    middleware(req as Request, res as unknown as Response, (error?: unknown) => resolve({ forwarded: error, headers }));
  });
}

afterEach(() => useSharedRateLimitStore(null));

describe('rate limit with a shared store', () => {
  it('counts under the limiter name and caller key, and refuses past the limit with Retry-After', async () => {
    const { store, calls } = fakeStore();
    useSharedRateLimitStore(store);
    const limiter = rateLimit({ name: 'auth:shopify-complete', windowMs: 15 * 60_000, max: 3 });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal((await run(limiter, { ip: '203.0.113.7' })).forwarded, undefined, `attempt ${attempt} allowed`);
    }
    const blocked = await run(limiter, { ip: '203.0.113.7' });
    assert.ok(blocked.forwarded instanceof ApiError);
    assert.equal(blocked.forwarded.statusCode, 429);
    assert.equal(blocked.forwarded.code, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers['Retry-After']) > 0 && Number(blocked.headers['Retry-After']) <= 900);

    assert.deepEqual(calls[0], { name: 'auth:shopify-complete', key: '203.0.113.7', windowMs: 15 * 60_000 });
  });

  it('keeps two limiters apart even for the same caller', async () => {
    const { store } = fakeStore();
    useSharedRateLimitStore(store);
    const send = rateLimit({ name: 'auth:shopify-start', windowMs: 60_000, max: 1 });
    const verify = rateLimit({ name: 'auth:shopify-complete', windowMs: 60_000, max: 1 });

    assert.equal((await run(send, { ip: '203.0.113.7' })).forwarded, undefined);
    assert.equal((await run(verify, { ip: '203.0.113.7' })).forwarded, undefined, 'its own allowance');
    assert.ok((await run(send, { ip: '203.0.113.7' })).forwarded instanceof ApiError);
  });

  it('shares one count across copies — two limiter objects with the same name', async () => {
    // Each copy of the Worker builds its own middleware; the name is what makes them one allowance.
    const { store } = fakeStore();
    useSharedRateLimitStore(store);
    const copyA = rateLimit({ name: 'auth:shopify-start', windowMs: 60_000, max: 1 });
    const copyB = rateLimit({ name: 'auth:shopify-start', windowMs: 60_000, max: 1 });

    assert.equal((await run(copyA, { ip: '198.51.100.4' })).forwarded, undefined);
    assert.ok((await run(copyB, { ip: '198.51.100.4' })).forwarded instanceof ApiError);
  });

  it('lets the request through, and logs, when the store cannot be reached', async () => {
    useSharedRateLimitStore({ hit: async () => { throw new Error('durable object unavailable'); } });
    const limiter = rateLimit({ name: 'auth:shopify-start', windowMs: 60_000, max: 1 });
    assert.equal((await run(limiter, { ip: '203.0.113.7' })).forwarded, undefined);
  });
});

describe('withinLimit (limits not tied to a route)', () => {
  it('uses the shared store when there is one', async () => {
    const { store, calls } = fakeStore();
    useSharedRateLimitStore(store);
    const results: boolean[] = [];
    for (let i = 0; i < 3; i += 1) results.push(await withinLimit('client-errors', 'user:7', 600_000, 2, () => true));
    assert.deepEqual(results, [true, true, false]);
    assert.deepEqual(calls[0], { name: 'client-errors', key: 'user:7', windowMs: 600_000 });
  });

  it('uses the caller’s own in-memory check when there is no shared store', async () => {
    let asked = 0;
    assert.equal(await withinLimit('client-errors', 'user:7', 600_000, 2, () => { asked += 1; return false; }), false);
    assert.equal(asked, 1);
  });

  it('allows when the store cannot be reached', async () => {
    useSharedRateLimitStore({ hit: async () => { throw new Error('durable object unavailable'); } });
    assert.equal(await withinLimit('client-errors', 'user:7', 600_000, 2, () => false), true);
  });
});
