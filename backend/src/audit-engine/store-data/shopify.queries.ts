import type { Connection, ShopifyClient } from './shopify-client.js';
import { StoreDataError, type HandleResourceType, type SnapshotHandle } from './types.js';
import { describeError } from '../../lib/logger.js';

/**
 * ─── GraphQL Admin API documents ─────────────────────────────────────
 * Written against SHOPIFY_API_VERSION in shopify-client.ts. The REST Admin API these queries
 * replaced has been legacy since 2024-10-01, and public apps have had to be built exclusively
 * on GraphQL since 2025-04-01.
 *
 * Beyond compliance, GraphQL removes an N+1 that REST forced: `seo { title description }` and
 * `metafields` come back inline with each product, so the old "sample the first 50 products,
 * one extra request each, and mark the rest unknown" workaround is gone. Every product in the
 * snapshot now carries real SEO and metafield data.
 *
 * Field-name notes (all verified against the current schema):
 *   Product.images / Product.bodyHtml / Product.totalVariants are deprecated — use media,
 *     descriptionHtml and variantsCount { count }.
 *   Shop.email does not exist — the public contact address is Shop.contactEmail.
 *   Page and Article have NO `seo` field. Their SEO overrides live where the online store puts
 *     them: the `global.title_tag` / `global.description_tag` metafields.
 */

export interface GqlSeo {
  title: string | null;
  description: string | null;
}

/**
 * Variants read per product for the CRO and AI Discovery checks (identifiers, price, availability).
 *
 * Bounded for two reasons. Cost: the products page already requests 250 products with 20 media and
 * 25 metafields each, and every nested connection multiplies the calculated query cost — verified
 * against a live shop at this exact page size before being committed. Memory: the snapshot holds
 * the whole catalogue at once, up to PRODUCT_SAFETY_CEILING, so an unbounded variant list would
 * dominate it. Products with more variants than this are marked `variantsTruncated` rather than
 * silently scored on a partial read.
 */
const VARIANT_SAMPLE_LIMIT = 25;

export interface GqlMetafield {
  namespace: string | null;
  key: string | null;
  type: string | null;
  value: string | null;
}

export interface GqlMediaImage {
  id: string | null;
  alt: string | null;
  image: { url: string | null; width: number | null; height: number | null } | null;
}

export interface GqlProductOption {
  name: string | null;
  values: string[] | null;
}

export interface GqlProductVariant {
  id: string | null;
  sku: string | null;
  barcode: string | null;
  /** Money is serialized as a decimal STRING, never a number — see the theme-asset `size` bug. */
  price: string | null;
  availableForSale: boolean | null;
}

export interface GqlProduct {
  id: string | null;
  title: string | null;
  handle: string | null;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  status: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  onlineStoreUrl: string | null;
  seo: GqlSeo | null;
  variantsCount: { count: number | null } | null;
  options: GqlProductOption[] | null;
  /** A plain Int on Product, NOT a `Count` object — selecting `{ count }` on it is a schema error. */
  sellingPlanGroupCount: number | null;
  variants: { nodes: GqlProductVariant[] } | null;
  media: { nodes: GqlMediaImage[] } | null;
  metafields: { nodes: GqlMetafield[] } | null;
}

/** Exposed so the provider can flag a product whose variant list was cut short. */
export const PRODUCT_VARIANT_SAMPLE_LIMIT = VARIANT_SAMPLE_LIMIT;

export interface GqlCollection {
  id: string | null;
  title: string | null;
  handle: string | null;
  descriptionHtml: string | null;
  updatedAt?: string | null;
  image?: { url: string | null; altText: string | null; width: number | null; height: number | null } | null;
  productsCount: { count: number | null } | null;
  seo: GqlSeo | null;
}

export interface GqlPage {
  id: string | null;
  title: string | null;
  handle: string | null;
  body: string | null;
  isPublished: boolean | null;
  publishedAt: string | null;
  updatedAt: string | null;
  metafields: { nodes: GqlMetafield[] } | null;
}

export interface GqlArticle {
  id: string | null;
  title: string | null;
  handle: string | null;
  body: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  image: { url: string | null; altText: string | null; width: number | null; height: number | null } | null;
  blog: { id: string | null; handle: string | null } | null;
  metafields: { nodes: GqlMetafield[] } | null;
}

export interface GqlPolicy {
  id: string | null;
  type: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
}

/** Only the `global` namespace is requested for Page/Article: it is where the online store keeps
 * SEO overrides, and narrowing the namespace keeps the query's calculated cost down. */
