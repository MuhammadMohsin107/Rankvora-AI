import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { looksLikeShopifyIdToken, ShopifyIdTokenError, verifyShopifyIdToken } from '../lib/shopify-id-token.js';
import { findInstalledOwner } from '../services/shopify-embedded.service.js';

export interface AuthenticatedUser {
  id: number;
}

/**
 * Tells App Bridge a 401 was only a stale ID token. It then fetches a fresh one and repeats the
 * request once, so a token that expired between being issued and arriving never reaches the merchant.
 */
export const RETRY_INVALID_SESSION_HEADER = 'X-Shopify-Retry-Invalid-Session-Request';

/**
 * Who is calling. Two kinds of bearer token are accepted, and the token itself says which:
 *
 *   A Shopify ID token   the embedded app. App Bridge adds one to every request the page makes; it
 *                        names the shop, and the caller is that shop's account. Nothing is stored.
 *   This app's own JWT   the access token issued by the redirect sign-in (and what local development
 *                        with MOCK_AUTH replaces). Kept for the standalone flow and the test suite.
 *
 * Either way `req.user` is the same, so no route needs to know which door the caller came through.
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  if (env.mockAuthEnabled) {
    req.user = { id: 1 };
    next();
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (looksLikeShopifyIdToken(token)) {
    void authenticateShopifyIdToken(req, res, next, token);
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function authenticateShopifyIdToken(req: Request, res: Response, next: NextFunction, token: string) {
  try {
    const { shop } = verifyShopifyIdToken(token);
    const ownerId = await findInstalledOwner(shop);
    if (ownerId === null) {
      // The token is fine; this shop just has not been opened here (or was uninstalled). The page
      // answers by opening a session (POST /api/auth/shopify/embedded) and trying again, so this is
      // not marked retryable — repeating the request with a new token would change nothing.
      res.status(401).json({ error: 'This store has not opened Rankvora AI yet', code: 'SHOPIFY_NOT_INSTALLED' });
      return;
    }
    req.user = { id: ownerId };
    next();
  } catch (error) {
    if (error instanceof ShopifyIdTokenError) {
      res.setHeader(RETRY_INVALID_SESSION_HEADER, '1');
      res.status(401).json({ error: 'Invalid or expired token', code: 'SHOPIFY_ID_TOKEN_INVALID' });
      return;
    }
    next(error);
  }
}
