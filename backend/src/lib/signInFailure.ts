import { ApiError } from '../middleware/error.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';

/**
 * ─── Why a Shopify sign-in did not finish ────────────────────────────
 *
 * The OAuth callback is a browser redirect, so a failure cannot be a JSON body: it travels to the
 * sign-in page as a short reason code in the query, and the page turns it into wording a merchant
 * can act on (data/auth.repository.ts → describeShopifySignInFailure). Raw messages never travel.
 *
 * Every failure gets a code that names what actually failed. Folding the unexpected ones into one
 * word made "Shopify refused the code", "Shopify could not be read after approving" and "our
 * database failed" all read the same on screen and in the log.
 */

/** A reason Shopify itself reported on the redirect (`?error=`), kept only when it is a plain token. */
export function shopifyReportedReason(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'failed';
}

/** The code for an error thrown while finishing a sign-in. */
export function signInFailureReason(error: unknown): string {
  // Failures this code raised on purpose carry their own code (bad signature, expired state, a
  // permission the merchant did not grant, an email already in use, …).
  if (error instanceof ApiError) return error.code;
  // The approval worked but reading the shop afterwards did not: revoked in the same instant,
  // Shopify rate-limiting, or Shopify unreachable.
  if (error instanceof StoreDataError) return 'SHOPIFY_READ_FAILED';
  // Anything else is a fault on our side (database, bug). The details are in the API log under the
  // request reference shown beside the message.
  return 'login_failed';
}