const SEO_METAFIELDS = `metafields(first: 5, namespace: "global") { nodes { namespace key type value } }`;

const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

export const SHOP_IDENTITY_QUERY = `
  query ScoreloShopIdentity {
    shop {
      id
      name
      contactEmail
      myshopifyDomain
      currencyCode
      ianaTimezone
      plan { displayName }
      billingAddress { country }
      primaryDomain { url host }
    }
  }
`;

/**
 * Catalogue size, used to report analysed-vs-available coverage.
 *
 * Shopify returns `precision` alongside each count: EXACT, or AT_LEAST when the true total
 * exceeds what it will count cheaply. That distinction is preserved rather than dropped — telling
 * a merchant "2,000 of 10,000" when the real figure is "at least 10,000" would be a fabricated
 * denominator.
 */
export const CATALOG_TOTALS_QUERY = `
  query ScoreloCatalogTotals {
    productsCount { count precision }
    collectionsCount { count precision }
  }
`;

export const PRODUCTS_QUERY = `
  query ScoreloProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id
        title
        handle
        descriptionHtml
        productType
        vendor
        tags
        status
        publishedAt
        updatedAt
        onlineStoreUrl
        seo { title description }
        variantsCount { count }
        options { name values }
        sellingPlanGroupCount
        variants(first: ${VARIANT_SAMPLE_LIMIT}) {
          nodes { id sku barcode price availableForSale }
        }
        media(first: 20) {
          nodes {
            ... on MediaImage {
              id
              alt
              image { url width height }
            }
          }
        }
        metafields(first: 25) { nodes { namespace key type value } }
      }
    }
  }
`;

/**
 * Every variant of ONE product, for the products whose first VARIANT_SAMPLE_LIMIT variants could
 * not settle a question on their own — see ShopifyStoreDataProvider.completeVariants.
 *
 * The same variant fields as PRODUCTS_QUERY, so a completed product is indistinguishable from one
 * that was read whole the first time. Paged at the client's maximum; Shopify allows up to 2,048
 * variants per product, so a product needs at most nine of these.
 */
export const PRODUCT_VARIANTS_QUERY = `
  query ScoreloProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        ${PAGE_INFO}
        nodes { id sku barcode price availableForSale }
      }
    }
  }
`;

export type ProductVariantsResponse = { product: { variants: Connection<GqlProductVariant> | null } | null };

export const COLLECTIONS_QUERY = `
  query ScoreloCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id
        title
        handle
        descriptionHtml
        updatedAt
        image { url altText width height }
        productsCount { count }
        seo { title description }
      }
    }
  }
`;

export const PAGES_QUERY = `
  query ScoreloPages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id
        title
        handle
        body
        isPublished
        publishedAt
        updatedAt
        ${SEO_METAFIELDS}
      }
    }
  }
`;

/**
 * The `articles` root query walks every blog's articles in one connection. The old REST provider
 * had to list blogs and then page each blog's articles separately, which meant a store with many
 * blogs paid one round trip per blog before it read a single article.
 */
export const ARTICLES_QUERY = `
  query ScoreloArticles($first: Int!, $after: String) {
    articles(first: $first, after: $after) {
      ${PAGE_INFO}
      nodes {
        id
        title
        handle
        body
        publishedAt
        updatedAt
        image { url altText width height }
        blog { id handle }
        ${SEO_METAFIELDS}
      }
    }
  }
`;

export const POLICIES_QUERY = `
  query ScoreloPolicies {
    shop {
      shopPolicies { id type title body url }
    }
  }
`;

export interface ShopIdentity {
  /** gid://shopify/Shop/123456 — stable across a myshopify domain rename. */
  gid: string;
  name: string;
  contactEmail: string | null;
  myshopifyDomain: string | null;
  currencyCode: string | null;
  ianaTimezone: string | null;
  country: string | null;
  planName: string | null;
  /** The merchant's real storefront origin — a custom domain when they have one. */
  primaryUrl: string | null;
}

interface ShopIdentityResponse {
  shop: {
    id: string | null;
    name: string | null;
    contactEmail: string | null;
    myshopifyDomain: string | null;
    currencyCode: string | null;
    ianaTimezone: string | null;
    plan: { displayName: string | null } | null;
    billingAddress: { country: string | null } | null;
    primaryDomain: { url: string | null; host: string | null } | null;
  } | null;
}

/**
 * Reads the shop's own identity. Used at two moments:
 *   1. right after the OAuth code exchange, to prove the token works before anything is recorded
 *      as "Connected" and to take the store's real name from Shopify instead of the domain;
 *   2. at the start of every snapshot, where store identity is the one non-optional resource.
 */
