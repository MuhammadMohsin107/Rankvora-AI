// ─── After Shopify approves the store, the merchant is signed in (npm test) ───
// Sign-in is Shopify only and has no second step: no emailed code, no recovery code, no ticket.
// completeExternalSignIn is where a sign-in ends, so this runs it for an account and checks that what
// comes back is a finished session — real tokens for that account, a stored session row, and a
// login record — and nothing that asks for anything more. The account is the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Read once at module load by config/env.js — set before anything imports it.
process.env.JWT_ACCESS_SECRET ??= 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET ??= 'b'.repeat(48);

await import('./helpers/database.js');
const { eq } = await import('drizzle-orm');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { securityEvents, userSessions, users } = await import('../db/schema.js');
const { completeExternalSignIn } = await import('../services/auth.service.js');
const { verifyAccessToken, verifyRefreshToken } = await import('../lib/jwt.js');
const { ApiError } = await import('../middleware/error.js');

const metadata = { ipAddress: '203.0.113.9', userAgent: 'sign-in-session test' };

describe('finishing a Shopify sign-in', () => {
  it('returns a finished session and nothing that asks for a second step', async () => {
    const account = await insertReturning(users, { fullName: 'Ada', email: 'ada-session@example.com' });

    const result = await completeExternalSignIn(account.id, metadata);

    assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'refreshToken', 'user']);
    assert.equal(result.user.id, account.id);
    assert.equal(verifyAccessToken(result.accessToken).sub, account.id);
    assert.equal(verifyRefreshToken(result.refreshToken).sub, account.id);
  });

  it('stores the session and records the sign-in, with the real device details', async () => {
    const account = await insertReturning(users, { fullName: 'Grace', email: 'grace-session@example.com' });

    await completeExternalSignIn(account.id, metadata);

    const sessions = await db.select().from(userSessions).where(eq(userSessions.userId, account.id));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.ipAddress, metadata.ipAddress);
    const events = await db.select().from(securityEvents).where(eq(securityEvents.userId, account.id));
    assert.deepEqual(events.map((event) => event.type), ['login_success']);
  });

  it('returns the tokens and the account, and the account carries no field that looks like a credential', async () => {
    const account = await insertReturning(users, { fullName: 'Edsger', email: 'edsger-session@example.com' });
    const result = await completeExternalSignIn(account.id, metadata);
    assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'refreshToken', 'user']);
    assert.deepEqual(Object.keys(result.user).filter((key) => /password|secret|hash|credential/i.test(key)), []);
  });

  it('refuses an account that does not exist, instead of inventing a session', async () => {
    await assert.rejects(
      completeExternalSignIn(987_654, metadata),
      (error: unknown) => error instanceof ApiError && error.statusCode === 401 && error.code === 'SIGN_IN_INVALID',
    );
  });
});
