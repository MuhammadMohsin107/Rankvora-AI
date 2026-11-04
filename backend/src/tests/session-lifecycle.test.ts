// ─── Sessions, refresh, logout and the security log (npm test) ───────
// What a signed-in device is worth, end to end, on the same SQLite engine D1 is built on: a session
// stores only a hash of its token; a refresh token works once and a replay is refused; a session
// ends when its store is gone; signing out ends one device or all of them; and the log of all this
// records only what actually happened. Tokens are real signed JWTs. Every row is the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';

await import('./helpers/database.js');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { securityEvents, shopifyConnections, stores, userSessions, users } = await import('../db/schema.js');
const { refreshTokenTtlMs, signRefreshToken } = await import('../lib/jwt.js');
const { ApiError } = await import('../middleware/error.js');
const { logout, refresh } = await import('../services/auth.service.js');
const { recordSecurityEvent } = await import('../services/security-event.service.js');
const { createSession, hashSessionToken, revokeSessionByToken, rotateSession } = await import('../services/session.service.js');

const device = { ipAddress: '203.0.113.20', userAgent: 'session-lifecycle test' };
const noDevice = { ipAddress: null, userAgent: null };
const later = () => new Date(Date.now() + refreshTokenTtlMs());

let counter = 0;
async function account(options: { connected?: 'installed' | 'uninstalled' | 'none' } = {}) {
  counter += 1;
  const user = await insertReturning(users, { fullName: 'Test', email: `session${counter}@example.com`, passwordHash: 'x' });
  const store = await insertReturning(stores, {
    ownerId: user.id, workspaceName: 'W', name: `Store ${counter}`, url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  });
  const connected = options.connected ?? 'installed';
  if (connected !== 'none') {
    await db.insert(shopifyConnections).values({
      storeId: store.id, shopDomain: `session-${counter}.myshopify.com`, accessTokenEncrypted: 'x', scope: 'read_products',
      uninstalledAt: connected === 'uninstalled' ? new Date() : null,
    });
  }
  return { user, store };
}

/** A signed-in device: a real refresh token and the session row that goes with it. */
async function signedIn(userId: number) {
  const token = signRefreshToken(userId);
  await createSession(userId, token, later(), device);
  return token;
}

const sessionsOf = (userId: number) => db.select().from(userSessions).where(eq(userSessions.userId, userId));
const liveSessionsOf = (userId: number) => db.select().from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
const eventsOf = (userId: number) => db.select().from(securityEvents).where(eq(securityEvents.userId, userId));
const refusedWith = (code: string) => (error: unknown) => error instanceof ApiError && error.statusCode === 401 && error.code === code;

describe('a session', () => {
  it('keeps a hash of the refresh token, never the token, and the real device details', async () => {
    const { user } = await account();
    const token = await signedIn(user.id);

    const [row] = await sessionsOf(user.id);

    assert.equal(row?.tokenHash, hashSessionToken(token));
    assert.notEqual(row?.tokenHash, token);
    assert.equal(row?.ipAddress, device.ipAddress);
    assert.equal(row?.userAgent, device.userAgent);
    assert.equal(row?.revokedAt, null);
  });

  it('records no device details it was not given', async () => {
    const { user } = await account();
    await createSession(user.id, signRefreshToken(user.id), later(), noDevice);

    const [row] = await sessionsOf(user.id);

    assert.equal(row?.ipAddress, null);
    assert.equal(row?.userAgent, null);
  });
});

describe('rotating a refresh token', () => {
  it('moves the session onto the new token; the old token cannot be used again', async () => {
    const { user } = await account();
    const first = await signedIn(user.id);
    const second = signRefreshToken(user.id);

    assert.equal(await rotateSession(first, second, later(), device), true);
    assert.equal(await rotateSession(first, signRefreshToken(user.id), later(), device), false, 'a replayed token is refused');

    const rows = await sessionsOf(user.id);
    assert.equal(rows.length, 1, 'rotation updates the session in place');
    assert.equal(rows[0]?.tokenHash, hashSessionToken(second));
    assert.ok(rows[0]?.lastUsedAt instanceof Date);
  });

  it('lets only one of two simultaneous refreshes with the same token succeed', async () => {
    const { user } = await account();
    const token = await signedIn(user.id);

    const results = await Promise.all([
      rotateSession(token, signRefreshToken(user.id), later(), device),
      rotateSession(token, signRefreshToken(user.id), later(), device),
    ]);

    assert.deepEqual(results.filter(Boolean).length, 1);
  });

  it('refuses a token nobody was issued, a revoked session and an expired one', async () => {
    const { user } = await account();

    assert.equal(await rotateSession(signRefreshToken(user.id), signRefreshToken(user.id), later(), device), false, 'unknown');

    const revoked = await signedIn(user.id);
    await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.tokenHash, hashSessionToken(revoked)));
    assert.equal(await rotateSession(revoked, signRefreshToken(user.id), later(), device), false, 'revoked');

    const expired = signRefreshToken(user.id);
    await createSession(user.id, expired, new Date(Date.now() - 1_000), device);
    assert.equal(await rotateSession(expired, signRefreshToken(user.id), later(), device), false, 'expired');
  });
});