export async function fetchShopIdentity(client: ShopifyClient): Promise<ShopIdentity> {
  const data = await client.graphql<ShopIdentityResponse>(SHOP_IDENTITY_QUERY);
  const shop = data.shop;
  if (!shop || !shop.id) {
    throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify did not return a shop record', false);
  }

  return {
    gid: shop.id,
    // The shop's own name, else its myshopify domain — both real. Never a stand-in like "Shopify
    // store": that literal used to be the last resort, and it would have become the merchant's
    // store name, workspace name and llms.txt heading as though Shopify had said it.
    name: shop.name?.trim() || shop.myshopifyDomain || '',
    contactEmail: shop.contactEmail ?? null,
    myshopifyDomain: shop.myshopifyDomain ?? null,
    currencyCode: shop.currencyCode ?? null,
    ianaTimezone: shop.ianaTimezone ?? null,
    country: shop.billingAddress?.country ?? null,
    planName: shop.plan?.displayName ?? null,
    primaryUrl: shop.primaryDomain?.url ?? null,
  };
}

/** The shop OWNER, as distinct from the shop. `email` is where Shopify writes to the owner;
 * `contactEmail` above is the public address customers use, which is often a shared inbox. */
export const SHOP_OWNER_QUERY = `
  query ScoreloShopOwner {
    shop {
      email
      shopOwnerName
    }
  }
`;

export interface ShopOwner {
  email: string | null;
  name: string | null;
}

/**
 * Reads who owns the shop, for creating the Rankvora AI account that signing in with Shopify opens.
 *
 * Kept out of SHOP_IDENTITY_QUERY on purpose: identity is read by every audit and every sync, and a
 * field Shopify declines to return here must not be able to fail those. Never throws — an absent
 * value comes back as null, and the caller decides what an account can be created without.
 */
export async function fetchShopOwner(client: ShopifyClient): Promise<ShopOwner> {
  try {
    const data = await client.graphql<{ shop: { email: string | null; shopOwnerName: string | null } | null }>(SHOP_OWNER_QUERY);
    return {
      email: data.shop?.email?.trim() || null,
      name: data.shop?.shopOwnerName?.trim() || null,
    };
  } catch (error) {
    console.warn(`[scorelo-api] shopify: shop owner read failed — ${describeError(error)}`);
    return { email: null, name: null };
  }
}

export type ProductsResponse = { products: Connection<GqlProduct> | null };
export type CollectionsResponse = { collections: Connection<GqlCollection> | null };
export type PagesResponse = { pages: Connection<GqlPage> | null };
export type ArticlesResponse = { articles: Connection<GqlArticle> | null };
export type PoliciesResponse = { shop: { shopPolicies: GqlPolicy[] | null } | null };

export interface CatalogTotals {
  products: { count: number; exact: boolean } | null;
  collections: { count: number; exact: boolean } | null;
}

interface CountNode { count?: number | null; precision?: string | null }
interface CatalogTotalsResponse { productsCount?: CountNode | null; collectionsCount?: CountNode | null }

function toTotal(node: CountNode | null | undefined): { count: number; exact: boolean } | null {
  if (!node || typeof node.count !== 'number') return null;
  return { count: node.count, exact: node.precision !== 'AT_LEAST' };
}

/** Reads catalogue totals. Never throws — coverage reporting must not be able to fail an audit. */
export async function fetchCatalogTotals(client: ShopifyClient): Promise<CatalogTotals> {
  try {
    const data = await client.graphql<CatalogTotalsResponse>(CATALOG_TOTALS_QUERY);
    return { products: toTotal(data.productsCount), collections: toTotal(data.collectionsCount) };
  } catch {
    return { products: null, collections: null };
  }
}

// ─── Onboarding signals ──────────────────────────────────────────────
//
// Read once, when a merchant opens guided setup, to pre-fill answers from what the store already
// contains. Everything here is DERIVED FROM THE MERCHANT'S OWN CATALOGUE — there is no fallback
// list of example industries or specimen keywords. When a store has no collections and no product
// types, these functions return empty arrays and the UI says nothing could be detected, because
// that is the truth.
//
// Deliberately cheap. The full snapshot reads every product with media and metafields; this reads
// names only, from one page each, because a pre-fill that costs a merchant a 90-second wait has
// already failed at its job.

