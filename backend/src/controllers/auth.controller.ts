import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { ShopifyIdTokenError } from '../lib/shopify-id-token.js';
import { toPublicUser } from '../lib/publicUser.js';
import { ApiError } from '../middleware/error.js';
import { RETRY_INVALID_SESSION_HEADER } from '../middleware/authenticate.js';
import { logout, refresh } from '../services/auth.service.js';
import { beginShopifyLaunch, beginShopifyLogin, completeShopifyLogin } from '../services/shopify-login.service.js';
import { openEmbeddedSession } from '../services/shopify-embedded.service.js';
import { recordSecurityEvent } from '../services/security-event.service.js';
import { requireUserId } from '../lib/requestContext.js';
import { requestMetadata } from '../lib/requestMetadata.js';

// ─── Sign in with Shopify ────────────────────────────────────────────
// Both starts return the authorization URL as JSON rather than redirecting, for the same reason
// GET /shopify/install does: the browser needs to keep the nonce it generated, and a fetch it
// initiated is how it stays in control of the navigation.

/** The merchant typed their store address on the sign-in page. */
export async function postShopifyStart(req: Request, res: Response) {
  res.json({ data: { url: beginShopifyLogin(req.body.shop, req.body.nonce) } });
}

/** Shopify opened Rankvora AI with a signed query — the App Store install or the admin's Apps list. */
export async function postShopifyLaunch(req: Request, res: Response) {
  res.json({ data: { url: beginShopifyLaunch(req.body.launch, req.body.nonce) } });
}

/** Redeems the signed grant Shopify's return produced; the response is the finished session. */
export async function postShopifyComplete(req: Request, res: Response) {
  const { user, accessToken, refreshToken } = await completeShopifyLogin(req.body.grant, req.body.nonce, requestMetadata(req));
  res.json({ data: { user, accessToken, refreshToken } });
}

/**
 * The embedded app's one "sign-in": called once when the page opens inside the Shopify admin.
 *
 * It is not behind `authenticate`, which needs a shop that has already been opened here — this is the
 * call that opens it. The ID token arrives in the Authorization header (App Bridge adds it to every
 * request to this origin), and what comes back is the account, not a session: nothing is issued,
 * stored or remembered, and the next request proves itself with a fresh token again.
 */
export async function postShopifyEmbedded(req: Request, res: Response) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) throw new ApiError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED');

  let session;
  try {
    session = await openEmbeddedSession(token);
  } catch (error) {
    if (error instanceof ShopifyIdTokenError) {
      res.setHeader(RETRY_INVALID_SESSION_HEADER, '1');
      throw new ApiError(401, 'Invalid or expired token', 'SHOPIFY_ID_TOKEN_INVALID');
    }
    throw error;
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) throw new ApiError(401, 'That store could not be matched to a Rankvora AI account.', 'SHOPIFY_LOGIN_UNAVAILABLE');

  // A line in the security log when something actually changed (a first open, a reinstall, new
  // scopes) — not on every page load, which would bury the entries that matter.
  if (session.exchanged) await recordSecurityEvent({ userId: user.id, type: 'login_success', metadata: requestMetadata(req) });

  res.json({ data: { user: toPublicUser(user), shop: session.shop } });
}

export async function postRefresh(req: Request, res: Response) {
  const { accessToken, refreshToken } = await refresh(req.body.refreshToken, requestMetadata(req));
  res.json({ data: { accessToken, refreshToken } });
}

export async function postLogout(req: Request, res: Response) {
  await logout(requireUserId(req), requestMetadata(req), req.body?.refreshToken);
  res.status(204).send();
}
