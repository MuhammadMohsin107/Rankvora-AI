import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { SnapshotProduct, StoreSnapshot } from '../../store-data/types.js';
import type { CrawlJsonLd, CrawledPage } from '../../storefront/types.js';
import { wordCount } from '../shared/html.js';
import { formatCount, pathOf, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, coveragePct, isDefaultOption, type RowStatus } from '../shared/status.js';
import { splitByPublication, unpublishedNote } from '../shared/published.js';
import { notCheckedFinding, renderedNotMeasured } from './unreadable.js';

/**
 * ─── AI Discovery · Agentic commerce attributes ──────────────────────
 * Measures whether a product exposes the signals an AI agent needs to COMPLETE A PURCHASE on a
 * shopper's behalf, rather than merely find it.
 *
 * HOW THIS DIFFERS FROM THE FEED CHECK, WHICH READS THE SAME VARIANTS
 * `feed` asks whether the product can be exported and matched — identifiers, price, brand,
 * category. This asks the next question: once an agent has found it, can the agent act? Those
 * come apart in practice. A product with a perfect GTIN and price whose every variant is out of
 * stock is flawless in a feed and useless to an agent asked to buy it. A product whose variants
 * are distinguishable only by an unnamed placeholder is exportable but not selectable, because
 * the agent has no attribute on which to choose the right one.
 *
 * WHAT IS MEASURED, IN ORDER OF WHAT BLOCKS AN AGENT FIRST
 *   nothing purchasable   Every variant availableForSale=false. The agent cannot transact.
 *   unselectable variants Several variants, no named option to choose between them.
 *   no description        Nothing to answer "is this waterproof?" with, so the agent cannot
 *                         qualify the product against what the shopper actually asked for.
 *   no structured attrs   No vendor, product type, tags or metafields — nothing to reason over
 *                         beyond the title.
 *
 * TWO SOURCES, BOTH REAL, NEITHER SUBSTITUTED FOR THE OTHER — AND NEVER COUNTED TOGETHER
 *   CATALOGUE (Admin)  What the merchant entered: stock, options, description, attributes. Counted
 *                      in PRODUCTS.
 *   RENDERED  (crawl)  What an agent arriving at the page can actually parse: whether the Product
 *                      JSON-LD carries an offer with a valid price, currency and availability.
 *                      Counted in PAGES.
 *
 * The two used to share one set of totals. The rendered test was added to the product count as
 * one extra "product" — a store with ten products read "Products 11" — and its failing pages were
 * added to the product issues, so twenty pages and five products read "Issues 25". The page's
 * Products, Healthy and Issues figures, its "% healthy" and "Products with stock", are now counted
 * over products alone; the rendered pages report their own figures, row by row. The SCORE still
 * weighs the rendered half as one unit beside the products, exactly as before.
 *
 * STOCK IS DECIDED FROM EVERY VARIANT. The products query reads the first 25 variants of each
 * product; the provider reads the rest of any published product whose first 25 are all sold out
 * (ShopifyStoreDataProvider.completeVariants), because only then does the answer depend on
 * variants not yet read. A product it still could not read in full is NOT MEASURED — left out of
 * the score and named as such — never reported as "nothing purchasable" on a partial read.
 *
 * When no crawl ran, the rendered half is reported as NOT MEASURED and excluded from the score.
 * It is never inferred from Admin `availableForSale` — the Admin API knows what the merchant set,
 * and only the storefront knows what the theme actually emitted.
 */

/** Below this a description is a fragment, not something an agent can answer questions from. */
const MIN_DESCRIPTION_WORDS = 20;

export interface Assessment {
  status: RowStatus;
  /**
   * False when the verdict depends on something Rankvora AI could not read — today, only the variants
   * of a product it could not read in full. Such a product is left out of every count and the
   * score rather than being given a verdict it has no evidence for.
   */
  measured: boolean;
  issue: string;
  detail: string;
  recommendation: string;
}

// ─── Stock, from every variant ───────────────────────────────────────

type StockVerdict =
  | { known: true; purchasable: number; read: number; total: number; partial: boolean }
  | { known: false; read: number; total: number };

