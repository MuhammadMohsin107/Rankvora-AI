import type { ShopifyClient } from './shopify-client.js';
import {
  ARTICLES_QUERY,
  COLLECTIONS_QUERY,
  PAGES_QUERY,
  POLICIES_QUERY,
  PRODUCTS_QUERY,
  PRODUCT_VARIANTS_QUERY,
  PRODUCT_VARIANT_SAMPLE_LIMIT,
  fetchCatalogTotals, fetchShopIdentity,
  type ArticlesResponse,
  type CollectionsResponse,
  type GqlArticle,
  type GqlCollection,
  type GqlMediaImage,
  type GqlMetafield,
  type GqlPage,
  type GqlProduct,
  type GqlProductOption,
  type GqlProductVariant,
  type PagesResponse,
  type PoliciesResponse,
  type ProductsResponse,
  type ProductVariantsResponse,
  fetchAllHandles,
  fetchTheme,
  fetchUrlRedirects,
} from './shopify.queries.js';
import { probeStorefront } from './storefront-probe.js';
import { StorefrontCrawler } from '../storefront/crawler.js';
import { buildCrawlTargets } from '../storefront/targets.js';
import { crawlConfigured, env } from '../../config/env.js';
import { describeError } from '../../lib/logger.js';
// The one definition of "a shopper can reach it", shared with the checks and the crawler.
import { isPublishedProduct } from '../checks/shared/published.js';
import {
  StoreDataError,
  type HandleResourceType,
  type SnapshotArticle,
  type SnapshotCollection,
  type SnapshotHandle,
  type SnapshotHandleIndex,
  type SnapshotImage,
  type SnapshotPage,
  type SnapshotPolicy,
  type SnapshotPolicyAccess,
  type SnapshotAiDiscovery,
  type SnapshotPageSpeed,
  type SnapshotProduct,
  type SnapshotProductOption,
  type SnapshotProgress,
  type SnapshotShop,
  type SnapshotStep,
  type SnapshotVariant,
  type StoreDataProvider,
  type StoreSnapshot,
} from './types.js';
import type { StorefrontCrawl } from '../storefront/types.js';

const COLLECTION_LIMIT = 250;
const PAGE_LIMIT = 250;
const ARTICLE_LIMIT = 250;

/** Every field below is treated as untrusted: Shopify shape changes, nulls and oversized
 * values must never crash the worker (master prompt: SHOPIFY DATA SAFETY). */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** GraphQL ids are gids (gid://shopify/Product/123). The numeric suffix is what merchants see in
 * admin URLs, so it is what evidence rows should reference. */
function id(gid: unknown): string {
  const raw = typeof gid === 'string' ? gid : '';
  if (!raw) return '';
  const tail = raw.split('/').pop();
  return tail && /^\d+$/.test(tail) ? tail : raw;
}

/** A `media` connection contains every media type; non-image nodes come back as empty objects
 * because the query only spreads MediaImage. Those are dropped, not emitted as broken rows. */
function normalizeMedia(raw: GqlMediaImage | null | undefined): SnapshotImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = str(raw.image?.url);
  if (!src) return null;
  return {
    id: id(raw.id),
    src,
    // Preserved exactly: null alt means "no attribute", '' means "present but empty".
    alt: typeof raw.alt === 'string' ? raw.alt : null,
    width: num(raw.image?.width),
    height: num(raw.image?.height),
  };
}

/** Option placeholders are preserved verbatim — `Title`/`Default Title` is the signal that a
 * product has no real options, and collapsing it here would hide it from the CRO check. */
function normalizeOptions(raw: GqlProductOption[] | null | undefined): SnapshotProductOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((option) => ({
    name: str(option?.name),
    values: Array.isArray(option?.values) ? option.values.filter((value): value is string => typeof value === 'string') : [],
  }));
}

function normalizeVariants(nodes: GqlProductVariant[] | null | undefined): SnapshotVariant[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((variant) => ({
    id: id(variant?.id),
    // '' is Shopify's way of saying "no SKU set"; both it and null mean absent to every check.
    sku: nullableStr(variant?.sku),
    barcode: nullableStr(variant?.barcode),
    // price arrives as a decimal string ("92.50"). num() handles that; a real 0 survives as 0.
    price: num(variant?.price),
    availableForSale: variant?.availableForSale === true,
  }));
}

