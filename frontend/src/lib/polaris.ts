import { isEmbedded } from './embedded';
import { reportClientError } from './reportClientError';

// ─── Polaris web components 2.0 ──────────────────────────────────────
//
// index.html loads polaris-2.js from Shopify's CDN, which defines the `s-*` elements (<s-page>,
// <s-button>, <s-banner>, …). Until that script has run they are unknown tags and render as plain
// text — the same thing a merchant would see if the CDN were blocked, so this checks and says so.

/** Whether Polaris has defined its elements on this page. */
export function polarisAvailable(): boolean {
  return typeof customElements !== 'undefined' && customElements.get('s-button') !== undefined;
}

/**
 * Inside the Shopify admin, writes a line to the API log when Polaris did not arrive — blocked by an
 * extension or a network rule, or the CDN failed. Without it that would show only on the merchant's
 * screen, as unstyled text, and nobody running the app would ever hear of it.
 *
 * Checked a few seconds after the page has loaded, because the script is fetched from another host.
 * Fire-and-forget, like every client report: it can never break the page.
 */
export function watchPolaris(): void {
  if (typeof window === 'undefined' || !isEmbedded()) return;
  const check = () => {
    if (!polarisAvailable()) reportClientError(new Error('Polaris web components (polaris-2.js) did not load'));
  };
  if (document.readyState === 'complete') window.setTimeout(check, 3000);
  else window.addEventListener('load', () => window.setTimeout(check, 3000), { once: true });
}