/**
 * Whether the product can be bought, and on what evidence.
 *
 * One available variant among those read settles it — yes — however many were not read. NONE
 * available settles it only when every variant was read; otherwise the answer is in the variants
 * that were not.
 */
function stockOf(product: SnapshotProduct): StockVerdict {
  const read = product.variants.length;
  const total = Math.max(product.variantCount, read);
  const purchasable = product.variants.filter((variant) => variant.availableForSale).length;
  const complete = !product.variantsTruncated && read > 0;
  if (purchasable > 0) return { known: true, purchasable, read, total, partial: !complete };
  if (complete) return { known: true, purchasable: 0, read, total, partial: false };
  return { known: false, read, total };
}

function structuredAttributeCount(product: SnapshotProduct): number {
  let count = 0;
  if (product.vendor.trim()) count += 1;
  if (product.productType.trim()) count += 1;
  if (product.tags.length > 0) count += 1;
  if (product.metafields.some((metafield) => metafield.hasValue)) count += 1;
  return count;
}

/** "12 of 40 variants purchasable", or — when not every variant was read — says so. */
function stockDetail(stock: Extract<StockVerdict, { known: true }>): string {
  return stock.partial
    ? `${formatCount(stock.purchasable)} purchasable among the first ${formatCount(stock.read)} of ${formatCount(stock.total)} variants read`
    : `${formatCount(stock.purchasable)} of ${formatCount(stock.read)} variants purchasable`;
}

export function assess(product: SnapshotProduct): Assessment {
  const realOptions = product.options.filter((option) => !isDefaultOption(option));
  const words = wordCount(product.bodyHtml);
  const stock = stockOf(product);

  if (stock.known && stock.purchasable === 0) {
    return {
      status: CRITICAL,
      measured: true,
      issue: 'Nothing purchasable',
      // Every variant, because every variant was read — `known` with none purchasable means that.
      detail: `All ${formatCount(stock.read)} variants are unavailable for sale`,
      recommendation: 'Restock, or unpublish the product — an agent asked to buy this cannot complete the order.',
    };
  }

  // The remaining checks do not depend on stock, so a product whose stock is unknown can still
  // fail one of them — and that failure is a fact.
  if (product.variantCount > 1 && realOptions.length === 0) {
    return {
      // NEEDS WORK, to match the finding's severity ('high'). The rows used to say Critical while
      // the finding said high, so the Critical counter counted an issue rated high.
      status: NEEDS_WORK,
      measured: true,
      issue: 'Variants an agent cannot choose between',
      detail: `${formatCount(product.variantCount)} variants with no named option`,
      recommendation: 'Add a real option (Size, Colour) so an agent has an attribute to select on.',
    };
  }

  if (words === 0) {
    return {
      status: NEEDS_WORK,
      measured: true,
      issue: 'No description',
      detail: 'Product description is empty',
      recommendation: 'Write a description covering what the product is, what it is made of and who it is for.',
    };
  }

  if (words < MIN_DESCRIPTION_WORDS) {
    return {
      status: NEEDS_WORK,
      measured: true,
      issue: 'Description too short to answer questions',
      detail: `${words} words`,
      recommendation: `Expand past ${MIN_DESCRIPTION_WORDS} words with the attributes shoppers ask about — materials, fit, compatibility, care.`,
    };
  }

  const attributes = structuredAttributeCount(product);
  if (attributes < 2) {
    return {
      status: NEEDS_WORK,
      measured: true,
      issue: 'Almost no structured attributes',
      detail: `${attributes} of 4 attribute groups populated (brand, category, tags, metafields)`,
      recommendation: 'Fill in vendor, product type and tags so an agent can reason about this product beyond its title.',
    };
  }

  if (!stock.known) {
    // Everything else passed, so the verdict turns on stock — which was not fully read.
    return {
      status: NEEDS_WORK,
      measured: false,
      issue: 'Availability not measured',
      detail: stock.read === 0
        ? `None of its ${formatCount(stock.total)} variants could be read`
        : `None of the first ${formatCount(stock.read)} of ${formatCount(stock.total)} variants is for sale, and the rest could not be read`,
      recommendation: 'Run the audit again. The audit’s warnings name why Shopify did not return the remaining variants.',
    };
  }

  return {
    status: HEALTHY,
    measured: true,
    issue: '',
    detail: `${stockDetail(stock)} · ${attributes} of 4 attribute groups · ${words}-word description`,
    // Empty, not an em dash: the dash is how the table DISPLAYS an absent value, and writing it
    // here put a presentation choice inside the audit's data.
    recommendation: '',
  };
}

