/**
 * ─── Canonical URL comparison ────────────────────────────────────────
 * Decides whether a canonical tag points at the page that declares it.
 *
 * Shared by the crawler (which only requests canonical targets that are NOT the page itself) and
 * the canonicals check (which classifies them), so the two can never disagree about what
 * "self-referencing" means.
 *
 * Deliberately forgiving about spelling and strict about identity. A trailing slash, letter case in
 * the path, or percent-encoding versus the raw character does not make a different document on
 * Shopify, so none of those is reported as a canonical pointing elsewhere. A different scheme,
 * host, path or query string does, and is.
 */

/**
 * Resolves a canonical href against the page it was found on. Null when it is empty, unparseable,
 * or not an http(s) URL — all of which a search engine discards, so the caller reports them.
 */
export function resolveCanonical(href: string, pageUrl: string): URL | null {
  if (!href.trim()) return null;
  try {
    const url = new URL(href.trim(), pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function comparablePath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding: compare it as written rather than throw mid-audit.
  }
  path = path.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** A string two URLs share exactly when they name the same document. */
export function comparableUrl(url: URL): string {
  return `${url.protocol}//${url.host}${comparablePath(url.pathname)}${url.search}`;
}

/** comparableUrl() for a raw string. Null when it does not parse. */
export function comparableFromString(value: string): string | null {
  try {
    return comparableUrl(new URL(value));
  } catch {
    return null;
  }
}
