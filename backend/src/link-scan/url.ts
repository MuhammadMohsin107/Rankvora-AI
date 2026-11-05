/**
 * ─── Addresses, as the link scan sees them ───────────────────────────
 *
 * A link scan asks one question of every address it meets — "does it answer?" — and asks it ONCE, so
 * what counts as "the same address" decides how many requests a store costs and whether a result can
 * be trusted. Three jobs here:
 *
 *   normalizeLink   one canonical spelling of an address: no #fragment, no tracking parameters, the host
 *                   in lower case. Two links that differ only in a utm_ tag are one address.
 *   hostsOf         which hosts are "the store": its primary domain, its myshopify.com address and the
 *                   www / bare variants of each. A link to any of them is an internal link.
 *   roleFor         whether an internal address is a page to load and read (and so crawl), or only a
 *                   target to ask about — a file, a utility page, a filtered or searched address.
 */

/** Parameters that identify who followed a link or which widget drew it — never which page it is. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'dclid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'mc_cid', 'mc_eid', 'igshid', 'srsltid', '_ga', '_gl', '_gac', 'mkt_tok', 'hsa_acc',
  // Shopify's own: search and recommendation tracking, and the variant a product card pre-selects.
  '_pos', '_sid', '_ss', '_fid', '_psq', 'oseid', 'variant',
  'pr_prod_strat', 'pr_rec_id', 'pr_rec_pid', 'pr_ref_pid', 'pr_seq',
]);

function isTracking(name: string): boolean {
  return name.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(name.toLowerCase());
}

/**
 * The canonical form of an absolute http(s) address, or null for anything else.
 * Fragment and tracking parameters are dropped, the rest of the query keeps its order, and a bare
 * trailing `?` goes. The path is left exactly as written: `/a` and `/a/` are different addresses to a
 * server, and deciding they are one would hide a link that really does break.
 */
export function normalizeLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (isTracking(name)) url.searchParams.delete(name);
  }
  return url.toString().replace(/\?$/, '');
}

/** `www.` removed, lower case — the form two hosts are compared in. */
function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Every host that is this store: each given host (a name, plus the port when it is not the default), with and without `www.`.
 * Built from addresses Shopify reported for the shop (its primary domain and its myshopify.com address) and
 * the one the storefront actually answered on — never from anything a merchant typed.
 */
export function hostsOf(...hosts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const host of hosts) {
    if (!host) continue;
    const name = bare(host);
    found.add(name);
    found.add(`www.${name}`);
  }
  return [...found];
}

export function isStoreHost(hosts: readonly string[], host: string): boolean {
  return hosts.includes(host.toLowerCase());
}

/** File types that are fetched to be shown, not read as a page: never crawled, only asked about. */
const FILE_EXTENSION = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|pdf|zip|gz|rar|7z|tar|docx?|xlsx?|pptx?|csv|mp[34]|m4a|mov|avi|webm|wav|ogg|woff2?|ttf|otf|eot|css|js|mjs|map|json|xml|txt|md|rss|atom)$/i;

/** Addresses that are not pages of content: crawling them finds nothing and, for some, changes something. */
const UTILITY_PATH = /^\/(?:cart|checkout|checkouts|account|search|password|admin|orders|cdn|apps|services|tools|wpm|\.well-known|_t)(?:\/|$)/i;

/**
 * A product reached through a collection (/collections/summer/products/linen-shirt). Themes link products this
 * way from every collection page, so one product is many addresses — each a real link that must work, but all
 * the same page as /products/linen-shirt, which is crawled once. Loading each of them as well would multiply
 * the scan's work by the number of collections a product is in and read the same links again and again.
 */
const COLLECTION_PRODUCT = /^\/collections\/[^/]+\/products\/[^/]+\/?$/i;

/**
 * 'page' when an address on the store should be loaded and its links read; 'target' when it should only be
 * asked about. A page is a clean address — no query string, which is where filters, sorting, searches and
 * pagination all live, and where a crawler gets lost in a space with no end — that is not a file or a
 * utility address.
 */
export function roleFor(url: string): 'page' | 'target' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'target';
  }
  if (parsed.search) return 'target';
  if (FILE_EXTENSION.test(parsed.pathname)) return 'target';
  if (UTILITY_PATH.test(parsed.pathname)) return 'target';
  if (COLLECTION_PRODUCT.test(parsed.pathname)) return 'target';
  return 'page';
}

/** True for a sitemap document: the scan reads it for the addresses it lists rather than for links. */
export function isSitemapUrl(url: string): boolean {
  try {
    return /\/sitemap[^/]*\.xml$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
