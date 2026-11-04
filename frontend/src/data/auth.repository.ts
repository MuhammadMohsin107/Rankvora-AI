import { api, ApiError } from '../lib/api';
import { clearTokens, getRefreshToken, setTokens } from '../lib/authTokens';
import { appBridgeAvailable } from '../lib/embedded';
import type { UserRow } from './api.types';

interface AuthPayload {
  user: UserRow;
  accessToken: string;
  refreshToken: string;
}

// ─── Sign in with Shopify ────────────────────────────────────────────
//
// Sign-in is Shopify only. The merchant approves Rankvora AI on Shopify's own screen, and the backend
// opens the store owner's account — or creates one from the shop's records for a new store.
//
// THE NONCE is what ties the end of a sign-in to the browser that started it. It is generated here,
// kept in sessionStorage (which survives the redirect to Shopify and back in the same tab), and only
// its hash travels through Shopify. Without it, a grant copied out of one browser — or planted into
// someone else's — could start a session.

const SHOPIFY_NONCE_KEY = 'scorelo.shopifySignInNonce';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mints and stores a fresh nonce. Throws when storage is unavailable, because a sign-in that
 * cannot remember its nonce can never be completed and should not be started. */
function beginNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = base64Url(bytes);
  try {
    window.sessionStorage.setItem(SHOPIFY_NONCE_KEY, nonce);
  } catch {
    throw new ApiError('Your browser is blocking site storage, which Shopify sign-in needs. Allow it for this site and try again.', 0, 'STORAGE_UNAVAILABLE');
  }
  return nonce;
}

/** Reads the nonce and removes it — a nonce is good for one completion attempt only. */
function takeNonce(): string | null {
  try {
    const nonce = window.sessionStorage.getItem(SHOPIFY_NONCE_KEY);
    window.sessionStorage.removeItem(SHOPIFY_NONCE_KEY);
    return nonce;
  } catch {
    return null;
  }
}

/** Sends the merchant to Shopify for the store address they typed. */
export async function startShopifySignIn(shop: string): Promise<void> {
  const nonce = beginNonce();
  const { url } = await api.post<{ url: string }>('/auth/shopify/start', { shop, nonce }, { skipAuth: true });
  window.location.assign(url);
}

/** Sends the merchant to Shopify for the store Shopify itself named when it opened Rankvora AI. */
export async function startShopifyLaunch(launch: Record<string, string>): Promise<void> {
  const nonce = beginNonce();
  const { url } = await api.post<{ url: string }>('/auth/shopify/launch', { launch, nonce }, { skipAuth: true });
  window.location.assign(url);
}

/**
 * Redeems the grant Shopify sign-in returned with, in this browser, and stores the session it
 * produced. Shopify's own sign-in is the whole authentication — there is no second step.
 */
export async function completeShopifySignIn(grant: string): Promise<UserRow> {
  const nonce = takeNonce();
  if (!nonce) {
    throw new ApiError('This Shopify sign-in has expired. Please start again.', 401, 'SHOPIFY_LOGIN_INVALID');
  }

  const payload = await api.post<AuthPayload>('/auth/shopify/complete', { grant, nonce }, { skipAuth: true });
  setTokens({ accessToken: payload.accessToken, refreshToken: payload.refreshToken });
  return payload.user;
}

/**
 * The signed query Shopify appends when it opens Rankvora AI (App Store install, or the admin's Apps
 * list), or null when this is an ordinary visit. Every key is kept exactly as sent — the backend
 * verifies an HMAC over all of them.
 */
export function readShopifyLaunch(search: string): Record<string, string> | null {
  const params = new URLSearchParams(search);
  if (!params.get('shop') || !params.get('hmac')) return null;
  const launch: Record<string, string> = {};
  params.forEach((value, key) => {
    launch[key] = value;
  });
  return launch;
}

/** The grant a completed Shopify sign-in returns with, carried in the URL fragment. */
export function readShopifyGrant(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('shopify_grant');
}

/**
 * The request reference the backend attached to a failed sign-in (`?ref=`), kept only when it has
 * the shape of the id the backend generates. It is what lets a failure a merchant reports be found
 * in the API log.
 */
export function readSignInReference(raw: string | null | undefined): string | undefined {
  return raw && /^[a-f0-9]{8,32}$/.test(raw) ? raw : undefined;
}

/** Merchant-facing wording for a Shopify sign-in failure — a redirect `reason` or an API error code.
 * Raw codes are never shown. A `reference` is appended so support can find the request in the log. */
export function describeShopifySignInFailure(code: string | null | undefined, reference?: string): string {
  const message = signInFailureWording(code);
  return reference ? `${message} (Reference: ${reference})` : message;
}

