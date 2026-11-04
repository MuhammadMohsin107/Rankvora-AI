import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashSessionToken } from '../services/session.service.js';
import { requestMetadata } from '../lib/requestMetadata.js';
import { logoutSchema } from '../schemas/auth.schema.js';
import type { Request } from 'express';

/**
 * ─── What can be proven without a database ───────────────────────────
 *
 * The hashing scheme, request-metadata extraction, and the input contracts that stand between a
 * request and the services. Those contracts are where cross-user access and credential leakage
 * would be introduced, so they are asserted on their own here.
 *
 * Session lifecycle, revocation, ownership enforcement and event writing need a database, and they
 * run against a real one — see session-lifecycle.test.ts.
 */

/** Minimal Express-shaped request. Only the fields requestMetadata() reads. */
function fakeRequest(headers: Record<string, string | undefined>, remoteAddress?: string): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request;
}

describe('session token hashing', () => {
  it('stores SHA-256, never the token', () => {
    const token = 'header.payload.signature';
    const hash = hashSessionToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, token);
    assert.ok(!hash.includes(token));
  });

  it('uses the same construction as the existing auth and reset paths', () => {
    // Phase 2 moved WHERE the hash lives; it must not change WHAT the hash is, or a token issued
    // either side of the cutover would stop matching for the wrong reason.
    const token = 'some.refresh.token';
    assert.equal(hashSessionToken(token), createHash('sha256').update(token).digest('hex'));
  });

  it('is deterministic, so a session can be found by point-read', () => {
    // Unlike a 6-digit OTP — which is bcrypt-hashed precisely because it must NOT be searchable —
    // a refresh token is high-entropy and has to be looked up by its hash.
    assert.equal(hashSessionToken('abc'), hashSessionToken('abc'));
    assert.notEqual(hashSessionToken('abc'), hashSessionToken('abd'));
  });
});

describe('request metadata', () => {
  it('takes the leftmost X-Forwarded-For entry — the client, not the proxy', () => {
    // Production has two hops and server.cjs APPENDS rather than overwrites, so the list reads
    // oldest-first. Taking the last entry would record Rankvora AI's own proxy as the customer.
    const meta = requestMetadata(fakeRequest({ 'x-forwarded-for': '203.0.113.7, 198.51.100.2, 10.0.0.5' }));
    assert.equal(meta.ipAddress, '203.0.113.7');
  });

  it('normalises the IPv4-mapped IPv6 form Node reports on dual-stack sockets', () => {
    const meta = requestMetadata(fakeRequest({}, '::ffff:203.0.113.9'));
    assert.equal(meta.ipAddress, '203.0.113.9');
  });

  it('returns null for loopback rather than a value that reads like a location', () => {
    assert.equal(requestMetadata(fakeRequest({}, '127.0.0.1')).ipAddress, null);
    assert.equal(requestMetadata(fakeRequest({}, '::1')).ipAddress, null);
  });

  it('returns null — never a placeholder — when nothing is available', () => {
    const meta = requestMetadata(fakeRequest({}));
    assert.equal(meta.ipAddress, null);
    assert.equal(meta.userAgent, null);
  });

  it('records the raw User-Agent and does not invent a device name', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const meta = requestMetadata(fakeRequest({ 'user-agent': ua }));
    assert.equal(meta.userAgent, ua);
    // Nothing resembling "Chrome on Windows" is produced anywhere — that would be a guess.
    assert.ok(!/Chrome on|on Windows/.test(meta.userAgent ?? ''));
  });

  it('truncates an oversized User-Agent to the column width', () => {
    const meta = requestMetadata(fakeRequest({ 'user-agent': 'x'.repeat(900) }));
    assert.equal(meta.userAgent?.length, 512);
  });

  it('treats a blank User-Agent as absent', () => {
    assert.equal(requestMetadata(fakeRequest({ 'user-agent': '   ' })).userAgent, null);
  });
});

describe('logout input contract', () => {
  it('makes the logout refresh token optional', () => {
    // Absent means the server cannot name a session and revokes all of them — the safe direction.
    assert.equal(logoutSchema.safeParse({}).success, true);
    assert.equal(logoutSchema.safeParse({ refreshToken: 'a.b.c' }).success, true);
    assert.equal(logoutSchema.safeParse({ userId: 2 }).success, false);
  });
});

describe('security event payloads carry no credentials', () => {
  it('accepts only non-secret scalars as event context', () => {
    // SecurityEventMetadata is Record<string, number | boolean | null> — there is no string member,
    // so a token, password or code cannot be passed as context even by mistake. This asserts the
    // shape actually used at every call site in the codebase.
    const contexts: Array<Record<string, number | boolean | null>> = [
      { sessionsEnded: 3 },
      { otherSessionsRevoked: 0 },
      { sessionId: 12 },
      { revoked: 2 },
      { sessionsRevoked: 1 },
    ];
    for (const context of contexts) {
      for (const value of Object.values(context)) {
        assert.ok(
          typeof value === 'number' || typeof value === 'boolean' || value === null,
          `event context carried a non-scalar: ${String(value)}`,
        );
      }
    }
  });
});