function normalizeMetafields(nodes: GqlMetafield[] | null | undefined) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((metafield) => ({
    namespace: str(metafield?.namespace),
    key: str(metafield?.key),
    type: str(metafield?.type),
    hasValue: metafield?.value !== null && metafield?.value !== undefined && String(metafield.value).trim().length > 0,
  }));
}

/**
 * Pages and Articles have no `seo` field — the online store stores their SEO overrides as
 * `global.title_tag` / `global.description_tag` metafields. Products and Collections expose
 * `seo` natively and do not go through here.
 */
function seoFromMetafields(nodes: GqlMetafield[] | null | undefined): { title: string | null; description: string | null } {
  const result = { title: null as string | null, description: null as string | null };
  if (!Array.isArray(nodes)) return result;
  for (const metafield of nodes) {
    if (str(metafield?.namespace) !== 'global') continue;
    if (str(metafield?.key) === 'title_tag') result.title = nullableStr(metafield?.value);
    if (str(metafield?.key) === 'description_tag') result.description = nullableStr(metafield?.value);
  }
  return result;
}

export class ShopifyStoreDataProvider implements StoreDataProvider {
  readonly kind = 'shopify';

  /**
   * Memory-safety ceiling for the full-catalogue fetch. 25k products x ~2KB normalized is
   * ~50MB in the worst case — acceptable for a single audit job. Catalogues beyond it are
   * fetched to the ceiling and reported TRUNCATED, never silently sampled.
   */
  static readonly PRODUCT_SAFETY_CEILING = 25_000;

  constructor(
    private readonly client: ShopifyClient,
    private readonly storeId: number,
    private readonly shopDomain: string,
    private readonly productLimit: number,
    /**
     * Merchant-supplied AI Discovery inputs, already loaded (see store-data/index.ts).
     *
     * Passed in rather than read here so this class keeps its one job — turning Shopify into a
     * snapshot — and so the checks that consume them stay pure functions of a snapshot. Undefined
     * on the lightweight preview path, where no audit is being produced.
     */
    private readonly aiDiscovery?: SnapshotAiDiscovery,
    /**
     * The store's stored PageSpeed Insights measurements, already loaded (see store-data/index.ts).
     *
     * Passed in for the same reason as the AI Discovery inputs, and for one more: Core Web Vitals
     * do not come from Shopify at all. Reading them here would make this class the place where
     * "store data" quietly started meaning "anything an audit needs".
     */
    private readonly pageSpeed?: SnapshotPageSpeed,
  ) {}

  /**
   * One record of each kind, plus the shop.
   *
   * Exists so the Schema settings page can preview a template against the merchant's REAL data
   * without building a whole snapshot: a preview that read the entire catalogue would take
   * minutes and hammer Shopify every time someone changed a dropdown. It reuses the same fetchers
   * and the same mapping as an audit, so what the preview shows is exactly what the engine will
   * later generate — a second, lighter read path would be free to drift from the real one.
   *
   * Returns plain snapshot types and knows nothing about schema, so the store-data layer stays
   * about Shopify and the schema engine stays about schema.
   *
   * Per-resource failures degrade to an empty list rather than throwing: a store with no blog
   * still has products to preview against.
   */
  async sampleRecords(): Promise<{
    shop: SnapshotShop;
    products: SnapshotProduct[];
    collections: SnapshotCollection[];
    pages: SnapshotPage[];
    articles: SnapshotArticle[];
  }> {
    const warnings: string[] = [];
    const identity = await fetchShopIdentity(this.client);
    const primaryUrl = (identity.primaryUrl ?? `https://${this.shopDomain}`).replace(/\/$/, '');

    const [products, collections, pages, articles] = await Promise.all([
      this.safe('products', warnings, () => this.fetchProducts(primaryUrl, 1)),
      this.safe('collections', warnings, () => this.fetchCollections(primaryUrl)),
      this.safe('pages', warnings, () => this.fetchPages(primaryUrl)),
      this.safe('articles', warnings, () => this.fetchArticles(primaryUrl)),
    ]);

    return {
      shop: this.buildShop(identity, primaryUrl),
      // Only the first of each: a preview describes one record, and holding more would make this
      // a catalogue read by another name.
      products: (products?.items ?? []).slice(0, 1),
      collections: (collections?.items ?? []).slice(0, 1),
      pages: (pages?.items ?? []).slice(0, 1),
      articles: (articles?.items ?? []).slice(0, 1),
    };
  }