function signInFailureWording(code: string | null | undefined): string {
  switch (code) {
    case 'access_denied':
      return 'Shopify sign-in was cancelled. Nothing was connected.';
    case 'SHOPIFY_LOGIN_EMAIL_TAKEN':
      return 'A Rankvora AI account already uses this store’s email address. Contact support to connect this store to it.';
    case 'SHOPIFY_SCOPES_MISSING':
      return 'Shopify did not grant every permission Rankvora AI needs, so your store was not connected. Try again and approve all requested access.';
    case 'SHOPIFY_STORE_REQUIRED':
      return 'Your session ended because no Shopify store with Rankvora AI installed is linked to your account. Sign in with your store to continue.';
    case 'INVALID_REFRESH_TOKEN':
      return 'You were signed out. Sign in with your Shopify store to continue.';
    case 'SHOPIFY_LOGIN_NO_EMAIL':
      return 'Shopify did not share an email address for this store, so we could not create your account.';
    case 'SHOPIFY_LOGIN_INVALID':
    case 'SHOPIFY_STATE_INVALID':
      return 'This Shopify sign-in has expired. Please start again.';
    case 'SHOPIFY_HMAC_INVALID':
    case 'SHOPIFY_STATE_MISMATCH':
    case 'SHOPIFY_LAUNCH_INVALID':
      return 'Shopify sign-in failed its security check. Please try again.';
    case 'SHOPIFY_NOT_CONFIGURED':
      return 'Shopify sign-in is not configured on this server yet. Contact your administrator.';
    case 'SHOPIFY_TOKEN_EXCHANGE_FAILED':
      return 'Shopify did not accept the sign-in request. Please start again.';
    case 'SHOPIFY_READ_FAILED':
      return 'Shopify approved the sign-in, but we could not read your store afterwards. Please try again in a moment.';
    case 'SHOPIFY_LOGIN_UNAVAILABLE':
      return 'This Shopify store could not be matched to a Rankvora AI account. Contact support.';
    case 'SHOPIFY_ID_TOKEN_INVALID':
    case 'AUTHENTICATION_REQUIRED':
      return 'Shopify could not confirm this session. Reload the page, or open Rankvora AI again from Apps in your Shopify admin.';
    case 'SHOPIFY_NOT_INSTALLED':
      return 'Rankvora AI is not installed on this store, or was removed. Install it from the Shopify App Store and open it from Apps in your Shopify admin.';
    case 'APP_BRIDGE_MISSING':
      return 'Rankvora AI could not connect to your Shopify admin. Reload the page — and if you use an ad blocker, turn it off for the Shopify admin.';
    case 'SHOPIFY_STORE_MISMATCH':
      return 'This store address is on file for a different Shopify store. Contact support to sort out which store it belongs to.';
    case 'invalid_callback':
      return 'Shopify returned an incomplete sign-in response. Please start again.';
    case 'login_failed':
      return 'Something went wrong while finishing your sign-in. Please try again.';
    case 'STORAGE_UNAVAILABLE':
      return 'Your browser is blocking site storage, which Shopify sign-in needs. Allow it for this site and try again.';
    default:
      return 'We could not sign you in with Shopify. Please try again.';
  }
}

/** Clears the session locally even if the server call fails — the customer asked to sign out,
 * so the local session must not survive a network error. */
export async function logout(): Promise<void> {
  try {
    const refreshToken = getRefreshToken();
    // The refresh token identifies WHICH session is ending, so logging out on a phone does not
    // sign the customer out of their laptop. It travels in the POST body — the same path
    // /auth/refresh already uses — and the server hashes it to find the row. Without it the
    // server revokes every session, which is the safe direction to fail, never the other way.
    if (refreshToken) await api.post('/auth/logout', { refreshToken });
  } catch {
    // Intentionally ignored — local sign-out below is what the customer sees.
  } finally {
    clearTokens();
  }
}

/**
 * Resolves the signed-in customer, or null when there is no valid session.
 *
 * Works in both modes: with a real token it authenticates normally, and while the backend
 * runs with MOCK_AUTH (development only) it resolves the mock user — which is what keeps
 * local development working exactly as before without a login step.
 */
export async function fetchSession(): Promise<UserRow | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.get<UserRow>('/users/me');
    } catch (error) {
      // A 401 is a real answer: there is no session. No answer at all (a network drop, or the API
      // restarting during a deploy) is waited out briefly, rather than sending a signed-in customer
      // to the sign-in page. The saved session is kept either way.
      const noAnswer = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (!noAnswer || attempt >= SESSION_RETRY_DELAYS_MS.length) return null;
      await new Promise((resolve) => window.setTimeout(resolve, SESSION_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** The waits before each retry of a session check the server did not answer. */
const SESSION_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** How long to wait for App Bridge to finish starting before saying it is not there. */
const APP_BRIDGE_READY_TIMEOUT_MS = 10_000;

/**
 * What opening the app inside the Shopify admin came to: the account of the shop that opened it, or
 * the server's reason code for why it could not.
 */
export type EmbeddedSessionResult = { user: UserRow } | { code: string };

/**
 * Opens the app for the shop that is showing it — the embedded app's whole "sign-in".
 *
 * There is nothing to type and nothing to approve: App Bridge adds an ID token to this request on its
 * own (hence `skipAuth`, so none of this app's own credentials are attached), the backend checks it
 * and, the first time a shop opens the app, exchanges it for an access token. What comes back is the
 * account — no token pair, nothing stored — and every later request proves itself the same way.
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
      const { user } = await api.post<{ user: UserRow; shop: string }>('/auth/shopify/embedded', undefined, { skipAuth: true });
      return { user };
    } catch (error) {
      const noAnswer = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (noAnswer && attempt < SESSION_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => window.setTimeout(resolve, SESSION_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return { code: error instanceof ApiError && error.code ? error.code : 'login_failed' };
    }
  }
}
