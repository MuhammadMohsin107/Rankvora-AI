import { resolveStoreDataProvider } from '../audit-engine/store-data/index.js';
import type { SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import { assess as assessAgentic } from '../audit-engine/checks/ai-discovery/agentic-attrs.js';
import { assess as assessFeed, duplicateSkusWithin } from '../audit-engine/checks/ai-discovery/feed.js';
import { assess as assessAnswerable } from '../audit-engine/checks/ai-discovery/answerable-qa.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, type RowStatus } from '../audit-engine/checks/shared/status.js';
import { splitByPublication } from '../audit-engine/checks/shared/published.js';

/**
 * ─── Per-product AI readiness ────────────────────────────────────────
 *
 * The AI Discovery pillar scores SUB-PILLARS: "84% of products carry a usable identifier". That is
 * the right shape for a score and the wrong shape for a work queue. A merchant who reads "16% are
 * missing something" immediately asks the one question the pillar cannot answer — WHICH ONES? —
 * and has to open three separate sub-pillar pages and reconcile three evidence tables by hand.
 *
 * This inverts the same measurements: one row per product, carrying every AI Discovery verdict
 * that applies to it.
 *
 * ─── IT MEASURES NOTHING OF ITS OWN, AND THAT IS THE POINT ───────────
 * Every verdict here comes from the SAME `assess()` function the corresponding check calls during
 * an audit:
 *
 *   agentic-attrs  can an agent act on this product — stock, distinguishable variants, attributes
 *   feed           can an agent match and compare it — identifier, price, brand, category
 *   answerable-qa  does the description answer what a shopper asks before buying
 *
 * Those three are imported, not reimplemented. If a check's rule changes, this changes with it. A
 * second copy of the logic would drift, and the two surfaces would then disagree about the same
 * product while both claimed to be measuring it — which is worse than not having this at all.
 *
 * ─── WHY ONLY THREE OF THE SEVEN SUB-PILLARS ─────────────────────────
 * The other four are not properties of a product and cannot be attributed to one. robots.txt
 * crawler access, the IndexNow key file, agents.md and prompt tracking are all STORE-level facts:
 * they are equally true of every product, so a per-product column for them would repeat one value
 * down the page and imply a per-product difference that does not exist.
 *
 * ─── THE SCORE IS A COUNT, NOT A MODEL ───────────────────────────────
 * `readinessScore` is the share of applicable checks this product passed, rounded. There is no
 * weighting, no tuned coefficient and no threshold pulled from nowhere — three checks pass or do
 * not, and 2 of 3 is 67. A weighted score would be a judgement presented as a measurement, and
 * nobody could audit it.
 */

/** One sub-pillar's verdict on one product. */
export interface ProductSignal {
  /** The sub-pillar slug, so the UI can deep-link to the page that explains it. */
  subPillar: 'agentic-attrs' | 'feed' | 'answerable-qa';
  label: string;
  status: RowStatus;
  /**
   * False when the check could not reach a verdict for this product — agentic-attrs on a product
   * whose variants Shopify did not return in full. Such a signal is shown, and left out of
   * `passed`, `applicable`, the score and the product's status, instead of counting as a failure.
   */
  measured: boolean;
  /** The specific problem, as the check itself worded it. Empty when the product passed. */
  issue: string;
  detail: string;
  recommendation: string;
}

export interface ProductReadiness {
  /** Shopify's product id, so the UI can link into the admin. */
  id: string;
  title: string;
  handle: string;
  /** Null when the store has no primary domain recorded — never a guessed URL. */
  url: string | null;
  vendor: string;
  productType: string;
  /** Share of applicable checks passed, 0-100. See the header: a count, not a model. */
  readinessScore: number;
  /** Worst status across the signals — what the row is sorted and filtered by. */
  status: RowStatus;
  signals: ProductSignal[];
  /** How many of the three checks this product passed, and how many applied to it. */
  passed: number;
  applicable: number;
}

export interface ProductReadinessSummary {
  /** Products actually assessed. Equals the number the snapshot carried, which may be capped. */
  analyzed: number;
  healthy: number;
  needsWork: number;
  critical: number;
  /** Mean readiness across assessed products, or null when none were assessed. */
  averageScore: number | null;
  /**
   * What the catalogue actually holds, when Shopify reported it. Null means the total could not be
   * read — which is "unknown", NOT "equal to analyzed". The UI must not infer full coverage from it.
   */
  available: number | null;
  /** False when Shopify reported the total as AT_LEAST rather than a firm count. */
  exact: boolean | null;
  /** True when the snapshot stopped short of the whole catalogue. */
  truncated: boolean;
  /**
   * Draft, archived and unpublished products that were read but not assessed. No shopper or
   * assistant can reach them, so ranking them "not AI-ready" would describe pages that do not exist
   * — but they are counted, so `analyzed` beside Shopify's own total is explained, not a mystery.
   */
  unpublished: number;
  capturedAt: string;
}

export interface ProductReadinessResult {
  summary: ProductReadinessSummary;
  products: ProductReadiness[];
}

/** The worst of several statuses. Critical beats Needs Work beats Healthy. */
function worst(statuses: RowStatus[]): RowStatus {
  if (statuses.includes(CRITICAL)) return CRITICAL;
  if (statuses.includes(NEEDS_WORK)) return NEEDS_WORK;
  return HEALTHY;
}

/** The product's public URL, or null when no primary domain is recorded. Never guessed. */
function productUrl(snapshot: StoreSnapshot, handle: string): string | null {
  const origin = snapshot.shop.primaryUrl;
  if (!origin || !handle) return null;
  try {
    return new URL(`/products/${handle}`, origin).toString();
  } catch {
    return null;
  }
}

/** Runs the three product-level AI Discovery checks against one product. */
function assessProduct(snapshot: StoreSnapshot, product: SnapshotProduct): ProductReadiness {
  const agentic = assessAgentic(product);
  const feed = assessFeed(product, duplicateSkusWithin(product));
  const answerable = assessAnswerable({ bodyHtml: product.bodyHtml });

  const signals: ProductSignal[] = [
    {
      subPillar: 'agentic-attrs',
      label: 'Agent can act on it',
      status: agentic.status,
      measured: agentic.measured,
      issue: agentic.issue,
      detail: agentic.detail,
      recommendation: agentic.recommendation,
    },
    {
      subPillar: 'feed',
      label: 'Agent can match and compare it',
      status: feed.status,
      measured: true,
      issue: feed.issue,
      detail: feed.detail,
      recommendation: feed.recommendation,
    },
    {
      subPillar: 'answerable-qa',
      label: 'Description answers buying questions',
      status: answerable.status,
      measured: true,
      issue: answerable.issue,
      detail: answerable.detail,
      recommendation: answerable.recommendation,
    },
  ];

  // A signal that reached no verdict is neither passed nor failed — it does not apply to the count.
  const measured = signals.filter((signal) => signal.measured);
  const passed = measured.filter((signal) => signal.status === HEALTHY).length;
  const applicable = measured.length;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    url: productUrl(snapshot, product.handle),
    vendor: product.vendor,
    productType: product.productType,
    // A plain share of checks passed. See the header for why there is no weighting.
    // feed and answerable-qa always reach a verdict, so `applicable` is never 0 here.
    readinessScore: Math.round((passed / Math.max(applicable, 1)) * 100),
    status: worst(measured.map((signal) => signal.status)),
    signals,
    passed,
    applicable,
  };
}

