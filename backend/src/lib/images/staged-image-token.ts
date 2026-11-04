import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * ─── A signed receipt for an image already uploaded to Shopify ───────
 *
 * An AI-drawn image is uploaded to Shopify's staging storage as soon as it is drawn, so applying
 * it later does not mean sending the picture back up through the browser. What the browser holds
 * in between is THIS: where the file sits in Shopify's storage, for which store and which product,
 * and until when — signed with a key only the API knows.
 *
 * WHY SIGNED. Applying attaches whatever `originalSource` it is given to a live product. If the
 * browser could name that URL, anyone signed in could attach any file on the internet to their
 * store through Rankvora AI. Signing means the API only ever attaches a file it uploaded itself, to the
 * store and product it uploaded it for, within the hour.
 *
 * Stateless on purpose: nothing is stored, so a restart of the API between drawing and applying
 * loses nothing, and an abandoned drawing leaves no row behind. Shopify clears unused staged files
 * on its own.
 */

const TOKEN_VERSION = 1;
/** How long a drawn image can wait to be applied. */
export const STAGED_IMAGE_TTL_SECONDS = 60 * 60;

export interface StagedImageClaims {
  storeId: number;
  /** The product's numeric id, as the routes take it. */
  productId: string;
  /** Shopify's own `resourceUrl` for the staged file — the `originalSource` applying will use. */
  resourceUrl: string;
  mimeType: string;
  width: number;
  height: number;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** A key used for nothing else: derived from the access-token secret with its own label, so a
 * token of one kind can never be replayed as the other. */
function signingKey(): Buffer {
  return createHash('sha256').update(`scorelo:staged-product-image:v${TOKEN_VERSION}:`).update(env.jwtAccessSecret).digest();
}

function signature(payload: string): Buffer {
  return createHmac('sha256', signingKey()).update(payload).digest();
}

export function signStagedImage(claims: Omit<StagedImageClaims, 'expiresAt'>, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(now / 1000) + STAGED_IMAGE_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...claims, expiresAt }), 'utf8').toString('base64url');
  return { token: `${payload}.${signature(payload).toString('base64url')}`, expiresAt };
}

export type StagedImageVerdict =
  | { ok: true; claims: StagedImageClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' };

/**
 * The token's claims, if it was signed here, has not expired, and was issued for exactly this
 * store and product. Anything else is refused — and the reason is for the log, not the caller.
 */
export function verifyStagedImage(token: string, expected: { storeId: number; productId: string }, now = Date.now()): StagedImageVerdict {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, sent] = parts;

  const expectedSignature = signature(payload);
  const sentSignature = Buffer.from(sent, 'base64url');
  if (sentSignature.length !== expectedSignature.length || !timingSafeEqual(sentSignature, expectedSignature)) {
    return { ok: false, reason: 'signature' };
  }

  let claims: StagedImageClaims & { v?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StagedImageClaims & { v?: unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    claims.v !== TOKEN_VERSION
    || typeof claims.storeId !== 'number'
    || typeof claims.productId !== 'string'
    || typeof claims.resourceUrl !== 'string'
    || typeof claims.mimeType !== 'string'
    || typeof claims.expiresAt !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.expiresAt * 1000 <= now) return { ok: false, reason: 'expired' };
  if (claims.storeId !== expected.storeId || claims.productId !== expected.productId) return { ok: false, reason: 'mismatch' };

  return {
    ok: true,
    claims: {
      storeId: claims.storeId,
      productId: claims.productId,
      resourceUrl: claims.resourceUrl,
      mimeType: claims.mimeType,
      width: Number(claims.width) || 0,
      height: Number(claims.height) || 0,
      expiresAt: claims.expiresAt,
    },
  };
}