/** One page of collections and products, names and classification fields only. */
export const ONBOARDING_CATALOG_SIGNALS_QUERY = `
  query ScoreloOnboardingCatalogSignals($products: Int!, $collections: Int!) {
    productsCount { count precision }
    collections(first: $collections) {
      nodes { title handle productsCount { count } }
    }
    products(first: $products) {
      nodes { title handle productType vendor tags }
    }
  }
`;

/**
 * How much published content the store has: pages, and articles across its blogs.
 *
 * Its own query, and its own never-throwing reader, because guided setup shows these counts beside
 * the catalogue counts and a store that will not disclose them must still get the step.
 *
 * `articlesCount` is per BLOG — the Admin API has no store-wide article count — so the blogs are
 * read and their counts summed. 25 blogs covers every real store; a store with more is reported as
 * "at least", never as a total that silently excluded some.
 */
export const ONBOARDING_CONTENT_COUNTS_QUERY = `
  query ScoreloOnboardingContentCounts {
    pagesCount { count precision }
    blogsCount { count precision }
    blogs(first: 25) {
      nodes { articlesCount { count precision } }
    }
  }
`;

/**
 * Products and collections that are actually PUBLISHED to the online store.
 *
 * Separate from the query above so a shop that rejects one of these filters still gets its page and
 * article counts, and the reverse. `status:active` is spelled out because productsCount defaults to
 * it anyway; `published_status:published` is what makes "published" mean on the storefront rather
 * than merely not a draft.
 */
export const ONBOARDING_PUBLISHED_COUNTS_QUERY = `
  query ScoreloOnboardingPublishedCounts {
    publishedProducts: productsCount(query: "status:active published_status:published") { count precision }
    publishedCollections: collectionsCount(query: "published_status:published") { count precision }
  }
`;

/**
 * Published storefront locales.
 *
 * Its own query, and its own try/catch at the call site, because `shopLocales` is not covered by
 * the scopes Rankvora AI requests today. A store that denies it must still get the other four steps —
 * so a failure here degrades to "languages could not be detected" rather than failing setup.
 */
export const ONBOARDING_LOCALES_QUERY = `
  query ScoreloOnboardingLocales {
    shopLocales { locale name primary published }
  }
`;

export interface ShopLocale {
  locale: string;
  name: string | null;
  primary: boolean;
  published: boolean;
}

export interface CatalogSignals {
  /** Total products in the shop, and whether Shopify counted exactly. */
  productTotal: { count: number; exact: boolean } | null;
  /** Collection titles with their product counts, largest first. The strongest keyword signal a
   * Shopify store carries: a merchant names collections after what people search for. */
  collections: Array<{ title: string; productCount: number | null }>;
  /** Distinct `productType` values with the number of sampled products carrying each. */
  productTypes: Array<{ value: string; count: number }>;
  /** Distinct vendors, same shape. Used to recognise a store that resells known brands. */
  vendors: Array<{ value: string; count: number }>;
  /** Distinct tags, same shape. */
  tags: Array<{ value: string; count: number }>;
  /** How many products the sample actually covered — never presented as the whole catalogue. */
  sampledProducts: number;
  /**
   * The merchant's own products and collections, by handle and title, for the priority picker in
   * setup. Optional because a fixture need not provide them: absent means "no choices to offer",
   * which the UI states, rather than a list of examples.
   */
  productChoices?: ResourceChoice[];
  collectionChoices?: ResourceChoice[];
}

/** One product or collection the merchant can point at, named as their store names it. */
export interface ResourceChoice {
  handle: string;
  title: string;
}

interface CatalogSignalsResponse {
  productsCount?: CountNode | null;
  collections?: { nodes?: Array<{ title?: string | null; handle?: string | null; productsCount?: { count?: number | null } | null }> } | null;
  products?: { nodes?: Array<{ title?: string | null; handle?: string | null; productType?: string | null; vendor?: string | null; tags?: string[] | null }> } | null;
}

/** Keeps only entries that carry both a handle and a title — a choice missing either cannot be
 * stored or displayed, and half of one is not worth offering. */
function toChoices(nodes: Array<{ title?: string | null; handle?: string | null }>): ResourceChoice[] {
  return nodes
    .map((node) => ({ handle: node.handle?.trim() ?? '', title: node.title?.trim() ?? '' }))
    .filter((choice) => choice.handle.length > 0 && choice.title.length > 0);
}

/** Products sampled for type/vendor/tag frequency. One page — enough to rank what a store sells
 * without paging a 10,000-product catalogue to answer a pre-fill. */