  async buildSnapshot(onProgress?: (update: SnapshotProgress) => Promise<void> | void): Promise<StoreSnapshot> {
    const warnings: string[] = [];

    // Reports only work that has happened. A fraction is given only when both numbers are real:
    // items read against a total Shopify reported, or pages loaded against the pages chosen.
    const report = async (step: SnapshotStep, label: string, fraction?: number) => {
      await onProgress?.({ step, label, ...(fraction !== undefined ? { fraction: Math.max(0, Math.min(1, fraction)) } : {}) });
    };
    const count = (value: number) => value.toLocaleString('en-US');
    const reading = (step: SnapshotStep, noun: string, expected: number | null) => async (read: number) => {
      if (expected !== null && expected > 0) await report(step, `Reading ${noun} — ${count(read)} of ${count(expected)}`, read / expected);
      else await report(step, `Reading ${noun} — ${count(read)} read`);
    };

    await report('shop', 'Reading store details');

    // Shop identity is the one genuinely required resource — without it we cannot even establish
    // which store this is, so a failure here is fatal rather than degraded.
    const identity = await fetchShopIdentity(this.client);

    // The merchant's real storefront origin. A store on a custom domain serves its pages from
    // that domain, so deriving URLs from the myshopify domain would point every evidence row and
    // every storefront check at the wrong host.
    const primaryUrl = (identity.primaryUrl ?? `https://${this.shopDomain}`).replace(/\/$/, '');

    // Catalogue totals are fetched FIRST so the product fetch can size itself to the real
    // catalogue instead of a fixed cap. Non-fatal by construction.
    const totals = await fetchCatalogTotals(this.client);

    // ── Effective product limit (removes the silent 2,000 cap) ──
    // `stores.page_limit` described a crawl budget, but it was being applied to the Admin
    // catalogue fetch, silently scoring 10,000-product stores on a 2,000-product sample. Admin
    // catalogue analysis now sizes itself to the store's ACTUAL product count, bounded only by a
    // memory-safety ceiling; anything beyond the ceiling is still reported as truncated, never
    // hidden. When the count is unreadable, the configured limit remains the fallback.
    const exactCount = totals.products?.exact ? totals.products.count : null;
    const effectiveProductLimit = exactCount !== null
      ? Math.min(Math.max(exactCount, this.productLimit), ShopifyStoreDataProvider.PRODUCT_SAFETY_CEILING)
      : totals.products
        ? Math.min(Math.max(totals.products.count, this.productLimit), ShopifyStoreDataProvider.PRODUCT_SAFETY_CEILING)
        : this.productLimit;

    // Expected totals come from Shopify's own counts, capped at what this audit will read. Pages
    // and articles have no count query here, so they report how many were read, with no fraction.
    const expectedProducts = totals.products ? Math.min(totals.products.count, effectiveProductLimit) : null;
    const expectedCollections = totals.collections ? Math.min(totals.collections.count, COLLECTION_LIMIT) : null;

    await report('products', 'Reading products', expectedProducts ? 0 : undefined);
    const products = await this.safe('products', warnings, () => this.fetchProducts(primaryUrl, effectiveProductLimit, reading('products', 'products', expectedProducts)));
    if (products) {
      // Fraction 1: the product read is finished, so the bar holds at the end of its band while the
      // label says what is still being read. Reporting no fraction would move it BACK to the start.
      await this.completeVariants(products.items, warnings, (label) => report('products', label, 1));
    }
    await report('collections', 'Reading collections', expectedCollections ? 0 : undefined);
    const collections = await this.safe('collections', warnings, () => this.fetchCollections(primaryUrl, reading('collections', 'collections', expectedCollections)));
    await report('pages', 'Reading pages');
    const pages = await this.safe('pages', warnings, () => this.fetchPages(primaryUrl, reading('pages', 'pages', null)));
    await report('articles', 'Reading blog articles');
    const articles = await this.safe('articles', warnings, () => this.fetchArticles(primaryUrl, reading('articles', 'blog articles', null)));
    // Policies report their own availability (a denied scope is an expected state, not an error),
    // so they bypass safe() for the same reason redirects do — see fetchPolicies().
    await report('policies', 'Reading shop policies');
    const policies = await this.fetchPolicies();
    if (!policies.access.available) warnings.push(`policies: ${policies.access.detail}`);
    await report('theme', 'Reading your theme');
    const theme = await this.safe('theme', warnings, () => fetchTheme(this.client));
    await report('storefront', 'Checking your storefront is reachable');
    const storefront = await this.safe('storefront', warnings, () => probeStorefront(primaryUrl));
    // Redirects report their own availability (scope-denied is an expected state, not an error),
    // so they bypass safe(): a denial must reach the check as a REASON, not vanish as a warning.
    await report('redirects', 'Reading URL redirects');
    const redirects = await fetchUrlRedirects(this.client, reading('redirects', 'URL redirects', null));
    // Recorded in the audit's metadata (snapshotWarnings), so an operator can see WHY the page
    // reports redirects as not measured without reproducing the audit.
    if (!redirects.available) warnings.push(`redirects (${redirects.reason}): ${redirects.detail}`);
    else if (redirects.truncated) warnings.push(`redirects: Shopify's cursor stopped advancing after ${redirects.items.length} redirects`);

    await report('handles', 'Reading every product, collection, page and article handle');
    const handleIndex = await this.buildHandleIndex(warnings, { products, collections, pages, articles }, report);

    const productList = products?.items ?? [];

    // ── Storefront crawl ──
    // Runs AFTER the Admin fetch because its targets are the merchant's own real resources, and
    // it is the last thing to run because nothing else depends on it: a crawl failure degrades
    // the crawl-based checks to `unavailable` and leaves every Admin check exactly as it was.
    await report('crawl', 'Loading storefront pages');
    const crawl = await this.safe('crawl', warnings, () => this.runCrawl({
      primaryUrl,
      products: productList,
      collections: collections?.items ?? [],
      pages: pages?.items ?? [],
      articles: articles?.items ?? [],
      onPage: (attempted, total) => report('crawl', `Loading storefront pages — ${count(attempted)} of ${count(total)}`, attempted / total),
    }));
    if (crawl?.warnings.length) warnings.push(...crawl.warnings.map((warning) => `crawl: ${warning}`));

    return {
      storeId: this.storeId,
      capturedAt: new Date(),
      shop: this.buildShop(identity, primaryUrl),
      products: productList,
      collections: collections?.items ?? [],
      pages: pages?.items ?? [],
      articles: articles?.items ?? [],
      policies: policies.items,
      policyAccess: policies.access,
      theme: theme ?? null,
      storefront: storefront ?? null,
      redirects,
      handleIndex,
      crawl: crawl ?? null,
      aiDiscovery: this.aiDiscovery,
      pageSpeed: this.pageSpeed,
      coverage: {
        shop: true,
        products: products !== null,
        collections: collections !== null,
        pages: pages !== null,
        articles: articles !== null,
        policies: policies.access.available,
        // GraphQL returns metafields inline with each product, so coverage is no longer a
        // property of a sample — either the products query succeeded and every product carries
        // real metafield data, or it did not.
        metafields: products !== null && productList.some((product) => product.metafieldsAvailable),
        theme: theme !== null && theme !== undefined,
        storefront: storefront !== null && storefront !== undefined,
        // Rendered-page evidence exists only when a page was actually fetched AND parsed. A
        // password-gated or unreachable storefront is false here, which is what makes every
        // crawl-based check report "not measured" instead of scoring Shopify's password page.
        crawl: crawl?.available === true,
      },
      scope: {
        productLimit: effectiveProductLimit,
        productsAvailable: totals.products,
        collectionsAvailable: totals.collections,
        productsTruncated: products?.truncated ?? false,
        collectionsTruncated: collections?.truncated ?? false,
        pagesTruncated: pages?.truncated ?? false,
        articlesTruncated: articles?.truncated ?? false,
      },
      warnings,
    };
  }

