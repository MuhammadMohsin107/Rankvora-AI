import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
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
 * Who is calling: the account that owns the shop named by a Shopify ID token.
 *
 * App Bridge adds an ID token to every request the page makes; Shopify signs it, it names the shop,
 * and it lives about a minute, so nothing is stored and there is nothing to log out of. This app
 * issues no token of its own — a bearer token that is not a valid Shopify ID token is refused.
 *
 * Local development can switch authentication off entirely with MOCK_AUTH (development only; see
 * config/env.ts), which treats every request as user 1.
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

  if (!looksLikeShopifyIdToken(token)) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  void authenticateShopifyIdToken(req, res, next, token);
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
