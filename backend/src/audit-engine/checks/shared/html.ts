/**
 * Minimal HTML → text utilities for checks that score body copy.
 *
 * Deliberately dependency-free and deliberately NOT a parser: Shopify's descriptionHtml is
 * merchant-authored fragment HTML, not a document, and every consumer here only needs "how much
 * readable prose is there". Pulling in a DOM parser to count words would be a heavier dependency
 * than the question warrants. If a check ever needs real structure (heading hierarchy, link
 * graphs), that belongs in the storefront-crawl layer against rendered HTML, not here.
 */

/** Strips tags and decodes the handful of entities Shopify's editor actually emits. */
export function htmlToText(html: string): string {
  return html
    // Drop script/style wholesale — their contents are never prose.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Treat block boundaries as whitespace so "</p><p>" does not glue two words together.
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word count of the readable text. Empty/whitespace-only HTML counts as 0, not 1. */
export function wordCount(html: string): number {
  const text = htmlToText(html);
  if (!text) return 0;
  return text.split(/\s+/).length;
}

/**
 * A normalized fingerprint used for near-duplicate detection.
 *
 * Lowercased, punctuation-stripped, whitespace-collapsed. Two descriptions that differ only in
 * the product name or in markup produce different fingerprints — this catches EXACT templated
 * reuse, not fuzzy similarity. That limit is intentional: real similarity scoring (shingling /
 * cosine) over 10k products is a different piece of engineering, and claiming "83% similar" from
 * an equality check would be a fabricated number.
 */
export function contentFingerprint(html: string): string {
  return htmlToText(html)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole days between `iso` and `now`. Returns null when the date is absent or unparseable. */
export function ageInDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/** Short human date for evidence cells, e.g. "Aug 28, 2026". Null-safe. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
