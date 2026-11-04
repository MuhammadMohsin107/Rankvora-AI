import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { updateReturning } from '../db/returning.js';
import { userSessions } from '../db/schema.js';
import type { RequestMetadata } from '../lib/requestMetadata.js';

/**
 * ─── Database-backed sessions ────────────────────────────────────────
 *
 * One row per signed-in device, replacing the single `users.refresh_token_hash` column (since
 * dropped) that could only ever hold one value.
 *
 * WHAT DID NOT CHANGE: the refresh token is still the same JWT, signed the same way, with the same
 * 15-minute access / 30-day refresh TTLs, still hashed with SHA-256, still rotated on every use,
 * and an old token is still rejected because its hash no longer matches a live row. jwt.ts is
 * untouched. This service moves WHERE that hash lives; it does not invent a second token system.
 *
 * WHY SHA-256 AND NOT BCRYPT: the token is a signed JWT — high-entropy, nothing for a slow hash to
 * protect — and the lookup has to be a point-read on an indexed column, which a per-row-salted
 * hash cannot support.
 *
 * NO ROW IS EVER FABRICATED. Sessions exist only where a real login created one, and their IP and
 * User-Agent are null unless the request actually carried them.
 */

/** SHA-256 of the raw token: refresh tokens are high-entropy, so a fast hash is enough. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Records a new signed-in device. Called once per real login, with the token that was just issued. */
export async function createSession(
  userId: number,
  refreshToken: string,
  expiresAt: Date,
  metadata: RequestMetadata,
): Promise<void> {
  await db.insert(userSessions).values({
    userId,
    tokenHash: hashSessionToken(refreshToken),
    expiresAt,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
  });
}

/**
 * Rotates a session onto a new refresh token, returning false when the presented token is not
 * usable.
 *
 * PRESERVES THE EXISTING REJECTION BEHAVIOUR EXACTLY. Before Phase 2 a rotated-out token failed
 * because the stored hash no longer matched; now it fails because no live row carries that hash.
 * Same outcome, same three reasons — unknown, revoked, expired — and the caller converts all of
 * them into the one 401 it already returned.
 *
 * The whole rotation is a single UPDATE guarded by the old hash. That matters: two concurrent
 * refreshes with the same token cannot both succeed, because the second finds nothing left to
 * match. Read-then-write would let both through.
 */
export async function rotateSession(
  oldToken: string,
  newToken: string,
  expiresAt: Date,
  metadata: RequestMetadata,
): Promise<boolean> {
  const oldHash = hashSessionToken(oldToken);

  const [session] = await db
    .select()
    .from(userSessions)
    .where(eq(userSessions.tokenHash, oldHash))
    .limit(1);

  if (!session) {
    // Either never issued, or already rotated away — indistinguishable, and both are refusals.
    console.warn('[scorelo-security] refresh rejected: no session for that token');
    return false;
  }
  if (session.revokedAt !== null) {
    console.warn(`[scorelo-security] refresh rejected: session ${session.id} is revoked`);
    return false;
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    console.warn(`[scorelo-security] refresh rejected: session ${session.id} has expired`);
    return false;
  }

  const changed = await db
    .update(userSessions)
    .set({
      tokenHash: hashSessionToken(newToken),
      lastUsedAt: new Date(),
      expiresAt,
      // Refreshed from the current request: a session that moves network or client should say so
      // rather than keep showing where it started. Nulls overwrite, because "unknown now" is more
      // honest than a stale value presented as current.
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    })
    .where(and(eq(userSessions.id, session.id), eq(userSessions.tokenHash, oldHash), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });

  // No row changed means another request rotated this session between the read and the write.
  const rotated = changed.length === 1;
  if (!rotated) console.warn(`[scorelo-security] refresh rejected: session ${session.id} rotated concurrently`);
  return rotated;
}

/**
 * Revokes the single session a refresh token belongs to. Returns false when it matched nothing.
 *
 * This is how logout ends the current device without touching the others.
 */
export async function revokeSessionByToken(userId: number, refreshToken: string): Promise<boolean> {
  const [session] = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(
      and(
        eq(userSessions.tokenHash, hashSessionToken(refreshToken)),
        // Scoped to the authenticated user, so a token belonging to another account cannot be
        // used to revoke that account's session.
        eq(userSessions.userId, userId),
        isNull(userSessions.revokedAt),
      ),
    )
    .limit(1);

  if (!session) return false;

  await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, session.id));
  return true;
}

/** Revokes every live session a user holds. Used when a logout cannot name its own session. */
export async function revokeAllSessions(userId: number): Promise<number> {
  // One statement, however many sessions there are. Sessions are only revoked, never deleted, so a
  // long-lived account can hold hundreds, and one query per session would be hundreds of D1 queries
  // in a single request.
  const revoked = await updateReturning(
    userSessions,
    { revokedAt: new Date() },
    and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)),
  );
  return revoked.length;
}
