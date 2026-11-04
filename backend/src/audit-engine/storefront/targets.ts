import type { StoreSnapshot } from '../store-data/types.js';
import type { CrawlTarget } from './crawler.js';
import { isPublishedProduct } from '../checks/shared/published.js';

/**
 * ─── Crawl target discovery ──────────────────────────────────────────
 * Decides WHICH storefront URLs an audit is allowed to fetch.
 *
 * Targets come from the Admin snapshot — the merchant's own products, collections, pages and
 * articles — plus the storefront root. Nothing is discovered by following links, which is what
 * keeps the crawl bounded, same-origin, and free of anything the merchant did not publish.
 *
 * WHY THE MIX MATTERS MORE THAN THE COUNT
 * The crawl budget is small next to a real catalogue, so how it is spent decides what can be
 * measured. Taking the first N products would mean a store's collections, pages and blog were
 * never seen, and every template-level defect on those page types would be invisible while the
 * audit reported itself complete. Sampling across page types instead means each TEMPLATE is
 * represented — which is the level at which theme defects actually live, since one product
 * template renders every product.
 */

/** Share of the page budget given to each resource type, after the homepage. Products dominate
 * because a store has more product templates in play, but never to the exclusion of the rest. */
const MIX: Array<{ type: CrawlTarget['pageType']; share: number }> = [
  { type: 'product', share: 0.5 },
  { type: 'collection', share: 0.2 },
  { type: 'page', share: 0.15 },
  { type: 'article', share: 0.15 },
];

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Spreads a sample across a list rather than taking the head of it.
 *
 * The snapshot arrives in Shopify's own order, which correlates with creation date — so the first
 * N products are the oldest N. Those are the least likely to represent how the store looks now.
 * An even stride costs nothing and samples the catalogue as it actually is.
 */
function spread<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];
  const step = items.length / count;
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.floor(index * step)]);
  }
  return picked;
}

/**
 * Builds the crawl list for one audit.
 *
 * The homepage is always included: it is the only page guaranteed to exist, it is where theme
 * level markup (organisation schema, navigation, third-party scripts) lives, and its
 * reachability is what tells the crawler whether the rest is worth attempting.
 */
export function buildCrawlTargets(snapshot: StoreSnapshot, maxPages: number): CrawlTarget[] {
  const origin = snapshot.shop.primaryUrl.replace(/\/$/, '');
  const targets: CrawlTarget[] = [{ url: `${origin}/`, pageType: 'home', resourceId: null }];

  const remaining = Math.max(0, maxPages - targets.length);
  if (remaining === 0) return targets;

  const pools: Record<string, Array<{ url: string; id: string }>> = {
    product: snapshot.products
      // An unpublished product's storefront URL 404s; crawling it would manufacture a broken page.
      // The shared rule, so the crawler and the AI Discovery checks agree on what is live.
      .filter(isPublishedProduct)
      .map((product) => ({ url: product.url, id: product.id })),
    collection: snapshot.collections.map((collection) => ({ url: collection.url, id: collection.id })),
    page: snapshot.pages.map((page) => ({ url: page.url, id: page.id })),
    article: snapshot.articles.map((article) => ({ url: article.url, id: article.id })),
  };

  // Allocate by share, then hand any unused allowance to the types that still have resources —
  // a store with no blog should spend that budget on products rather than crawling less.
  const allocations = MIX.map((entry) => ({
    type: entry.type,
    pool: pools[entry.type] ?? [],
    want: Math.floor(remaining * entry.share),
  }));

  let spare = remaining - allocations.reduce((sum, entry) => sum + Math.min(entry.want, entry.pool.length), 0);
  for (const allocation of allocations) {
    if (spare <= 0) break;
    const headroom = allocation.pool.length - Math.min(allocation.want, allocation.pool.length);
    const extra = Math.min(headroom, spare);
    allocation.want += extra;
    spare -= extra;
  }

  const seen = new Set<string>(targets.map((target) => target.url));
  for (const allocation of allocations) {
    for (const resource of spread(allocation.pool, allocation.want)) {
      if (!resource.url || seen.has(resource.url)) continue;
      // Belt and braces: the crawler refuses off-origin targets too, but a URL that cannot be
      // reached from this store should never even be proposed.
      if (!sameOrigin(resource.url, origin)) continue;
      seen.add(resource.url);
      targets.push({ url: resource.url, pageType: allocation.type, resourceId: resource.id });
      if (targets.length >= maxPages) return targets;
    }
  }

  return targets;
}
