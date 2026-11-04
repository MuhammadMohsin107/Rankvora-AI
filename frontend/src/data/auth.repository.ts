import { api, ApiError } from '../lib/api';
import { appBridgeAvailable } from '../lib/embedded';
import type { UserRow } from './api.types';

// ─── Opening the app ─────────────────────────────────────────────────
//
// There is no sign-in. Rankvora AI is a Shopify app, and inside the Shopify admin Shopify itself says
// which store is opening it — App Bridge adds an ID token to every request, and the backend checks
// it. Nothing is typed, approved, stored or remembered here: no token, no cookie, no browser storage.

/** The waits before each retry of a request the server did not answer. */
const SESSION_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** How long to wait for App Bridge to finish starting before saying it is not there. */
const APP_BRIDGE_READY_TIMEOUT_MS = 10_000;

/**
 * Merchant-facing wording for why the app could not open — the server's error code. Raw codes are
 * never shown. Used by the screen that stands where a sign-in page would be.
 */
export function describeOpenFailure(code: string | null | undefined): string {
  switch (code) {
    case 'SHOPIFY_LOGIN_EMAIL_TAKEN':
      return 'A Rankvora AI account already uses this store’s email address. Contact support to connect this store to it.';
    case 'SHOPIFY_SCOPES_MISSING':
      return 'Shopify did not grant every permission Rankvora AI needs, so your store was not connected. Open the app again and approve all requested access.';
    case 'SHOPIFY_LOGIN_NO_EMAIL':
      return 'Shopify did not share an email address for this store, so we could not create your account.';
    case 'SHOPIFY_NOT_CONFIGURED':
      return 'Rankvora AI is not configured on this server yet. Contact your administrator.';
    case 'SHOPIFY_TOKEN_EXCHANGE_FAILED':
      return 'Shopify did not accept the request to open Rankvora AI. Please try again.';
    case 'SHOPIFY_READ_FAILED':
      return 'Shopify opened Rankvora AI, but we could not read your store afterwards. Please try again in a moment.';
    case 'SHOPIFY_LOGIN_UNAVAILABLE':
      return 'This Shopify store could not be matched to a Rankvora AI account. Contact support.';
    case 'SHOPIFY_STORE_MISMATCH':
      return 'This store address is on file for a different Shopify store. Contact support to sort out which store it belongs to.';
    case 'SHOPIFY_ID_TOKEN_INVALID':
    case 'AUTHENTICATION_REQUIRED':
      return 'Shopify could not confirm this session. Reload the page, or open Rankvora AI again from Apps in your Shopify admin.';
    case 'SHOPIFY_NOT_INSTALLED':
      return 'Rankvora AI is not installed on this store, or was removed. Install it from the Shopify App Store and open it from Apps in your Shopify admin.';
    case 'APP_BRIDGE_MISSING':
      return 'Rankvora AI could not connect to your Shopify admin. Reload the page — and if you use an ad blocker, turn it off for the Shopify admin.';
    default:
      return 'Rankvora AI could not open for this store. Please reload the page and try again.';
  }
}

/**
 * Resolves the account for local development, or null when there is none.
 *
 * Outside the Shopify admin this only answers while the backend runs with MOCK_AUTH (development
 * only), which resolves a mock user without any credential. Anywhere else it is a 401 — there is no
 * session to resume — and the bare site shows how to open the app from the Shopify admin.
 *
 * A server that does not answer at all (a network drop, or the API restarting during a deploy) is
 * waited out briefly rather than reported as signed out.
 */
export async function fetchSession(): Promise<UserRow | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.get<UserRow>('/users/me');
    } catch (error) {
      const noAnswer = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (!noAnswer || attempt >= SESSION_RETRY_DELAYS_MS.length) return null;
      await new Promise((resolve) => window.setTimeout(resolve, SESSION_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * What opening the app inside the Shopify admin came to: the account of the shop that opened it, or
 * the server's reason code for why it could not.
 */
export type EmbeddedSessionResult = { user: UserRow } | { code: string };

/**
 * Opens the app for the shop that is showing it.
 *
 * There is nothing to type and nothing to approve: App Bridge adds an ID token to this request on its
 * own, the backend checks it and, the first time a shop opens the app, exchanges it for an access
 * token. What comes back is the account — no token pair, nothing stored — and every later request
 * proves itself the same way.
 *
 * A server that does not answer is waited out briefly, as fetchSession does, rather than shown to the
 * merchant as a failure of their store.
 */
export async function openEmbeddedSession(): Promise<EmbeddedSessionResult> {
  if (!appBridgeAvailable()) return { code: 'APP_BRIDGE_MISSING' };
  // App Bridge intercepts `fetch` once it is ready; a request sent earlier would carry no token. It
  // never becomes ready when it was loaded without the app's key or outside the admin, and waiting
  // for it forever would leave the merchant on a spinner — so there is a limit, and it is reported.
  const ready = await Promise.race([
    shopify.ready.then(() => true),
    new Promise<false>((resolve) => window.setTimeout(() => resolve(false), APP_BRIDGE_READY_TIMEOUT_MS)),
  ]);
  if (!ready) return { code: 'APP_BRIDGE_MISSING' };

  for (let attempt = 0; ; attempt += 1) {
    try {
      const { user } = await api.post<{ user: UserRow; shop: string }>('/auth/shopify/embedded');
      return { user };
    } catch (error) {
      const noAnswer = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (noAnswer && attempt < SESSION_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => window.setTimeout(resolve, SESSION_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return { code: error instanceof ApiError && error.code ? error.code : 'open_failed' };
    }
  }
}
