import { unavailableResult, type SubPillarResult } from '../../types.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawledPage, StorefrontCrawl } from '../../storefront/types.js';

/**
 * ─── Crawl evidence guard ────────────────────────────────────────────
 * The one place a check asks "do I have rendered-page evidence?".
 *
 * Every crawl-based check has the same failure modes — crawling switched off, the storefront
 * gated, the storefront unreachable — and every one of them must resolve to `not measured`, never
 * to a zero. Writing that per check would mean nine chances to get it subtly wrong, and the wrong
 * version scores a store 0 for something Rankvora AI simply could not look at.
 *
 * The reasons are phrased for a merchant reading a pillar page, because that is where they land.
 */

const REASONS: Record<string, (subject: string) => string> = {
  disabled: (subject) => `Storefront crawling is switched off for this Rankvora AI instance, so ${subject} could not be measured.`,
  password_gated: (subject) => `Your storefront is password protected, so Rankvora AI could not load any of your pages and ${subject} could not be measured. Remove the password under Online Store → Preferences in Shopify, then run the audit again.`,
  unreachable: (subject) => `Rankvora AI could not load any page of your storefront, so ${subject} could not be measured.`,
  no_targets: (subject) => `Rankvora AI found no published storefront pages to load, so ${subject} could not be measured.`,
};

/** Present only when there IS rendered evidence to reason about. */
export interface CrawlEvidence {
  crawl: StorefrontCrawl;
  pages: CrawledPage[];
}

/**
 * Why there is no rendered-page evidence, as a sentence — or null when there is some.
 *
 * For checks that measure something from Admin data as well, and so must still return a result
 * when the crawl half could not run: they state this sentence instead of going `unavailable`.
 */
export function crawlUnavailableSentence(snapshot: StoreSnapshot, subject: string): string | null {
  const crawl = snapshot.crawl;
  if (!crawl) return REASONS.disabled(subject);
  if (!crawl.available || crawl.pages.length === 0) {
    const build = REASONS[crawl.unavailableReason ?? 'unreachable'] ?? REASONS.unreachable;
    return build(subject);
  }
  return null;
}

/**
 * Returns the crawl evidence, or the `unavailable` result the check should return instead.
 *
 * `subject` completes the sentence "… so {subject} could not be measured", e.g. "structured data".
 */
export function requireCrawl(
  snapshot: StoreSnapshot,
  subPillar: string,
  subject: string,
): { ok: true; evidence: CrawlEvidence } | { ok: false; result: SubPillarResult } {
  const missing = crawlUnavailableSentence(snapshot, subject);
  if (missing !== null || !snapshot.crawl) {
    return { ok: false, result: unavailableResult(subPillar, missing ?? REASONS.disabled(subject)) };
  }
  return { ok: true, evidence: { crawl: snapshot.crawl, pages: snapshot.crawl.pages } };
}

/**
 * Sentence describing how much of the store the crawl actually covered.
 *
 * Appended to every crawl check's summary, because a result drawn from 12 sampled pages must
 * never read as though it described the whole catalogue. Stating the sample IS the honesty.
 */
export function crawlScopeNote(crawl: StorefrontCrawl): string {
  const byType = new Map<string, number>();
  for (const page of crawl.pages) byType.set(page.pageType, (byType.get(page.pageType) ?? 0) + 1);
  const breakdown = [...byType.entries()].map(([type, count]) => `${count} ${type}`).join(', ');
  const failed = crawl.failures.length > 0 ? ` ${crawl.failures.length} page(s) could not be loaded.` : '';
  return `Measured from ${crawl.pages.length} storefront page(s) Rankvora AI loaded (${breakdown}).${failed}`;
}

/** A short label for one crawled page, for evidence rows. */
export function pageLabel(page: CrawledPage): string {
  if (page.pageType === 'home') return 'Homepage';
  try {
    return new URL(page.finalUrl).pathname;
  } catch {
    return page.finalUrl;
  }
}

/**
 * The merchant's own name for the resource a crawled page was built from — the product, collection,
 * page or article title as it is in Shopify — so an evidence row names the thing rather than its
 * path.
 *
 * Read from the Admin snapshot by the id the crawl target carried, never from the rendered <title>:
 * that is the theme's output (usually with the shop name appended), not the resource's name. Null
 * when the page came from no snapshot resource, so the UI falls back to the path instead of
 * showing a name nobody gave it.
 */
export function pageName(snapshot: StoreSnapshot, page: CrawledPage): string | null {
  if (page.pageType === 'home') return 'Homepage';
  if (!page.resourceId) return null;
  const resources: Array<{ id: string; title: string }> =
    page.pageType === 'product' ? snapshot.products
      : page.pageType === 'collection' ? snapshot.collections
        : page.pageType === 'page' ? snapshot.pages
          : page.pageType === 'article' ? snapshot.articles
            : [];
  return resources.find((resource) => resource.id === page.resourceId)?.title.trim() || null;
}
