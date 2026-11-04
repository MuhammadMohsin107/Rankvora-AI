import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopifyConnections, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { refreshTokenTtlMs, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { toPublicUser } from '../lib/publicUser.js';
import { createSession, revokeAllSessions, revokeSessionByToken, rotateSession } from './session.service.js';
import { recordSecurityEvent } from './security-event.service.js';
import type { RequestMetadata } from '../lib/requestMetadata.js';

/**
 * Issues a token pair and records the device it was issued to.
 *
 * WHAT CHANGED IN PHASE 2: the refresh hash now lands in a `user_sessions` row instead of
 * overwriting two columns on `users`. That single change is what makes more than one signed-in
 * device possible — the old shape could hold exactly one value, so every login silently ended the
 * previous session.
 *
 * WHAT DID NOT CHANGE: the tokens themselves. Same JWTs, same secrets, same 15-minute access and
 * 30-day refresh TTLs, same SHA-256 hashing, same rotation. jwt.ts is untouched.
 *
 * The old `users.refresh_token_hash` / `refresh_token_expires_at` columns were dropped in the move to
 * Cloudflare D1; nothing had written or read them since sessions moved to their own table.
 */
async function issueTokenPair(userId: number, metadata: RequestMetadata) {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  await createSession(userId, refreshToken, new Date(Date.now() + refreshTokenTtlMs()), metadata);
  return { accessToken, refreshToken };
}

/**
 * Finishes a sign-in whose first factor Shopify proved — Shopify only completes its OAuth screen
 * for someone signed in to that shop's admin. This is the only way a session starts, and there is
 * no second step: Shopify's own sign-in is the whole authentication.
 *
 * No email-verification gate: the address came from Shopify rather than from a form.
 */
export async function completeExternalSignIn(userId: number, metadata: RequestMetadata) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError(401, 'That sign-in could not be completed. Please start again.', 'SIGN_IN_INVALID');

  const tokens = await issueTokenPair(user.id, metadata);
  await recordSecurityEvent({ userId: user.id, type: 'login_success', metadata });
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Rotates a refresh token, keeping the caller on the SAME session row.
 *
 * The rejection rules are unchanged from before Phase 2 — a rotated-out token, a revoked one and
 * an expired one are all refused with the same 401, and the reason is never disclosed. What moved
 * is where the hash is checked: a session row rather than a column on `users`.
 *
 * A refresh token issued BEFORE this phase has no session row, so it lands in the same rejection
 * as any unknown token. That signs existing customers out once, at cutover. No row is fabricated
 * to paper over it — a session record invented for a device nobody observed would be exactly the
 * kind of made-up security data this work exists to remove.
 */
export async function refresh(refreshToken: string, metadata: RequestMetadata) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }

  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) throw new ApiError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

  // Sign-in is Shopify only, so a session lasts only while Shopify still has one of the account's
  // stores installed. This ends sessions left over from email sign-in and, within one access-token
  // lifetime, the owner's sessions after an uninstall. Signing in with Shopify again reinstalls.
  const [installedStore] = await db
    .select({ id: shopifyConnections.id })
    .from(shopifyConnections)
    .innerJoin(stores, eq(stores.id, shopifyConnections.storeId))
    .where(and(eq(stores.ownerId, user.id), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  if (!installedStore) {
    await revokeSessionByToken(user.id, refreshToken);
    throw new ApiError(401, 'Sign in with your Shopify store to continue.', 'SHOPIFY_STORE_REQUIRED');
  }

  const accessToken = signAccessToken(user.id);
  const newRefreshToken = signRefreshToken(user.id);
  const expiresAt = new Date(Date.now() + refreshTokenTtlMs());

  // One guarded UPDATE. Two concurrent refreshes with the same token cannot both succeed.
  const rotated = await rotateSession(refreshToken, newRefreshToken, expiresAt, metadata);
  if (!rotated) throw new ApiError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

  return { accessToken, refreshToken: newRefreshToken };
}

/**
 * Ends a session, server-side.
 *
 * HOW THE CORRECT SESSION IS IDENTIFIED. An access token carries only `{sub, type}` — no session
 * identifier — so the access token alone cannot say WHICH device is signing out. Two options
 * existed: add a `sid` claim to the JWT, or have the client present the refresh token it is
 * already holding. The second was chosen because it requires no change to jwt.ts and opens no new
 * exposure: the refresh token ALREADY travels in a POST body to /auth/refresh over the same
 * origin and the same TLS. Logout reuses that established path rather than inventing one.
 *
 * The raw token is used for exactly one thing — a SHA-256 hash to find the row — and is never
 * stored, never logged, and never echoed back.
 *
 * WITHOUT a refresh token the request cannot name a session, so every session is revoked. That is
 * the safe direction to fail, and it matches what logout did before Phase 2, when there was only
 * one credential to clear. It is never weaker than the old behaviour.
 */
export async function logout(userId: number, metadata: RequestMetadata, refreshToken?: string): Promise<void> {
  if (refreshToken) {
    const revoked = await revokeSessionByToken(userId, refreshToken);
    if (revoked) {
      await recordSecurityEvent({ userId, type: 'logout', metadata });
      return;
    }
    // A token that matches nothing this user owns falls through to the safe path rather than
    // silently succeeding while leaving live sessions behind.
    console.warn(`[scorelo-security] logout: presented token matched no live session (user ${userId})`);
  }

  const ended = await revokeAllSessions(userId);
  await recordSecurityEvent({ userId, type: 'logout', metadata, context: { sessionsEnded: ended } });
}