const ONBOARDING_PRODUCT_SAMPLE = 250;
/** Collections read. Shopify stores rarely exceed this, and the largest are what matter. */
const ONBOARDING_COLLECTION_SAMPLE = 100;

/** Counts distinct non-empty values, most frequent first. Ties break alphabetically so the same
 * catalogue always produces the same order — a pre-fill that reshuffles between loads looks broken. */
function tally(values: Array<string | null | undefined>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Reads the classification and naming signals the setup flow pre-fills from.
 *
 * Throws on failure rather than returning empty: "we could not read your store" and "your store
 * has no collections" lead to different screens, and collapsing them would show a merchant with a
 * full catalogue an empty one.
 */
export async function fetchCatalogSignals(client: ShopifyClient): Promise<CatalogSignals> {
  const data = await client.graphql<CatalogSignalsResponse>(ONBOARDING_CATALOG_SIGNALS_QUERY, {
    products: ONBOARDING_PRODUCT_SAMPLE,
    collections: ONBOARDING_COLLECTION_SAMPLE,
  });

  const productNodes = data.products?.nodes ?? [];

  const collections = (data.collections?.nodes ?? [])
    .map((node) => ({
      title: node.title?.trim() ?? '',
      productCount: typeof node.productsCount?.count === 'number' ? node.productsCount.count : null,
    }))
    .filter((collection) => collection.title.length > 0)
    // Largest first: a 200-product collection names the business better than a 2-product one.
    // Collections whose count Shopify withheld sort last rather than being treated as empty.
    .sort((a, b) => (b.productCount ?? -1) - (a.productCount ?? -1));

  return {
    productTotal: toTotal(data.productsCount),
    collections,
    productTypes: tally(productNodes.map((node) => node.productType)),
    vendors: tally(productNodes.map((node) => node.vendor)),
    tags: tally(productNodes.flatMap((node) => node.tags ?? [])),
    sampledProducts: productNodes.length,
    productChoices: toChoices(productNodes),
    collectionChoices: toChoices(data.collections?.nodes ?? []),
  };
}

export interface ContentCounts {
  /** Products published to the online store. Null when Shopify would not say. */
  publishedProducts: { count: number; exact: boolean } | null;
  /** Collections published to the online store. Null when Shopify would not say. */
  publishedCollections: { count: number; exact: boolean } | null;
  /**
   * Pages, published and unpublished together: Shopify offers no way to count only the published
   * ones, and the screen says so rather than implying otherwise. Null when it would not say.
   */
  pages: { count: number; exact: boolean } | null;
  /** Articles summed across the store's blogs, unpublished included for the same reason. */
  articles: { count: number; exact: boolean } | null;
}

/**
 * Reads how many pages and articles the store has.
 *
 * NEVER THROWS, and null means "not read" — not zero. A store with no blog genuinely has zero
 * articles and is reported as zero; a store whose counts we could not read is reported as unknown,
 * and setup says so rather than showing a nought the merchant would read as "my blog is empty".
 */
export async function fetchContentCounts(client: ShopifyClient): Promise<ContentCounts> {
  // Read first and independently: a failure here costs only these two figures, not pages/articles.
  let publishedProducts: ContentCounts['publishedProducts'] = null;
  let publishedCollections: ContentCounts['publishedCollections'] = null;
  try {
    const published = await client.graphql<{ publishedProducts?: CountNode | null; publishedCollections?: CountNode | null }>(
      ONBOARDING_PUBLISHED_COUNTS_QUERY,
    );
    publishedProducts = toTotal(published.publishedProducts);
    publishedCollections = toTotal(published.publishedCollections);
  } catch {
    // Left null: unknown, and the screen says "not reported", not zero.
  }

  try {
    const data = await client.graphql<{
      pagesCount?: CountNode | null;
      blogsCount?: CountNode | null;
      blogs?: { nodes?: Array<{ articlesCount?: CountNode | null }> } | null;
    }>(ONBOARDING_CONTENT_COUNTS_QUERY);

    const blogNodes = data.blogs?.nodes ?? [];
    const perBlog = blogNodes.map((node) => toTotal(node.articlesCount));
    // One blog whose count Shopify withheld makes the SUM unknown, not smaller — so the total is
    // reported as "at least" rather than as a figure missing a blog's worth of articles.
    const readable = perBlog.filter((total): total is { count: number; exact: boolean } => total !== null);
    const blogsTotal = toTotal(data.blogsCount);
    const moreBlogsThanRead = blogsTotal !== null && blogsTotal.count > blogNodes.length;

    return {
      publishedProducts,
      publishedCollections,
      pages: toTotal(data.pagesCount),
      articles: blogNodes.length === 0 && blogsTotal?.count === 0
        // No blogs at all is a real zero.
        ? { count: 0, exact: true }
        : readable.length === 0 && blogNodes.length > 0
          ? null
          : {
              count: readable.reduce((sum, total) => sum + total.count, 0),
              exact: readable.length === perBlog.length && !moreBlogsThanRead && readable.every((total) => total.exact),
            },
    };
  } catch {
    // Missing scope, a shop that does not expose these, or an API version without the field.
    return { publishedProducts, publishedCollections, pages: null, articles: null };
  }
}

/**
 * Reads published storefront locales, or null when the shop will not disclose them.
 *
 * Null means unknown, and step 3 renders it as unknown. It never degrades to "English" — assuming
 * a language is how an international store ends up audited against the wrong market.
 */
export async function fetchShopLocales(client: ShopifyClient): Promise<ShopLocale[] | null> {
  try {
    const data = await client.graphql<{ shopLocales?: Array<{ locale?: string | null; name?: string | null; primary?: boolean | null; published?: boolean | null }> }>(
      ONBOARDING_LOCALES_QUERY,
    );
    const locales = (data.shopLocales ?? [])
      .filter((node): node is { locale: string; name?: string | null; primary?: boolean | null; published?: boolean | null } => Boolean(node.locale))
      .map((node) => ({
        locale: node.locale,
        name: node.name?.trim() || null,
        primary: Boolean(node.primary),
        published: Boolean(node.published),
      }));
    return locales.length > 0 ? locales : null;
  } catch {
    // Missing scope, or a shop that does not expose locales. Unknown, not empty.
    return null;
  }
}

// ─── Theme (Speed pillar) ────────────────────────────────────────────

const THEME_MAIN_QUERY = `
  query ScoreloMainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name role themeStoreId updatedAt }
    }
  }
`;

const THEME_FILES_QUERY = `
  query ScoreloThemeFiles($id: ID!, $after: String) {
    theme(id: $id) {
      files(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { filename size contentType }
      }
    }
  }
`;

const THEME_NAMED_FILES_QUERY = `
  query ScoreloThemeNamedFiles($id: ID!, $names: [String!]!) {
    theme(id: $id) {
      files(filenames: $names, first: 5) {
        nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }
`;

interface ThemeFileNode { filename?: string | null; size?: number | string | null; contentType?: string | null }
interface ThemeNode { id: string; name?: string | null; themeStoreId?: number | null; updatedAt?: string | null }

export interface FetchedTheme {
  name: string;
  themeStoreId: number | null;
  updatedAt: string | null;
  assets: Array<{ filename: string; size: number; contentType: string | null }>;
  assetsTruncated: boolean;
  appEmbeds: Array<{ type: string; disabled: boolean }> | null;
  externalScripts: string[] | null;
}

/** Hard ceiling on file pages so a pathological theme cannot spin this forever. 8 pages ×
 * 250 files covers every real theme by a wide margin (Dawn ships ~350 files). */
const THEME_FILE_PAGE_LIMIT = 8;

/**
 * Reads the MAIN theme: file inventory (names + byte sizes only), the app embed blocks from
 * config/settings_data.json, and any hardcoded external <script src> in layout/theme.liquid.
 *
 * Bodies are fetched for exactly two named files; everything else is metadata, so this stays a
 * handful of cheap requests even for large themes.
 */
export async function fetchTheme(client: ShopifyClient): Promise<FetchedTheme | null> {
  const main = await client.graphql<{ themes?: { nodes?: ThemeNode[] } }>(THEME_MAIN_QUERY);
  const theme = main.themes?.nodes?.[0];
  if (!theme?.id) return null;

  const assets: FetchedTheme['assets'] = [];
  let after: string | null = null;
  let assetsTruncated = false;
  for (let page = 0; page < THEME_FILE_PAGE_LIMIT; page += 1) {
    const data: { theme?: { files?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: ThemeFileNode[] } } } =
      await client.graphql(THEME_FILES_QUERY, { id: theme.id, after });
    const files = data.theme?.files;
    for (const node of files?.nodes ?? []) {
      // `size` is an UnsignedInt64 scalar, which GraphQL serializes as a STRING ("63360"), not a
      // number. A typeof-number guard here silently discarded every file — coerce instead.
      const size = Number(node.size);
      if (!node.filename || !Number.isFinite(size)) continue;
      // Only assets/ carries the payload the Speed checks score; layout/sections/config are
      // server-side Liquid and never ship to the browser as-is.
      if (node.filename.startsWith('assets/')) {
        assets.push({ filename: node.filename, size, contentType: node.contentType ?? null });
      }
    }
    if (!files?.pageInfo?.hasNextPage) break;
    after = files.pageInfo.endCursor ?? null;
    if (page === THEME_FILE_PAGE_LIMIT - 1) assetsTruncated = true;
  }

  let appEmbeds: FetchedTheme['appEmbeds'] = null;
  let externalScripts: FetchedTheme['externalScripts'] = null;
  try {
    const named: { theme?: { files?: { nodes?: Array<{ filename?: string | null; body?: { content?: string | null } | null }> } } } =
      await client.graphql(THEME_NAMED_FILES_QUERY, { id: theme.id, names: ['config/settings_data.json', 'layout/theme.liquid'] });
    for (const node of named.theme?.files?.nodes ?? []) {
      const content = node.body?.content;
      if (!content) continue;
      if (node.filename === 'config/settings_data.json') {
        // Shopify writes this file with a leading /* ... */ banner — strip it before parsing.
        const parsed = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, '')) as { current?: unknown };
        const current = parsed.current;
        const blocks = current && typeof current === 'object' ? (current as { blocks?: Record<string, { type?: string; disabled?: boolean }> }).blocks ?? {} : {};
        appEmbeds = Object.values(blocks)
          .filter((block) => typeof block?.type === 'string')
          .map((block) => ({ type: block.type as string, disabled: Boolean(block.disabled) }));
      }
      if (node.filename === 'layout/theme.liquid') {
        // Only absolute URLs count: Liquid-served theme assets are already measured by size
        // above, while an absolute src is a third-party script loading on every page.
        const matches = content.match(/<script[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi) ?? [];
        externalScripts = matches
          .map((tag) => tag.match(/src=["'](https?:\/\/[^"']+)["']/i)?.[1])
          .filter((src): src is string => Boolean(src));
      }
    }
  } catch {
    // Parsed extras are best-effort: null means "unknown", and the app-bloat check reports
    // exactly that rather than treating unknown as zero apps.
  }

  return {
    // The theme's own name, or '' when Shopify sent none — never a stand-in label.
    name: theme.name?.trim() ?? '',
    themeStoreId: theme.themeStoreId ?? null,
    updatedAt: theme.updatedAt ?? null,
    assets,
    assetsTruncated,
    appEmbeds,
    externalScripts,
  };
}

