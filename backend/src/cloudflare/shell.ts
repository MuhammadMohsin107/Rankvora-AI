/**
 * ─── Serving the website as an embedded Shopify app ──────────────────
 *
 * The site is a single-page app served from static assets. Inside the Shopify admin it runs in an
 * iframe, and the browser only allows that when the page's own response says who may frame it —
 * Shopify requires `Content-Security-Policy: frame-ancestors` naming the shop that is showing the app
 * and the admin itself, different for every shop and present on every response that renders HTML.
 * A static file cannot vary by shop, so the Worker answers page requests and adds the header.
 *
 * The page URL carries the shop: when Shopify opens the app it appends `?shop=<shop>.myshopify.com`
 * (plus `host`, `embedded` and `id_token`). That value arrives in the request, so it is checked
 * against the shape of a real shop domain before it is placed in a header — anything else is ignored.
 *
 * Kept free of Cloudflare-only imports so it runs, and is tested, on plain Node.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The shop a page URL names, when it is a real `*.myshopify.com` domain; otherwise null. */
export function shopFromUrl(url: URL): string | null {
  const shop = url.searchParams.get('shop')?.trim().toLowerCase();
  return shop && SHOP_DOMAIN.test(shop) ? shop : null;
}

/**
 * Who may frame a page.
 *
 * With a valid shop: exactly that shop and the admin, as Shopify documents. Without one — a reload
 * of an in-app route after the admin has dropped the query, or a visit outside the admin — Shopify's
 * own domains only. Never `*`, never `https:`: the page must not be frameable by an arbitrary site.
 */
export function frameAncestors(shop: string | null): string {
  return shop
    ? `frame-ancestors https://${shop} https://admin.shopify.com;`
    : 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;';
}

/** Where a browser sends a report each time the page does something the policy below would block. */
export const CSP_REPORT_PATH = '/api/csp-report';

const SHOPIFY_CDN = 'https://cdn.shopify.com';

/**
 * The content policy the page is measured against.
 *
 * Sent as Content-Security-Policy-Report-Only: the browser checks every script, style, image, font and
 * request against it and REPORTS what it would have blocked, but blocks nothing. That is deliberate. The
 * page runs inside the Shopify admin, where App Bridge and Polaris load code and open connections this
 * list may not yet name, and an enforced policy that misses one would break the app for every merchant.
 * Reports (see routes/csp-report.ts) say what is missing; once they are quiet on staging and in real
 * embedded sessions, the header name changes to Content-Security-Policy and the policy is enforced.
 *
 *   script-src    this site, Shopify's CDN (App Bridge, Polaris) and the page's own inline script, named
 *                 by hash. No 'unsafe-inline', no 'unsafe-eval': an injected script has nowhere to run.
 *   style-src     'unsafe-inline' stays: React sets style attributes and Polaris injects styles.
 *   img-src       any https image (a store's products and articles live on many hosts), plus data: and
 *                 blob: for generated images and upload previews.
 *   connect-src   this site's API and Shopify's own hosts.
 *   object-src / base-uri / form-action   closed.
 * Framing is a separate, enforced header (frameAncestors above) because it varies by shop.
 */
export function contentSecurityPolicy(inlineScriptHashes: readonly string[]): string {
  const scripts = ["'self'", SHOPIFY_CDN, ...inlineScriptHashes.map((hash) => `'sha256-${hash}'`)];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${SHOPIFY_CDN}`,
    "img-src 'self' data: blob: https:",
    `font-src 'self' data: ${SHOPIFY_CDN}`,
    "connect-src 'self' https://*.shopify.com https://*.myshopify.com https://*.shopifysvc.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/** SHA-256 of each inline <script> in a page, base64 — the form a script-src hash source takes. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  // Comments first: index.html's own comments talk about `<script>` tags, which are not scripts.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue; // an external script is allowed by its address, not its text
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[2]));
    hashes.push(btoa(String.fromCharCode(...new Uint8Array(digest))));
  }
  return [...new Set(hashes)];
}

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * Answers a request for the website from the static assets, adding the framing policy to any HTML
 * response (the SPA's index.html, which is also what every unknown path falls back to). Files — the
 * scripts, styles, fonts and images — pass through untouched.
 *
 * X-Frame-Options is removed from a page: it cannot name a shop, and where both headers are present
 * a browser enforces both, which would refuse the admin's frame whatever the policy above says.
 */
export async function serveWebsite(request: Request, assets: AssetFetcher): Promise<Response> {
  const response = await assets.fetch(request);
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) return response;

  const headers = new Headers(response.headers);
  headers.delete('X-Frame-Options');
  headers.set('Content-Security-Policy', frameAncestors(shopFromUrl(new URL(request.url))));

  // The report-only policy needs the page's text (to hash its inline script). If reading it fails the page
  // is still served, with the framing header alone — the policy is an addition, never a way to break the page.
  try {
    // Read a copy, so the page itself is still sent exactly as it came, byte for byte.
    const html = await response.clone().text();
    headers.set('Content-Security-Policy-Report-Only', contentSecurityPolicy(await inlineScriptHashes(html)));
  } catch (error) {
    console.error('[scorelo-csp] could not build the report-only policy:', error instanceof Error ? error.message : error);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Whether a path belongs to the API (and the cron test hook) rather than to the website. */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/__scheduled';
}
