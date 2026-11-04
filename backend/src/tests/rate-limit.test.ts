// ─── IP-keyed rate limit ─────────────────────────────────────────────
//
// No database is touched. The default key is the caller's IP alone, so a sweep that changes the
// email on every request still shares one bucket per network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { ApiError } from '../middleware/error.js';

function mockRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) { headers[name] = value; },
  };
}

/** Runs the middleware once and returns whatever it passed to `next`. */
function callLimiter(
  middleware: ReturnType<typeof rateLimit>,
  req: { ip?: string; body?: unknown },
): unknown {
  let forwarded: unknown = 'not called';
  middleware(req as Request, mockRes() as unknown as Response, (error?: unknown) => { forwarded = error; });
  return forwarded;
}

describe('IP-keyed rate limit', () => {
  const limiterFor = () => rateLimit({ name: 'test:ip-keyed', windowMs: 60 * 60 * 1000, max: 10, message: 'Too many.' });

  it('lets a request through under the limit', () => {
    assert.equal(callLimiter(limiterFor(), { ip: '203.0.113.7', body: { email: 'ada@example.com' } }), undefined);
  });

  it('counts different addresses from one network against the same bucket', () => {
    const middleware = limiterFor();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const forwarded = callLimiter(middleware, { ip: '203.0.113.7', body: { email: `probe-${attempt}@example.com` } });
      assert.equal(forwarded, undefined, `attempt ${attempt + 1} should be allowed`);
    }

    const blocked = callLimiter(middleware, { ip: '203.0.113.7', body: { email: 'probe-11@example.com' } });
    assert.ok(blocked instanceof ApiError);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.code, 'RATE_LIMITED');
  });

  it('does not let one network exhaust another network’s allowance', () => {
    const middleware = limiterFor();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      callLimiter(middleware, { ip: '203.0.113.7', body: { email: `probe-${attempt}@example.com` } });
    }
    assert.equal(callLimiter(middleware, { ip: '198.51.100.4', body: { email: 'ada@example.com' } }), undefined);
  });
});