describe('ending one session', () => {
  it('ends the device the token belongs to, once, and no other', async () => {
    const { user } = await account();
    const phone = await signedIn(user.id);
    await signedIn(user.id);

    assert.equal(await revokeSessionByToken(user.id, phone), true);
    assert.equal(await revokeSessionByToken(user.id, phone), false, 'already ended');
    assert.equal((await liveSessionsOf(user.id)).length, 1);
  });

  it('cannot be used by another account to end this one’s session', async () => {
    const owner = await account();
    const stranger = await account();
    const token = await signedIn(owner.user.id);

    assert.equal(await revokeSessionByToken(stranger.user.id, token), false);
    assert.equal((await liveSessionsOf(owner.user.id)).length, 1);
  });
});

describe('refresh', () => {
  it('issues new tokens for a store that is still installed, and refuses the old token afterwards', async () => {
    const { user } = await account();
    const token = await signedIn(user.id);

    const renewed = await refresh(token, device);

    assert.ok(renewed.accessToken && renewed.refreshToken);
    assert.notEqual(renewed.refreshToken, token);
    await assert.rejects(refresh(token, device), refusedWith('INVALID_REFRESH_TOKEN'));
    const again = await refresh(renewed.refreshToken, device);
    assert.ok(again.refreshToken, 'the new token keeps working');
  });

  it('ends the session when the store has been uninstalled, and says to sign in with Shopify', async () => {
    const { user } = await account({ connected: 'uninstalled' });
    const token = await signedIn(user.id);

    await assert.rejects(refresh(token, device), refusedWith('SHOPIFY_STORE_REQUIRED'));
    assert.equal((await liveSessionsOf(user.id)).length, 0, 'the session was revoked, not left open');
  });

  it('ends the session for an account with no store connection at all', async () => {
    const { user } = await account({ connected: 'none' });
    const token = await signedIn(user.id);

    await assert.rejects(refresh(token, device), refusedWith('SHOPIFY_STORE_REQUIRED'));
  });

  it('refuses text that is not a refresh token, and a token for an account that does not exist', async () => {
    await assert.rejects(refresh('not-a-token', device), refusedWith('INVALID_REFRESH_TOKEN'));
    await assert.rejects(refresh(signRefreshToken(987_654), device), refusedWith('INVALID_REFRESH_TOKEN'));
  });
});

describe('signing out', () => {
  it('ends only this device when the refresh token is sent, and records it', async () => {
    const { user } = await account();
    const laptop = await signedIn(user.id);
    await signedIn(user.id);

    await logout(user.id, device, laptop);

    assert.equal((await liveSessionsOf(user.id)).length, 1);
    const events = await eventsOf(user.id);
    assert.deepEqual(events.map((event) => event.type), ['logout']);
    assert.equal(events[0]?.metadata, null, 'nothing is claimed about other sessions');
  });

  it('ends every session when no token is sent, and records how many', async () => {
    const { user } = await account();
    for (let index = 0; index < 3; index += 1) await signedIn(user.id);

    await logout(user.id, device);

    assert.equal((await liveSessionsOf(user.id)).length, 0);
    const [event] = await eventsOf(user.id);
    assert.equal(event?.type, 'logout');
    assert.deepEqual(event?.metadata, { sessionsEnded: 3 });
  });

  it('falls back to ending every session when the token matches none, never to ending none', async () => {
    const { user } = await account();
    await signedIn(user.id);
    await signedIn(user.id);

    await logout(user.id, device, signRefreshToken(user.id));

    assert.equal((await liveSessionsOf(user.id)).length, 0);
  });
});

describe('the security log', () => {
  it('records what happened with the real device details, and nothing invented', async () => {
    const { user } = await account();

    await recordSecurityEvent({ userId: user.id, type: 'login_success', metadata: device });
    await recordSecurityEvent({ userId: user.id, type: 'login_failed', metadata: noDevice });

    const [success, failure] = await eventsOf(user.id);
    assert.equal(success?.ipAddress, device.ipAddress);
    assert.equal(success?.userAgent, device.userAgent);
    assert.equal(failure?.ipAddress, null);
    assert.equal(failure?.userAgent, null);
  });

  it('never throws when the log itself cannot be written, and the line it logs holds no private value', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      // No such account: the foreign key refuses the row.
      await assert.doesNotReject(recordSecurityEvent({ userId: 987_654, type: 'login_success', metadata: device }));
    } finally {
      console.error = original;
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /failed to record login_success for user 987654/);
    assert.doesNotMatch(lines[0]!, /203\.0\.113\.20|session-lifecycle test/, 'no request detail in the log line');
  });
});