// ─── URL redirects (handles-redirects) ───────────────────────────────

const URL_REDIRECTS_QUERY = `
  query ScoreloUrlRedirects($first: Int!, $after: String) {
    urlRedirects(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id path target }
    }
  }
`;

export interface FetchedRedirect {
  /** Shopify's UrlRedirect GID. */
  id: string;
  /** The old path, as stored in Shopify. */
  path: string;
  /** Where it sends visitors: a site path or an absolute URL, as stored in Shopify. */
  target: string;
}

export type FetchedRedirects =
  | { available: true; items: FetchedRedirect[]; truncated: boolean }
  | { available: false; reason: 'scope' | 'error'; detail: string };

/** The permission Shopify requires for `urlRedirects`. */
export const REDIRECTS_SCOPE = 'read_online_store_navigation';

/**
 * Reads EVERY URL redirect the shop has.
 *
 * There is no page cap. It used to stop after 8 pages (2,000 redirects) and score whatever it had,
 * so a store with more redirects was audited on a sample while the page implied the whole list.
 * The walk now continues until Shopify reports no next page; request pacing and retries are the
 * client's job (cost-aware throttling, THROTTLED/429 back-off), exactly as for the catalogue.
 *
 * All or nothing: a failure part-way through returns `available: false`, never the pages read so
 * far — a partial list would report some redirects as healthy and silently drop the rest.
 * `truncated` is set only if Shopify's cursor stops advancing, which the check reports as such.
 *
 * A denied scope is an expected state (stores connected before the scope was requested), so it
 * is returned as a reason the check can name, not thrown.
 */
