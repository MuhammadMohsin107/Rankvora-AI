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
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Whether a path belongs to the API (and the cron test hook) rather than to the website. */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/__scheduled';
}