  /**
   * Runs one resource fetch, converting a failure into `null` + a warning instead of
   * aborting the snapshot. A permanently-fatal auth error still propagates, because
   * continuing without credentials would only produce meaningless "unavailable" results.
   */
  /** The shop block, built once so a full snapshot and a preview sample cannot describe the same
   * store differently. */
  private buildShop(identity: Awaited<ReturnType<typeof fetchShopIdentity>>, primaryUrl: string): SnapshotShop {
    return {
      domain: this.shopDomain,
      primaryUrl,
      name: identity.name,
      email: identity.contactEmail,
      currency: identity.currencyCode,
      country: identity.country,
      timezone: identity.ianaTimezone,
      planName: identity.planName,
    };
  }

  private async safe<T>(resource: string, warnings: string[], task: () => Promise<T>): Promise<T | null> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof StoreDataError && (error.code === 'TOKEN_REVOKED' || error.code === 'RATE_LIMITED')) {
        throw error;
      }
      warnings.push(`${resource}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
  }

  /**
   * Every handle of every resource type, complete per type.
   *
   * A catalogue list is reused when it was read to the end — no second request for the common
   * store. When it was capped (collections, pages and articles stop at 250; products at the memory
   * ceiling) or failed, that type's handles are read again to the end with a query that asks for
   * nothing but id, title, handle and publication state. A type that still cannot be read is
   * marked incomplete with the reason, and the check verifies nothing against it.
   */
  private async buildHandleIndex(
    warnings: string[],
    lists: {
      products: { items: SnapshotProduct[]; truncated: boolean } | null;
      collections: { items: SnapshotCollection[]; truncated: boolean } | null;
      pages: { items: SnapshotPage[]; truncated: boolean } | null;
      articles: { items: SnapshotArticle[]; truncated: boolean } | null;
    },
    report?: (step: SnapshotStep, label: string, fraction?: number) => Promise<void>,
  ): Promise<SnapshotHandleIndex> {
    const now = Date.now();
    const live = (publishedAt: string | null) => publishedAt !== null && Date.parse(publishedAt) <= now;
    const fromCatalogue: Record<HandleResourceType, SnapshotHandle[] | null> = {
      product: lists.products && !lists.products.truncated
        ? lists.products.items.map((item) => ({ id: item.id, type: 'product' as const, title: item.title, handle: item.handle, blogHandle: null, published: item.status === 'active' && item.publishedAt !== null }))
        : null,
      collection: lists.collections && !lists.collections.truncated
        ? lists.collections.items.map((item) => ({ id: item.id, type: 'collection' as const, title: item.title, handle: item.handle, blogHandle: null, published: null }))
        : null,
      page: lists.pages && !lists.pages.truncated
        ? lists.pages.items.map((item) => ({ id: item.id, type: 'page' as const, title: item.title, handle: item.handle, blogHandle: null, published: live(item.publishedAt) }))
        : null,
      article: lists.articles && !lists.articles.truncated
        ? lists.articles.items.map((item) => ({ id: item.id, type: 'article' as const, title: item.title, handle: item.handle, blogHandle: item.blogHandle, published: live(item.publishedAt) }))
        : null,
    };

    const index: SnapshotHandleIndex = { handles: [], complete: {}, gaps: {} };
    for (const type of ['product', 'collection', 'page', 'article'] as const) {
      const reused = fromCatalogue[type];
      if (reused) {
        index.handles.push(...reused.filter((item) => item.handle));
        index.complete[type] = true;
        continue;
      }
      try {
        const { items, stalled } = await fetchAllHandles(this.client, type, (read) =>
          report?.('handles', `Reading all ${type} handles — ${read.toLocaleString('en-US')} read`));
        index.handles.push(...items);
        index.complete[type] = !stalled;
        if (stalled) {
          index.gaps[type] = `Shopify's list stopped advancing after ${items.length} ${type} handles`;
          warnings.push(`handles: ${index.gaps[type]}`);
        }
      } catch (error) {
        if (error instanceof StoreDataError && error.code === 'TOKEN_REVOKED') throw error;
        index.complete[type] = false;
        index.gaps[type] = error instanceof Error ? error.message : 'unknown error';
        warnings.push(`handles (${type}): ${index.gaps[type]}`);
      }
    }
    return index;
  }

  /**
   * Crawls the merchant's own storefront for rendered-page evidence.
   *
   * Targets are derived from the Admin resources just fetched, so the crawl only ever visits
   * pages this store actually publishes. Returns null when crawling is switched off, which the
   * coverage flag turns into an honest "not measured" for every crawl-based check.
   */
  private async runCrawl(resources: {
    primaryUrl: string;
    products: SnapshotProduct[];
    collections: SnapshotCollection[];
    pages: SnapshotPage[];
    articles: SnapshotArticle[];
    onPage?: (attempted: number, total: number) => Promise<void> | void;
  }): Promise<StorefrontCrawl | null> {
    if (!crawlConfigured()) return null;

    const targets = buildCrawlTargets(
      {
        shop: { primaryUrl: resources.primaryUrl },
        products: resources.products,
        collections: resources.collections,
        pages: resources.pages,
        articles: resources.articles,
      } as StoreSnapshot,
      env.crawlMaxPages,
    );

    // The key is what lets the crawl request `/<key>.txt` at all. With none on file the crawler
    // fetches nothing and the IndexNow check reports "not configured" — which is the truth, and
    // is not the same statement as "the key file is missing".
    return new StorefrontCrawler(resources.primaryUrl, {
      indexNowKey: this.aiDiscovery?.indexNowKey ?? null,
      probeBots: env.crawlProbeBots,
    }).crawl(targets, resources.onPage);
  }

  private async fetchProducts(primaryUrl: string, limit: number, onPage?: (read: number) => Promise<void> | void): Promise<{ items: SnapshotProduct[]; truncated: boolean }> {
    const { items: raw, truncated } = await this.client.paginate<GqlProduct, ProductsResponse>(
      PRODUCTS_QUERY,
      (data) => data.products,
      limit,
      {},
      onPage,
    );

    const items = raw.map((product): SnapshotProduct => {
      const handle = str(product.handle);
      const media = Array.isArray(product.media?.nodes) ? product.media.nodes : [];
      // `metafields` is a non-null connection in the schema, so its presence means we genuinely
      // read them. A missing connection means we could not look — "unknown", never "none".
      const metafieldsAvailable = Array.isArray(product.metafields?.nodes);
      const variants = normalizeVariants(product.variants?.nodes);
      const variantCount = num(product.variantsCount?.count) ?? variants.length;

      return {
        id: id(product.id),
        title: str(product.title),
        handle,
        // onlineStoreUrl is null for an unpublished product; the handle-derived URL is still the
        // address it would have, which is what a fix recommendation needs to name.
        url: nullableStr(product.onlineStoreUrl) ?? (handle ? `${primaryUrl}/products/${handle}` : primaryUrl),
        bodyHtml: str(product.descriptionHtml),
        productType: str(product.productType),
        vendor: str(product.vendor),
        tags: Array.isArray(product.tags) ? product.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        // Unknown stays unknown (''). It defaulted to 'ACTIVE', which counted a product whose status
        // Shopify did not report as live and reachable — and assessed it as such.
        status: str(product.status).toLowerCase(),
        publishedAt: nullableStr(product.publishedAt),
        updatedAt: nullableStr(product.updatedAt),
        images: media.map(normalizeMedia).filter((image): image is SnapshotImage => image !== null),
        variantCount,
        options: normalizeOptions(product.options),
        variants,
        // Compared against the REPORTED total, not the sample length: a product with exactly
        // the sample limit is fully read, one with more is not.
        variantsTruncated: variantCount > variants.length,
        // null when Shopify did not report it. Defaulting to 0 read "unknown" as "not enrolled",
        // and a store whose counts all went missing would be told it has no subscription programme.
        sellingPlanGroupCount: num(product.sellingPlanGroupCount),
        metafields: normalizeMetafields(product.metafields?.nodes),
        metafieldsAvailable,
        seoTitle: nullableStr(product.seo?.title),
        seoDescription: nullableStr(product.seo?.description),
      };
    });

    return { items, truncated };
  }

  /**
   * Most products whose remaining variants one audit will read. Each costs one to nine requests
   * (Shopify allows 2,048 variants, read 250 at a time), queued behind every other call to the
   * shop. A catalogue past this is not guessed at: the products left partial are named in the
   * audit's warnings and every check reports them as not fully measured.
   */
  private static readonly VARIANT_COMPLETION_LIMIT = 250;

  /**
   * Reads the rest of the variants of the products whose first read cannot answer "can any of it
   * be bought?".
   *
   * THE QUESTION THE SAMPLE CANNOT ANSWER. The products query reads the first
   * PRODUCT_VARIANT_SAMPLE_LIMIT variants of each product. When one of those is available for sale
   * the answer is already yes, whatever the rest say. When NONE is, the answer depends on variants
   * that were not read: a product with 40 variants whose first 25 are sold out may be selling
   * variant 30. Reporting it as "nothing purchasable" — which agentic-attrs did, as Critical —
   * stated a fact about variants nobody looked at.
   *
   * So only those products are read again, and only if a shopper can reach them: a draft or
   * archived product is left out of every AI Discovery check, so completing it would spend the
   * shop's API budget on nothing. A product read to its full reported count is marked complete;
   * one that could not be is left `variantsTruncated`, with the reason in the warnings, and the
   * checks say it was not fully measured rather than concluding anything.
   */
  private async completeVariants(
    products: SnapshotProduct[],
    warnings: string[],
    report: (label: string) => Promise<void>,
  ): Promise<void> {
    const undecided = products.filter((product) =>
      product.variantsTruncated
      && isPublishedProduct(product)
      && !product.variants.some((variant) => variant.availableForSale));
    if (undecided.length === 0) return;

    const batch = undecided.slice(0, ShopifyStoreDataProvider.VARIANT_COMPLETION_LIMIT);
    if (undecided.length > batch.length) {
      warnings.push(
        `variants: ${undecided.length - batch.length} published products with more than ${PRODUCT_VARIANT_SAMPLE_LIMIT} variants `
        + `were not read in full (at most ${ShopifyStoreDataProvider.VARIANT_COMPLETION_LIMIT} per audit); their availability is not measured`,
      );
    }

    let done = 0;
    for (const product of batch) {
      await report(`Reading every variant of products with more than ${PRODUCT_VARIANT_SAMPLE_LIMIT} — ${done.toLocaleString('en-US')} of ${batch.length.toLocaleString('en-US')}`);
      try {
        const { items } = await this.client.paginate<GqlProductVariant, ProductVariantsResponse>(
          PRODUCT_VARIANTS_QUERY,
          (data) => data.product?.variants,
          product.variantCount,
          { id: product.id.startsWith('gid://') ? product.id : `gid://shopify/Product/${product.id}` },
        );
        const variants = normalizeVariants(items);
        // Complete only when Shopify handed over as many variants as it says the product has.
        if (variants.length >= product.variantCount) {
          product.variants = variants;
          product.variantsTruncated = false;
        } else {
          // More than the sample is still more evidence, but it is not the whole product.
          if (variants.length > product.variants.length) product.variants = variants;
          warnings.push(`variants: product ${product.id} returned ${variants.length} of ${product.variantCount} variants; its availability is not fully measured`);
        }
      } catch (error) {
        if (error instanceof StoreDataError && error.code === 'TOKEN_REVOKED') throw error;
        // Rate limiting after the client's own retries means the shop's budget is spent. The
        // remaining products stay partial rather than failing an audit whose every other read
        // succeeded.
        if (error instanceof StoreDataError && error.code === 'RATE_LIMITED') {
          warnings.push(`variants: Shopify's rate limit stopped the variant read after ${done} of ${batch.length} products; the rest are not fully measured`);
          return;
        }
        warnings.push(`variants: product ${product.id} could not be read in full — ${describeError(error)}`);
      }
      done += 1;
    }
    await report(`Reading every variant of products with more than ${PRODUCT_VARIANT_SAMPLE_LIMIT} — ${done.toLocaleString('en-US')} of ${batch.length.toLocaleString('en-US')}`);
  }

  private async fetchCollections(primaryUrl: string, onPage?: (read: number) => Promise<void> | void): Promise<{ items: SnapshotCollection[]; truncated: boolean }> {
    // One connection covers both manual and automated collections; the REST API split these
    // across custom_collections and smart_collections and needed two paginated walks.
    const { items: raw, truncated } = await this.client.paginate<GqlCollection, CollectionsResponse>(
      COLLECTIONS_QUERY,
      (data) => data.collections,
      COLLECTION_LIMIT,
      {},
      onPage,
    );

    const items = raw.map((collection): SnapshotCollection => {
      const handle = str(collection.handle);
      const image = collection.image?.url
        ? {
            id: '',
            src: str(collection.image.url),
            alt: typeof collection.image.altText === 'string' ? collection.image.altText : null,
            width: num(collection.image.width),
            height: num(collection.image.height),
          }
        : null;
      return {
        id: id(collection.id),
        title: str(collection.title),
        handle,
        url: handle ? `${primaryUrl}/collections/${handle}` : primaryUrl,
        bodyHtml: str(collection.descriptionHtml),
        productCount: num(collection.productsCount?.count),
        updatedAt: nullableStr(collection.updatedAt),
        image,
        seoTitle: nullableStr(collection.seo?.title),
        seoDescription: nullableStr(collection.seo?.description),
      };
    });

    return { items, truncated };
  }

  private async fetchPages(primaryUrl: string, onPage?: (read: number) => Promise<void> | void): Promise<{ items: SnapshotPage[]; truncated: boolean }> {
    const { items: raw, truncated } = await this.client.paginate<GqlPage, PagesResponse>(
      PAGES_QUERY,
      (data) => data.pages,
      PAGE_LIMIT,
      {},
      onPage,
    );

    const items = raw.map((page): SnapshotPage => {
      const handle = str(page.handle);
      const seo = seoFromMetafields(page.metafields?.nodes);
      return {
        id: id(page.id),
        title: str(page.title),
        handle,
        url: handle ? `${primaryUrl}/pages/${handle}` : primaryUrl,
        bodyHtml: str(page.body),
        publishedAt: nullableStr(page.publishedAt),
        updatedAt: nullableStr(page.updatedAt),
        seoTitle: seo.title,
        seoDescription: seo.description,
      };
    });

    return { items, truncated };
  }

  private async fetchArticles(primaryUrl: string, onPage?: (read: number) => Promise<void> | void): Promise<{ items: SnapshotArticle[]; truncated: boolean }> {
    const { items: raw, truncated } = await this.client.paginate<GqlArticle, ArticlesResponse>(
      ARTICLES_QUERY,
      (data) => data.articles,
      ARTICLE_LIMIT,
      {},
      onPage,
    );

    const items = raw.map((article): SnapshotArticle => {
      const handle = str(article.handle);
      // No invented blog: the handle defaulted to 'news', which put a /blogs/news/ path that may
      // not exist into this article's URL and into the redirect and canonical checks.
      const blogHandle = str(article.blog?.handle);
      const seo = seoFromMetafields(article.metafields?.nodes);
      const image = article.image?.url
        ? {
            id: '',
            src: str(article.image.url),
            alt: typeof article.image.altText === 'string' ? article.image.altText : null,
            width: num(article.image.width),
            height: num(article.image.height),
          }
        : null;

      return {
        id: id(article.id),
        blogId: id(article.blog?.id),
        blogHandle,
        title: str(article.title),
        handle,
        url: handle && blogHandle ? `${primaryUrl}/blogs/${blogHandle}/${handle}` : primaryUrl,
        bodyHtml: str(article.body),
        publishedAt: nullableStr(article.publishedAt),
        updatedAt: nullableStr(article.updatedAt),
        image,
        seoTitle: seo.title,
        seoDescription: seo.description,
      };
    });

    return { items, truncated };
  }

  /**
   * Reads the shop's policies, reporting a denied scope as a REASON rather than an error.
   *
   * Like redirects, this bypasses safe(): `shopPolicies` sits behind `read_legal_policies`, so a
   * store connected before that scope was requested denies the field. That is an expected state
   * with an obvious fix, and it must reach the returns check as something it can explain — not
   * vanish into a warning that leaves the merchant with "could not read your policies".
   */
  private async fetchPolicies(): Promise<{ items: SnapshotPolicy[]; access: SnapshotPolicyAccess }> {
    let data: PoliciesResponse;
    try {
      data = await this.client.graphql<PoliciesResponse>(POLICIES_QUERY);
    } catch (error) {
      if (error instanceof StoreDataError && (error.code === 'TOKEN_REVOKED' || error.code === 'RATE_LIMITED')) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : 'unknown error';
      return { items: [], access: { available: false, reason: /access denied/i.test(detail) ? 'scope' : 'error', detail } };
    }

    const raw = Array.isArray(data.shop?.shopPolicies) ? data.shop.shopPolicies : [];
    const items = raw.map((policy) => ({
      // ShopPolicyType is an enum (REFUND_POLICY, PRIVACY_POLICY, …); lower-cased it matches the
      // handle the REST API used, so downstream checks keying on 'refund_policy' still work.
      type: str(policy?.type).toLowerCase(),
      title: str(policy?.title),
      body: str(policy?.body),
      url: nullableStr(policy?.url),
    }));

    return { items, access: { available: true } };
  }
}