export async function fetchUrlRedirects(client: ShopifyClient, onPage?: (itemsRead: number) => Promise<void> | void): Promise<FetchedRedirects> {
  try {
    const { items, stalled } = await paginateAll<{ id?: string | null; path?: string | null; target?: string | null }, { urlRedirects?: RawConnection<{ id?: string | null; path?: string | null; target?: string | null }> }>(
      client,
      URL_REDIRECTS_QUERY,
      (data) => data.urlRedirects,
      onPage,
    );
    const redirects: FetchedRedirect[] = [];
    for (const node of items) {
      if (node.id && node.path && node.target !== null && node.target !== undefined) {
        redirects.push({ id: node.id, path: node.path, target: node.target });
      }
    }
    return { available: true, items: redirects, truncated: stalled };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    // The client raises MISSING_SCOPES for both an HTTP 403 and a GraphQL ACCESS_DENIED; matching
    // on the message alone missed the 403 wording and reported a permission problem as an outage.
    const isScope = (error instanceof StoreDataError && error.code === 'MISSING_SCOPES') || /access denied/i.test(message);
    return { available: false, reason: isScope ? 'scope' : 'error', detail: message };
  }
}

// ─── Handle index (handles-redirects) ────────────────────────────────

interface RawConnection<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: T[];
}

