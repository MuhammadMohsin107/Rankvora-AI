// ─── Running inside the Shopify admin ────────────────────────────────
//
// Rankvora AI is a Shopify app, and Shopify opens it inside an iframe in the merchant's admin. In
// that mode three things change, and this file is the one place that says when they do:
//
//   • WHO IS CALLING is proved by an ID token App Bridge adds to every request (see lib/api.ts), not
//     by a sign-in this app runs. There is no login page, no stored session and no browser storage
//     — the App Store requires that an embedded app work with cookies and local storage blocked.
//   • THE CHROME is Shopify's: the admin draws the sidebar, so the app's own sidebar and header are
//     not rendered (layouts/EmbeddedShell.tsx).
//   • A SITE THAT REFUSES TO BE FRAMED — Google's consent screen — has to be opened in the top-level
//     window, because inside the iframe it would load blank.
//
// Outside the admin (local development with MOCK_AUTH, a visit to the bare site) none of that applies
// and the app behaves as it always did.

/** Shopify adds `embedded=1`, `shop`, `host` and `id_token` to the URL it opens the app at. */
const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

function inFrame(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    // Reading `top` from a cross-origin parent throws — which is itself the answer: we are framed.
    return true;
  }
}

/**
 * Whether the page is shown inside the Shopify admin (or Shopify's mobile app).
 *
 * Decided once, when the page loads: the document is either inside the admin's frame or it is not,
 * and the URL's `embedded` flag is read before the app's own navigation rewrites the query string.
 */
export const EMBEDDED: boolean = inFrame() || params.get('embedded') === '1';

export function isEmbedded(): boolean {
  return EMBEDDED;
}

/** Whether App Bridge loaded. False means its script was blocked or never arrived. */
export function appBridgeAvailable(): boolean {
  return typeof shopify !== 'undefined';
}

/**
 * A fresh ID token, for requests that do not go through `fetch` — App Bridge adds the token to
 * `fetch` calls on its own, but not to an XMLHttpRequest (uploads use one, to report progress).
 * Null outside the admin or when App Bridge is not there. A token lasts about a minute, so each
 * request asks for its own.
 */
export async function currentIdToken(): Promise<string | null> {
  if (!EMBEDDED || !appBridgeAvailable()) return null;
  try {
    await shopify.ready;
    return await shopify.idToken();
  } catch {
    return null;
  }
}

/**
 * Opens a page in the top-level window, leaving the Shopify admin.
 *
 * Inside the admin `window.location` would load the page in the app's own iframe, which Google (and
 * most sign-in screens) refuse to render. `open(url, '_top')` is how an embedded app leaves the frame.
 */
export function openOutsideAdmin(url: string): void {
  if (EMBEDDED) window.open(url, '_top');
  else window.location.assign(url);
}