/**
 * Every published product in the store's snapshot, ranked by how ready it is for AI discovery.
 *
 * Reads the store LIVE through the same provider an audit uses, rather than replaying the last
 * audit: a merchant opening this list has usually just edited the catalogue, and ranking them by a
 * week-old snapshot would send them to fix products they already fixed.
 *
 * Ordered worst-first — this is a work queue, and the top of it should be the next thing to do.
 */
export async function getProductAiReadiness(storeId: number): Promise<ProductReadinessResult> {
  const provider = await resolveStoreDataProvider(storeId);
  const snapshot = await provider.buildSnapshot();

  // Published products only — the same rule the three audit checks now apply, so this list and
  // their sub-pillar pages count the same products.
  const { published, unpublished } = splitByPublication(snapshot.products);
  const products = published.map((product) => assessProduct(snapshot, product));

  // Worst first, then by score, then by title so the order is stable between identical runs.
  const rank: Record<RowStatus, number> = { [CRITICAL]: 0, [NEEDS_WORK]: 1, [HEALTHY]: 2 };
  products.sort(
    (a, b) =>
      rank[a.status] - rank[b.status]
      || a.readinessScore - b.readinessScore
      || a.title.localeCompare(b.title),
  );

  const healthy = products.filter((product) => product.status === HEALTHY).length;
  const critical = products.filter((product) => product.status === CRITICAL).length;

  return {
    summary: {
      analyzed: products.length,
      healthy,
      critical,
      needsWork: products.length - healthy - critical,
      // Null rather than 0 for an empty catalogue: a store with no products has no average
      // readiness, and rendering 0% would read as "every product failed".
      averageScore:
        products.length > 0
          ? Math.round(products.reduce((sum, product) => sum + product.readinessScore, 0) / products.length)
          : null,
      available: snapshot.scope.productsAvailable?.count ?? null,
      exact: snapshot.scope.productsAvailable?.exact ?? null,
      truncated: snapshot.scope.productsTruncated,
      unpublished,
      capturedAt: snapshot.capturedAt.toISOString(),
    },
    products,
  };
}
