import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { ApiError } from './error.js';
import { requireUserId } from '../lib/requestContext.js';

/**
 * ─── Platform-admin authorization ────────────────────────────────────
 *
 * `authenticate` proves WHO is calling. This proves WHAT THEY MAY DO, and the two are kept as
 * separate middleware because they answer separate questions — an authenticated customer reaching
 * an admin route must be refused, not admitted.
 *
 * THE GRANT LIVES IN THE DATABASE, in `users.is_platform_admin`, which defaults to false and is written
 * by nothing in this codebase: no signup path, no API, no seed. Becoming an admin is a deliberate
 * UPDATE an operator runs against the database. There are no credentials here — no admin password,
 * no shared key, no environment-variable allow-list of emails — because any of those would be a
 * second authentication system sitting alongside the real one.
 *
 * `users.role` IS NOT CONSULTED. It is a Settings → Profile label that defaults to the literal
 * string 'Administrator' on every row (see db/schema.ts), so reading it here would grant platform
 * admin to every account in existence. That near-miss is why this check names its own column.
 *
 * READ FRESH ON EVERY REQUEST, not carried in the access token. A revoked flag then takes effect
 * at the caller's next request, instead of whenever a fifteen-minute JWT happens to expire. The
 * cost is one indexed primary-key read per admin call, which is the right trade for a surface this
 * privileged and this low-traffic.
 *
 * MOCK AUTH IS NOT A BYPASS. `authenticate` can put a fixed user id on the request in
 * development (env.mockAuthEnabled), and this middleware still requires that id to belong to a
 * real row whose flag is genuinely set — so the development shortcut cannot conjure an admin.
 */

export interface AdminIdentity {
  id: number;
  email: string;
  isPlatformAdmin: boolean;
}

/**
 * The decision, separated from the lookup so it can be asserted on directly.
 *
 * A MISSING ROW AND A NON-ADMIN ROW GET THE SAME 403. A 404 for the first would confirm which
 * authenticated ids exist, and an authenticated non-admin learning nothing beyond "not for you" is
 * exactly the intent.
 *
 * NOT 401: the caller's authentication was accepted. Answering 401 would tell a client to go and
 * refresh a token that is working perfectly well.
 */
export function authorizeAdmin(identity: AdminIdentity | null): AdminIdentity {
  if (!identity || !identity.isPlatformAdmin) {
    throw new ApiError(403, 'Administrator access is required for this endpoint.', 'ADMIN_REQUIRED');
  }
  return identity;
}

/** Reads the caller's current grant. Selects the three columns needed and no others — a hash has no
 * reason to be loaded on an authorization path. */
export async function loadAdminIdentity(userId: number): Promise<AdminIdentity | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      isPlatformAdmin: users.isPlatformAdmin,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
}

/**
 * Router-level guard. Always mounted AFTER `authenticate`, which is what makes requireUserId()
 * below able to speak for a verified token rather than a guess.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const userId = requireUserId(req);
    const identity = authorizeAdmin(await loadAdminIdentity(userId));
    req.admin = identity;
    next();
  } catch (error) {
    next(error);
  }
}

/** The acting admin, for handlers that need to attribute an action. Throws if requireAdmin did not
 * run, rather than silently attributing the action to nobody. */
export function requireAdminIdentity(req: Request): AdminIdentity {
  if (!req.admin) {
    throw new ApiError(403, 'Administrator access is required for this endpoint.', 'ADMIN_REQUIRED');
  }
  return req.admin;
}