/**
 * Walks a connection to its end — no item limit. Stops early only if the cursor stops advancing,
 * which is reported as `stalled` rather than hidden. Throws on any request failure.
 */
async function paginateAll<T, D>(
  client: ShopifyClient,
  query: string,
  select: (data: D) => RawConnection<T> | null | undefined,
  onPage?: (itemsRead: number) => Promise<void> | void,
): Promise<{ items: T[]; stalled: boolean }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data: D = await client.graphql<D>(query, { first: 250, after });
    const connection = select(data);
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify GraphQL response did not contain the expected connection', false);
    }
    items.push(...connection.nodes);
    await onPage?.(items.length);
    if (!connection.pageInfo?.hasNextPage) return { items, stalled: false };
    const cursor = connection.pageInfo.endCursor ?? null;
    if (!cursor || seen.has(cursor)) return { items, stalled: true };
    seen.add(cursor);
    after = cursor;
  }
}


const HANDLE_QUERIES: Record<HandleResourceType, string> = {
  product: `query ScoreloProductHandles($first: Int!, $after: String) {
    products(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle status publishedAt } } }`,
  collection: `query ScoreloCollectionHandles($first: Int!, $after: String) {
    collections(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle } } }`,
  page: `query ScoreloPageHandles($first: Int!, $after: String) {
    pages(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle isPublished } } }`,
  article: `query ScoreloArticleHandles($first: Int!, $after: String) {
    articles(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title handle publishedAt blog { handle } } } }`,
};

const CONNECTION_KEY: Record<HandleResourceType, string> = { product: 'products', collection: 'collections', page: 'pages', article: 'articles' };

interface RawHandleNode {
  id?: string | null;
  title?: string | null;
  handle?: string | null;
  status?: string | null;
  publishedAt?: string | null;
  isPublished?: boolean | null;
  blog?: { handle?: string | null } | null;
}

/**
 * Every handle of one resource type, read to the end of Shopify's list with only the fields a
 * handle audit needs. Used when the catalogue fetch did not already read the complete list — it
 * caps collections, pages and articles, and products beyond a memory ceiling.
 */
export async function fetchAllHandles(
  client: ShopifyClient,
  type: HandleResourceType,
  onPage?: (itemsRead: number) => Promise<void> | void,
): Promise<{ items: SnapshotHandle[]; stalled: boolean }> {
  const { items, stalled } = await paginateAll<RawHandleNode, Record<string, RawConnection<RawHandleNode>>>(
    client,
    HANDLE_QUERIES[type],
    (data) => data[CONNECTION_KEY[type]],
    onPage,
  );
  const handles: SnapshotHandle[] = [];
  for (const node of items) {
    if (!node.id || !node.handle) continue;
    handles.push({
      // Same normalisation as the catalogue fetch, so an id here matches the snapshot's.
      id: /^\d+$/.test(node.id.split('/').pop() ?? '') ? node.id.split('/').pop()! : node.id,
      type,
      title: node.title ?? '',
      handle: node.handle,
      blogHandle: type === 'article' ? node.blog?.handle ?? null : null,
      // Only fields the catalogue queries already read, so this cannot drift from them: product
      // status + publishedAt, page isPublished, article publishedAt (a future date is scheduled,
      // not live). Collections carry no publication state here, so theirs is unknown.
      published:
        type === 'product' ? (node.status ?? '').toUpperCase() === 'ACTIVE' && Boolean(node.publishedAt)
          : type === 'collection' ? null
            : type === 'page' ? node.isPublished ?? null
              : Boolean(node.publishedAt) && Date.parse(node.publishedAt!) <= Date.now(),
    });
  }
  return { items: handles, stalled };
}
