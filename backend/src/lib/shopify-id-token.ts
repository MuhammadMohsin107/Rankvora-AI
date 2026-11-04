import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * ─── Shopify ID tokens (session tokens) ──────────────────────────────
 *
 * When Rankvora AI runs inside the Shopify admin, App Bridge puts a short-lived JWT in the
 * Authorization header of every request the page makes to this origin. Shopify signs it with the
 * app's client secret, so a valid one proves two things at once: the request comes from the app's
 * own page, and a staff member of `dest` has that shop's admin open right now. It lives about a
 * minute and is never stored — which is what lets the embedded app work with no cookies and no
 * browser storage, as the App Store requires.
 *
 * This is the whole check Shopify documents: signature (HS256, client secret), audience (this app's
 * client id), the time window, and `iss` / `dest` naming the same shop.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Seconds of clock drift tolerated between Shopify's servers and this one. */
const CLOCK_TOLERANCE_SECONDS = 10;

/** The token was not issued by Shopify to this app, has expired, or names no real shop. The message is
 * for logs only — callers answer every one of these the same way. */
export class ShopifyIdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyIdTokenError';
  }
}

export interface ShopifyIdTokenClaims {
  /** The shop's `*.myshopify.com` domain, taken from `dest`. */
  shop: string;
  /** Shopify's id for the staff member who opened the app, when the token carries one. */
  staffId: string | null;
}

/**
 * Whether a bearer token is shaped like a Shopify ID token rather than one of this app's own access
 * tokens. Decides only WHICH check to run — it proves nothing, because it never verifies a signature.
 */
export function looksLikeShopifyIdToken(token: string): boolean {
  const payload = jwt.decode(token);
  return typeof payload === 'object' && payload !== null && typeof (payload as jwt.JwtPayload).dest === 'string';
}

function hostnameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Verifies an ID token and returns the shop it was issued for. Throws ShopifyIdTokenError otherwise. */
export function verifyShopifyIdToken(token: string): ShopifyIdTokenClaims {
  if (!env.shopifyApiKey || !env.shopifyApiSecret) {
    throw new ShopifyIdTokenError('the Shopify app credentials are not configured');
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.shopifyApiSecret, {
      algorithms: ['HS256'],
      audience: env.shopifyApiKey,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }) as jwt.JwtPayload;
  } catch (error) {
    throw new ShopifyIdTokenError(error instanceof Error ? error.message : 'invalid token');
  }

  const dest = hostnameOf(payload.dest);
  const issuer = hostnameOf(payload.iss);
  if (!dest || dest !== issuer) throw new ShopifyIdTokenError('iss and dest do not name the same shop');
  if (!SHOP_DOMAIN.test(dest)) throw new ShopifyIdTokenError('dest is not a myshopify.com domain');

  return { shop: dest, staffId: typeof payload.sub === 'string' ? payload.sub : null };
}