// ─── The rendered offer, field by field ──────────────────────────────

/**
 * schema.org's ItemAvailability values — the only strings the `availability` property is defined
 * to hold. A canonical vocabulary from the schema.org specification, not a measurement.
 */
const ITEM_AVAILABILITY = new Set([
  'backorder', 'discontinued', 'instock', 'instoreonly', 'limitedavailability', 'madetoorder',
  'onlineonly', 'outofstock', 'preorder', 'presale', 'reserved', 'soldout',
]);

export type OfferProblem =
  | { code: 'no-product' }
  | { code: 'no-offer' }
  | { code: 'price-missing' }
  | { code: 'price-invalid'; value: string }
  | { code: 'currency-missing' }
  | { code: 'currency-invalid'; value: string }
  | { code: 'availability-missing' }
  | { code: 'availability-invalid'; value: string };

export interface OfferAssessment {
  complete: boolean;
  /** Empty when complete. Otherwise what the most complete offer on the page lacks. */
  problems: OfferProblem[];
  /** The values of the complete offer that was found, for the evidence row. */
  found: { price: string; currency: string; availability: string } | null;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

/** A plain decimal: "92.50" or 92.5. Not "Rs. 92", not "1,299.00" — schema.org asks for a number. */
function isPlainPrice(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

/** An ISO 4217 code has exactly three letters. */
function isCurrencyCode(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value);
}

/** "https://schema.org/InStock", "http://schema.org/InStock", "schema:InStock" or "InStock". */
function isItemAvailability(value: string): boolean {
  const name = value.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');
  return ITEM_AVAILABILITY.has(name.toLowerCase());
}

/** What one offer node carries and lacks. A price may sit on the offer or in priceSpecification. */
function inspectOffer(record: Record<string, unknown>): { problems: OfferProblem[]; found: OfferAssessment['found'] } {
  const specNode = [record.priceSpecification].flat().find((node) => node && typeof node === 'object') as Record<string, unknown> | undefined;
  const price = text(record.price) ?? text(record.lowPrice) ?? text(specNode?.price);
  const currency = text(record.priceCurrency) ?? text(specNode?.priceCurrency);
  const availability = text(record.availability);

  const problems: OfferProblem[] = [];
  if (price === null) problems.push({ code: 'price-missing' });
  else if (!isPlainPrice(price)) problems.push({ code: 'price-invalid', value: price });
  if (currency === null) problems.push({ code: 'currency-missing' });
  else if (!isCurrencyCode(currency)) problems.push({ code: 'currency-invalid', value: currency });
  if (availability === null) problems.push({ code: 'availability-missing' });
  else if (!isItemAvailability(availability)) problems.push({ code: 'availability-invalid', value: availability });

  return {
    problems,
    found: problems.length === 0 ? { price: price!, currency: currency!.toUpperCase(), availability: availability! } : null,
  };
}

/**
 * What one rendered product page's structured data offers an agent.
 *
 * Walks `@graph` and arrays because Shopify themes emit Product schema in every shape: a bare
 * object, a graph, a list of offers per variant, an AggregateOffer around them. The page is
 * complete when ONE offer carries a valid price, currency and availability together — that is an
 * offer an agent can act on. Fields scattered across different offers do not add up to one. When no
 * offer is complete, the page reports what its most complete offer lacks.
 */
export function assessOffers(blocks: CrawlJsonLd[]): OfferAssessment {
  let hasProduct = false;
  const offers: Record<string, unknown>[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const types = [record['@type']].flat().filter((value): value is string => typeof value === 'string');
    if (types.some((type) => type.toLowerCase() === 'product' || type.toLowerCase() === 'productgroup')) hasProduct = true;
    if (types.some((type) => type.toLowerCase() === 'offer' || type.toLowerCase() === 'aggregateoffer')) offers.push(record);
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  for (const block of blocks) {
    if (block.parseError !== null) continue; // Invalid JSON-LD is seo/schema's finding, not ours.
    walk(block.data);
  }

  if (!hasProduct) return { complete: false, problems: [{ code: 'no-product' }], found: null };
  if (offers.length === 0) return { complete: false, problems: [{ code: 'no-offer' }], found: null };

  const inspected = offers.map(inspectOffer);
  const complete = inspected.find((offer) => offer.problems.length === 0);
  if (complete) return { complete: true, problems: [], found: complete.found };

  const closest = inspected.reduce((best, offer) => (offer.problems.length < best.problems.length ? offer : best));
  return { complete: false, problems: closest.problems, found: null };
}

/** The problem as a merchant reads it — naming the value found when it was the wrong one. */
export function describeOfferProblem(problem: OfferProblem): string {
  switch (problem.code) {
    case 'no-product': return 'No Product structured data on the page';
    case 'no-offer': return 'Product structured data has no offers node';
    case 'price-missing': return 'Offer has no price';
    case 'price-invalid': return `Offer price “${problem.value}” is not a plain number`;
    case 'currency-missing': return 'Offer has no priceCurrency';
    case 'currency-invalid': return `Offer priceCurrency “${problem.value}” is not a three-letter currency code`;
    case 'availability-missing': return 'Offer has no availability';
    case 'availability-invalid': return `Offer availability “${problem.value}” is not a schema.org availability value`;
  }
}

/**
 * What to do about the problem. The currency example is the store's OWN currency, read from
 * Shopify, not a sample value; with none on record the advice names the standard instead.
 */
export function offerAdvice(problem: OfferProblem, shopCurrency: string | null): string {
  const currencyExample = shopCurrency && isCurrencyCode(shopCurrency) ? ` — for this store, ${shopCurrency.toUpperCase()}` : '';
  switch (problem.code) {
    case 'no-product':
      return 'Add Product JSON-LD with an offers node to the product template. Without it an agent reading the page finds no product, price or availability.';
    case 'no-offer':
      return 'Add an offers node to the Product JSON-LD carrying price, priceCurrency and availability.';
    case 'price-missing':
      return 'Add price to the offer as a plain number.';
    case 'price-invalid':
      return 'Write the offer price as a plain number — digits and a dot for decimals, with no currency symbol and no thousands separator.';
    case 'currency-missing':
      return `Add priceCurrency to the offer as a three-letter ISO 4217 code${currencyExample}.`;
    case 'currency-invalid':
      return `Replace priceCurrency with the three-letter ISO 4217 code of the price${currencyExample}.`;
    case 'availability-missing':
      return 'Add availability to the offer with a schema.org value — https://schema.org/InStock when it can be bought, https://schema.org/OutOfStock when it cannot.';
    case 'availability-invalid':
      return 'Set availability to a schema.org ItemAvailability value such as https://schema.org/InStock or https://schema.org/OutOfStock.';
  }
}

/** One label per KIND of problem, for counting across pages ("12 have no availability"). */
function problemKind(problem: OfferProblem): string {
  switch (problem.code) {
    case 'no-product': return 'no Product structured data';
    case 'no-offer': return 'no offers node';
    case 'price-missing': return 'no price';
    case 'price-invalid': return 'a price that is not a plain number';
    case 'currency-missing': return 'no priceCurrency';
    case 'currency-invalid': return 'an invalid priceCurrency';
    case 'availability-missing': return 'no availability';
    case 'availability-invalid': return 'an invalid availability value';
  }
}

interface PageOutcome {
  page: CrawledPage;
  assessment: OfferAssessment;
}

// ─── The check ───────────────────────────────────────────────────────

export const agenticAttrsCheck: AuditCheck = {
  id: 'ai-discovery.agentic-attrs',
  pillar: 'ai-discovery',
  subPillar: 'agentic-attrs',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('agentic-attrs', 'Rankvora AI could not read products from this store, so agent-readable attributes could not be checked.');
    }

    if (snapshot.products.length === 0) {
      return unavailableResult('agentic-attrs', 'This store has no products, so there are no agent-readable attributes to assess.');
    }

    // Only what an agent can reach. A draft product has nothing to act on — its page answers 404.
    const { published: products, unpublished } = splitByPublication(snapshot.products);
    if (products.length === 0) {
      return unavailableResult(
        'agentic-attrs',
        `None of this store’s ${formatCount(unpublished)} products are published to the online store, so no AI agent can reach one to act on it.`,
      );
    }

    // ── The catalogue half: products ──
    const rows: SubPillarEvidenceRow[] = [];
    const byIssue = new Map<string, SnapshotProduct[]>();
    const notMeasured: SnapshotProduct[] = [];
    let healthy = 0;

    for (const product of products) {
      const assessment = assess(product);
      if (!assessment.measured) notMeasured.push(product);
      else if (assessment.status === HEALTHY) healthy += 1;
      else {
        const bucket = byIssue.get(assessment.issue) ?? [];
        bucket.push(product);
        byIssue.set(assessment.issue, bucket);
      }

      rows.push({
        id: `product:${product.id}`,
        unit: 'product',
        status: assessment.status,
        facet: assessment.status,
        cells: {
          signal: product.title,
          detail: assessment.issue || 'Agent-readable',
          // NO `coverage`. One product passes or it does not; 100 or 0 under a Coverage header was
          // a restatement of the Status beside it, dressed as a percentage nobody measured.
          status: assessment.status,
          recommendation: assessment.recommendation,
        },
        current: { label: 'Detected', value: assessment.detail, meta: product.url },
        ...(assessment.recommendation ? { suggested: { label: 'Recommendation', value: assessment.recommendation } } : {}),
      });
    }

    // The products that got a verdict. Every product figure on the page is out of these.
    const measuredProducts = products.length - notMeasured.length;
    const productIssues = measuredProducts - healthy;

    // ── The rendered half: pages ──
    // Counted only when a crawl really produced product pages. A store with no crawl is scored on
    // the catalogue it genuinely has, not marked down for evidence Rankvora AI never collected.
    const crawl = snapshot.crawl;
    const crawlUsable = Boolean(crawl?.available) && !crawl?.passwordGated;
    const productPages = crawlUsable && crawl ? crawl.pages.filter((page) => page.pageType === 'product') : [];
    const outcomes: PageOutcome[] = productPages.map((page) => ({ page, assessment: assessOffers(page.jsonLd) }));
    const incomplete = outcomes.filter((outcome) => !outcome.assessment.complete);
    const titleById = new Map(products.map((product) => [product.id, product.title]));

    for (const { page, assessment } of outcomes) {
      const productTitle = page.resourceId ? titleById.get(page.resourceId) : undefined;
      const problems = assessment.problems.map(describeOfferProblem).join('; ');
      const advice = [...new Set(assessment.problems.map((problem) => offerAdvice(problem, snapshot.shop.currency)))].join(' ');
      const found = assessment.found;
      rows.push({
        id: `page:${page.finalUrl}`,
        unit: 'page',
        status: assessment.complete ? HEALTHY : NEEDS_WORK,
        facet: 'Rendered offer data',
        cells: {
          signal: productTitle ? `${productTitle} · rendered page` : pathOf(page.finalUrl),
          detail: assessment.complete ? 'Complete offer' : problems,
          status: assessment.complete ? HEALTHY : NEEDS_WORK,
          recommendation: advice,
        },
        current: {
          label: 'Measured',
          // The values actually read off the page when the offer is complete — not a restatement.
          value: found ? `price ${found.price} ${found.currency} · ${found.availability}` : problems,
          meta: page.finalUrl,
        },
        ...(advice ? { suggested: { label: 'Recommendation', value: advice } } : {}),
      });
    }

    // Scored exactly as before: the rendered half weighs as ONE unit beside the products it
    // describes, healthy only when every crawled product page emits a complete offer.
    const renderedUnits = productPages.length > 0 ? 1 : 0;
    const renderedHealthyUnits = productPages.length > 0 && incomplete.length === 0 ? 1 : 0;

    // Nothing reached a verdict at all. The scorer reads zero units as "nothing to check" and
    // returns 100 — right for a store with no blog, wrong here, where there was plenty to check
    // and none of it could be read.
    if (measuredProducts === 0 && renderedUnits === 0) {
      return unavailableResult(
        'agentic-attrs',
        `Rankvora AI could not fully read the variants of any of this store’s ${formatCount(products.length)} published products, so whether an agent can buy them was not measured. Run the audit again; its warnings name why Shopify did not return them.`,
      );
    }

    if (productPages.length === 0 && crawl) {
      // Stated, not silently omitted — but with NO coverage figure. Nothing was read, so any number
      // here, including 0, would be a measurement that did not happen.
      //
      // Only when a crawl was ATTEMPTED for this store. With crawling switched off for the whole
      // server there is no row and no finding — just the summary sentence — because a "could not
      // be checked" item on every audit, about an operator setting, is noise the merchant can do
      // nothing about.
      const why = renderedNotMeasured(snapshot, 'product page');
      rows.push({
        id: 'rendered:offers',
        unit: 'page',
        status: NEEDS_WORK,
        facet: 'Rendered offer data',
        cells: {
          signal: 'Product JSON-LD offer completeness',
          detail: `Not measured — ${why.detail}`,
          status: NEEDS_WORK,
          recommendation: why.recommendation,
        },
        current: { label: 'Measured', value: 'Not measured on this run', meta: why.detail },
        suggested: { label: 'Recommendation', value: why.recommendation },
      });
    }

    const scoredUnits = measuredProducts + renderedUnits;
    const findings: SubPillarFindingResult[] = [];
    // Unchanged in method: a finding's share of the scored units.
    const lift = (count: number) => (scoredUnits > 0 ? Math.round((count / scoredUnits) * 100) : 0);
    const bucket = (issue: string) => byIssue.get(issue) ?? [];
    const rowsFor = (issue: string) => rows.filter((row) => row.unit === 'product' && row.cells.detail === issue).slice(0, 20);

    const unpurchasable = bucket('Nothing purchasable');
    if (unpurchasable.length > 0) {
      findings.push({
        title: 'Products with no purchasable variant',
        severity: 'critical',
        affectedCount: unpurchasable.length,
        affectedLabel: 'products',
        scoreLift: lift(unpurchasable.length),
        resolutionType: 'catalog',
        // "Published" is true: `products` holds only what is live on the online store. "Every
        // variant" is true: a product is only here when all of its variants were read.
        problem: `${formatCount(unpurchasable.length)} published products have every variant marked unavailable for sale.`,
        why: 'An AI shopping agent that surfaces one of these and is told to buy it hits a dead end at the last step. That failure is attributed to your store, and these products are still being crawled, indexed and recommended while none of them can be bought.',
        recommendation: 'Restock these products or unpublish them. A product that cannot be bought should not be discoverable as though it can.',
        evidence: [
          `${formatCount(unpurchasable.length)} of ${formatCount(measuredProducts)} products have no purchasable variant.`,
          ...unpurchasable.slice(0, 5).map((product) => `${product.title}: all ${formatCount(product.variants.length)} variants unavailable.`),
        ],
        evidenceRows: rowsFor('Nothing purchasable'),
        details: { issueType: CRITICAL, population: measuredProducts },
      });
    }

    const unselectable = bucket('Variants an agent cannot choose between');
    if (unselectable.length > 0) {
      findings.push({
        title: 'Products whose variants have no attribute to select on',
        severity: 'high',
        affectedCount: unselectable.length,
        affectedLabel: 'products',
        scoreLift: lift(unselectable.length),
        resolutionType: 'catalog',
        problem: `${formatCount(unselectable.length)} products have several variants but no option the merchant named.`,
        why: 'To buy the right variant an agent needs a named attribute to match the request against — "size large", "in black". With only an unnamed placeholder there is nothing to match, so the agent either guesses or gives up.',
        recommendation: 'Add a real option to each of these products so both shoppers and agents can identify which variant is which.',
        evidence: unselectable.slice(0, 5).map((product) => `${product.title}: ${formatCount(product.variantCount)} variants, no named option.`),
        evidenceRows: rowsFor('Variants an agent cannot choose between'),
        // Needs Work, as its rows are: the severity is 'high', and Critical is reserved for 'critical'.
        details: { issueType: NEEDS_WORK, population: measuredProducts },
      });
    }

    const thinDescription = [...bucket('No description'), ...bucket('Description too short to answer questions')];
    if (thinDescription.length > 0) {
      findings.push({
        title: 'Products with too little description for an agent to qualify',
        severity: 'medium',
        affectedCount: thinDescription.length,
        affectedLabel: 'products',
        scoreLift: lift(thinDescription.length),
        resolutionType: 'content',
        problem: `${formatCount(thinDescription.length)} products have an empty description or fewer than ${MIN_DESCRIPTION_WORDS} words.`,
        why: 'Agents answer qualifying questions — is it waterproof, does it fit a 15-inch laptop, is it machine washable — from the description. With nothing to read, the product is dropped from any request more specific than its own title.',
        recommendation: `Write at least ${MIN_DESCRIPTION_WORDS} words per product covering materials, dimensions, compatibility and care.`,
        evidence: [
          `${formatCount(thinDescription.length)} of ${formatCount(measuredProducts)} products fall below ${MIN_DESCRIPTION_WORDS} words.`,
          ...thinDescription.slice(0, 5).map((product) => `${product.title}: ${wordCount(product.bodyHtml)} words.`),
        ],
        evidenceRows: [...rowsFor('No description'), ...rowsFor('Description too short to answer questions')].slice(0, 20),
        details: { issueType: NEEDS_WORK, population: measuredProducts },
      });
    }

    const unstructured = bucket('Almost no structured attributes');
    if (unstructured.length > 0) {
      findings.push({
        title: 'Products with almost no structured attributes',
        severity: 'medium',
        affectedCount: unstructured.length,
        affectedLabel: 'products',
        scoreLift: lift(unstructured.length),
        resolutionType: 'catalog',
        problem: `${formatCount(unstructured.length)} products populate fewer than two of the four attribute groups (brand, category, tags, metafields).`,
        why: 'Prose has to be interpreted; structured attributes can be filtered on directly. A product with neither brand nor category can only be retrieved by someone who already knows its name — which is the opposite of discovery.',
        recommendation: 'Set vendor and product type at minimum, then add tags and product metafields for the attributes shoppers filter by.',
        evidence: unstructured.slice(0, 5).map((product) => `${product.title}: ${structuredAttributeCount(product)} of 4 attribute groups populated.`),
        evidenceRows: rowsFor('Almost no structured attributes'),
        details: { issueType: NEEDS_WORK, population: measuredProducts },
      });
    }

    if (notMeasured.length > 0) {
      findings.push(notCheckedFinding({
        title: 'Products whose availability could not be fully read',
        rows: rows.filter((row) => row.unit === 'product' && row.cells.detail === 'Availability not measured').slice(0, 20),
        affectedLabel: 'products',
        problem: `${formatCount(notMeasured.length)} published products have more variants than Rankvora AI read, none of those it read is for sale, and Shopify did not return the rest on this run.`,
        why: 'Whether any of their variants can be bought depends on the variants Rankvora AI could not read. They are left out of the score and every product figure on this page rather than reported as unpurchasable on a partial read.',
        recommendation: 'Run the audit again. If this repeats, the audit’s warnings name why Shopify did not return the remaining variants.',
        evidence: notMeasured.slice(0, 5).map((product) => `${product.title}: ${formatCount(product.variants.length)} of ${formatCount(product.variantCount)} variants read, none for sale.`),
        affectedCount: notMeasured.length,
        population: products.length,
      }));
    }

    if (incomplete.length > 0) {
      // Each kind of problem, counted across the pages that have it — the finding says what was
      // actually found and advises on exactly that, not one sentence for every failure.
      const kinds = new Map<string, { count: number; advice: string }>();
      for (const { assessment } of incomplete) {
        for (const problem of assessment.problems) {
          const kind = problemKind(problem);
          const entry = kinds.get(kind) ?? { count: 0, advice: offerAdvice(problem, snapshot.shop.currency) };
          entry.count += 1;
          kinds.set(kind, entry);
        }
      }
      const ranked = [...kinds.entries()].sort((a, b) => b[1].count - a[1].count);
      const pageWord = (count: number) => (count === 1 ? 'page' : 'pages');

      findings.push({
        title: 'Rendered product pages without a complete offer',
        severity: 'high',
        affectedCount: incomplete.length,
        affectedLabel: 'pages',
        scoreLift: lift(renderedUnits),
        resolutionType: 'schema',
        problem: `${formatCount(incomplete.length)} of ${formatCount(productPages.length)} crawled product pages emit no offer with a valid price, priceCurrency and availability together: ${
          ranked.map(([kind, entry]) => `${formatCount(entry.count)} ${entry.count === 1 ? 'has' : 'have'} ${kind}`).join(', ')
        }.`,
        why: 'An agent arriving at the page reads the offers node to learn the price, the currency it is in, and whether the item can be bought. Missing any one leaves the question half answered, and an agent that cannot confirm a product is purchasable will not put it in front of someone who asked to buy one. This is about what the theme EMITS, which is why it is measured from the rendered page rather than from the catalogue — a product marked in stock in Shopify can still render markup that never says so.',
        recommendation: ranked
          .map(([, entry]) => `${formatCount(entry.count)} ${pageWord(entry.count)}: ${entry.advice}`)
          .join(' '),
        evidence: incomplete.slice(0, 5).map(({ page, assessment }) => `${page.finalUrl}: ${assessment.problems.map(describeOfferProblem).join('; ')}.`),
        evidenceRows: rows.filter((row) => row.unit === 'page' && row.status !== HEALTHY).slice(0, 20),
        details: { issueType: NEEDS_WORK, population: productPages.length },
      });
    }

    if (productPages.length === 0 && crawl) {
      const why = renderedNotMeasured(snapshot, 'product page');
      findings.push(notCheckedFinding({
        title: 'Rendered offer data could not be checked',
        rows: rows.filter((row) => row.id === 'rendered:offers'),
        affectedLabel: 'signal',
        problem: `Rankvora AI did not read a rendered product page on this run: ${why.detail}.`,
        why: 'Whether an agent can see a price, a currency and an availability value depends on what the theme emits, which only a rendered page shows. The catalogue half of this check was measured; this half was not, and is left out of the score rather than guessed.',
        recommendation: why.recommendation,
        evidence: [`Rendered offer data: not measured — ${why.detail}.`],
      }));
    }

    // Products whose stock is known, and how many of them can be bought.
    const stockKnown = products.filter((product) => stockOf(product).known);
    const withStock = stockKnown.filter((product) => {
      const stock = stockOf(product);
      return stock.known && stock.purchasable > 0;
    }).length;

    const renderedSentence = productPages.length > 0
      ? incomplete.length === 0
        ? ` All ${formatCount(productPages.length)} crawled product pages emit an offer with a valid price, priceCurrency and availability.`
        : ` ${formatCount(incomplete.length)} of ${formatCount(productPages.length)} crawled product pages do not emit a complete offer.`
      : ` Rendered offer data was not measured on this run — ${renderedNotMeasured(snapshot, 'product page').detail}.`;
    const notMeasuredSentence = notMeasured.length > 0
      ? ` ${formatCount(notMeasured.length)} more ${notMeasured.length === 1 ? 'product was' : 'products were'} not fully measured: none of the variants read is for sale, and Shopify did not return the rest.`
      : '';

    return {
      subPillar: 'agentic-attrs',
      status: 'ok',
      score: scoreSubPillar(scoredUnits, healthy + renderedHealthyUnits, findings),
      // PRODUCTS, both of them — the page labels these "Products" and "Healthy".
      analyzedCount: measuredProducts,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(measuredProducts)} published products expose what an AI agent needs to act — something in stock, variants it can tell apart, and enough description and structured attributes to qualify the product.${notMeasuredSentence}${renderedSentence}${unpublishedNote(unpublished)}`,
        // Whole percent of PRODUCTS: a decimal place implies a precision these counts do not carry,
        // and pages are a different population.
        healthChip: `${coveragePct(healthy, measuredProducts)}% healthy`,
        contextLabel: 'Products with stock',
        // Out of the products whose stock was actually determined — not a guess for the rest.
        contextValue: stockKnown.length > 0 ? `${coveragePct(withStock, stockKnown.length)}%` : 'Not measured',
        issueCount: productIssues,
        issueUnits: [
          { unit: 'product', flagged: productIssues, of: measuredProducts },
          ...(productPages.length > 0 ? [{ unit: 'page', flagged: incomplete.length, of: productPages.length }] : []),
        ],
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
