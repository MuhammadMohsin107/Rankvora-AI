import type { StorefrontCrawl } from '../storefront/types.js';
// Type-only, so nothing from the service layer is imported at runtime and a check stays testable
// without a database. One definition rather than a parallel copy: a measurement that drifted from
// the shape actually stored would be a silent source of wrong numbers.
import type { PageSpeedReport } from '../../services/pagespeed.service.js';

export type { PageSpeedReport };

// ─── Normalized store snapshot ───────────────────────────────────────
// The single shape every audit check consumes. Checks must NEVER see a raw
// Shopify (or any other platform's) response — that is the whole point of this
// layer: adding a second platform later means adding one provider, not touching
// 33 checks. See store-data/index.ts for provider resolution.
//
// Fetch once -> normalize once -> reuse across all checks (master prompt: PERFORMANCE).

export interface SnapshotImage {
  id: string;
  src: string;
  /** null = attribute genuinely absent; '' = present but empty. The distinction matters
   * to the image-alt-text check, so it is preserved rather than collapsed. */
  alt: string | null;
  width: number | null;
  height: number | null;
}

/**
 * A product option as the merchant configured it ("Size" -> S/M/L).
 *
 * Shopify gives every product at least one option: a single-variant product carries the
 * synthetic `Title` option with the single value `Default Title`. That placeholder is preserved
 * here exactly as returned — recognising it is how the CRO options check distinguishes "this
 * product genuinely has no variants" from "this product has variants the shopper cannot tell
 * apart", and normalizing it away in the provider would destroy that signal.
 */
export interface SnapshotProductOption {
  name: string;
  values: string[];
}

/** The purchase-decision fields of one variant. Deliberately narrow: no inventory levels (that
 * needs `read_inventory`, which is not granted) and nothing customer-identifying. */
export interface SnapshotVariant {
  id: string;
  /** Merchant's own stock identifier. null = genuinely absent, never '' . */
  sku: string | null;
  /** GTIN/EAN/UPC — the identifier shopping feeds and AI agents match on. */
  barcode: string | null;
  /** Parsed from Shopify's decimal string. null when unreadable, 0 is a real (and broken) price. */
  price: number | null;
  availableForSale: boolean;
}

export interface SnapshotProduct {
  id: string;
  title: string;
  handle: string;
  /** Storefront URL derived from the shop domain + handle. */
  url: string;
  bodyHtml: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: string;
  publishedAt: string | null;
  updatedAt: string | null;
  images: SnapshotImage[];
  variantCount: number;
  /** Option definitions, including Shopify's synthetic `Title`/`Default Title` placeholder. */
  options: SnapshotProductOption[];
  /** Variants actually read, capped per product — see VARIANT_SAMPLE_LIMIT in the provider. */
  variants: SnapshotVariant[];
  /** True when the product has MORE variants than were read. A check must then describe its
   * result as covering the sample, never the whole product. */
  variantsTruncated: boolean;
  /** How many selling-plan (subscription / try-before-you-buy) groups this product belongs to.
   * 0 across the whole catalogue means no subscription programme exists to audit. */
  /** null when Shopify did not report it — unknown, never "not enrolled". */
  sellingPlanGroupCount: number | null;
  /** Present only when the provider was granted the scope to read them; an empty array
   * with `metafieldsAvailable: false` means "unknown", not "none". */
  metafields: Array<{ namespace: string; key: string; type: string; hasValue: boolean }>;
  metafieldsAvailable: boolean;
  /** SEO overrides the merchant set in Shopify admin (global_title / global_description).
   * null means no override — the theme falls back to the product title/description. */
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface SnapshotCollection {
  id: string;
  title: string;
  handle: string;
  url: string;
  bodyHtml: string;
  productCount: number | null;
  /** When Shopify last recorded a change to the collection. Null when it did not say. */
  updatedAt: string | null;
  /** The collection's featured image. Null when it has none. */
  image: SnapshotImage | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface SnapshotPage {
  id: string;
  title: string;
  handle: string;
  url: string;
  bodyHtml: string;
  publishedAt: string | null;
  updatedAt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface SnapshotArticle {
  id: string;
  blogId: string;
  blogHandle: string;
  title: string;
  handle: string;
  url: string;
  bodyHtml: string;
  publishedAt: string | null;
  updatedAt: string | null;
  image: SnapshotImage | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface SnapshotPolicy {
  type: string;
  title: string;
  body: string;
  url: string | null;
}

export interface SnapshotShop {
  domain: string;
  /** The canonical public storefront origin, e.g. https://acme.myshopify.com */
  primaryUrl: string;
  name: string;
  email: string | null;
  currency: string | null;
  country: string | null;
  timezone: string | null;
  planName: string | null;
}

// ─── Theme (Speed pillar) ────────────────────────────────────────────
// Read through `read_themes`, which is already granted. Checks stay pure: all Shopify calls
// happen in the provider, and Speed checks consume only this normalized shape.

export interface SnapshotThemeAsset {
  /** Theme-relative path, e.g. "assets/base.css". */
  filename: string;
  /** Size in bytes as reported by the Admin API. */
  size: number;
  contentType: string | null;
}

/** An app embed block from config/settings_data.json — the app-bloat signal that IS visible
 * through the Admin API (ScriptTag records would need `read_script_tags`, which is not granted,
 * and storefront-injected scripts need a crawl). */
export interface SnapshotAppEmbed {
  /** e.g. "shopify://apps/<app>/blocks/<block>/<id>" — the app segment names the app. */
  type: string;
  disabled: boolean;
}

export interface SnapshotTheme {
  name: string;
  /** Shopify Theme Store id — identifies a stock theme like Dawn. Null for custom themes. */
  themeStoreId: number | null;
  updatedAt: string | null;
  /** Every file under assets/ with its byte size. Bodies are deliberately NOT fetched here. */
  assets: SnapshotThemeAsset[];
  assetsTruncated: boolean;
  /** App embed blocks parsed from config/settings_data.json. Null = the file could not be read
   * or parsed, which is "unknown", never "no apps". */
  appEmbeds: SnapshotAppEmbed[] | null;
  /** External (absolute-URL) <script src> tags hardcoded in layout/theme.liquid — third-party
   * scripts that load on every page. Null = layout could not be read. */
  externalScripts: string[] | null;
}

// ─── Storefront reachability (crawl-dependent checks) ────────────────
// A handful of cheap, read-only HTTP probes performed once per snapshot. Checks that need
// rendered HTML consult this instead of fetching themselves, and a password-protected
// storefront is DETECTED here rather than discovered as a mystery failure inside every check.

export interface StorefrontProbe {
  status: number;
  /** True when the response redirected to /password — Shopify's storefront gate. */
  passwordGated: boolean;
  /** Body text, only captured for robots.txt (small and needed by the sitemap check). */
  body?: string;
}

export interface SnapshotStorefront {
  homepage: StorefrontProbe;
  robots: StorefrontProbe;
  sitemap: StorefrontProbe;
  /** True when ANY probe hit the password gate — the storefront is not publicly reachable. */
  passwordProtected: boolean;
}

// ─── URL redirects (handles-redirects check) ─────────────────────────
export type SnapshotRedirects =
  /** Every redirect the shop has — read to the end of Shopify's list. `truncated` only when the
   * cursor stopped advancing, which the check reports rather than hides. */
  | { available: true; items: Array<{ id: string; path: string; target: string }>; truncated: boolean }
  /** 'scope' = urlRedirects was DENIED (needs read_online_store_navigation); 'error' = other. */
  | { available: false; reason: 'scope' | 'error'; detail: string };

// ─── Handle index (handles-redirects check) ──────────────────────────
export type HandleResourceType = 'product' | 'collection' | 'page' | 'article';

export interface SnapshotHandle {
  id: string;
  type: HandleResourceType;
  title: string;
  handle: string;
  /** Articles only. */
  blogHandle: string | null;
  /** From Shopify's own publication fields. Null where the Admin data carries none (collections). */
  published: boolean | null;
}

/**
 * Every handle of every resource type the audit covers, COMPLETE per type or marked otherwise.
 *
 * The catalogue fetch caps collections, pages and articles at 250 and products at a memory
 * ceiling, which is fine for checks that read content but not for a handle audit: a redirect
 * pointing at the 251st collection would be reported as pointing at nothing. So the provider reuses
 * a catalogue list only when it is complete, and otherwise reads that type's handles to the end.
 */
export interface SnapshotHandleIndex {
  handles: SnapshotHandle[];
  /** Per type: true when every handle Shopify has was read. A type that is false or missing must
   * not be used to claim a destination does not exist. */
  complete: Partial<Record<HandleResourceType, boolean>>;
  /** Why a type is incomplete, per type. */
  gaps: Partial<Record<HandleResourceType, string>>;
}

/**
 * Why the shop's policies are absent, when they are.
 *
 * Distinguished from a plain coverage flag for the same reason redirects are: `shopPolicies` moved
 * behind its own `read_legal_policies` scope, so the overwhelmingly likely cause of a failure here
 * is a permission the merchant has not granted yet — not an outage. A check told only "no policies"
 * would report an unactionable "could not read"; told "scope", it can name the permission and what
 * granting it will do.
 */
export type SnapshotPolicyAccess =
  | { available: true }
  | { available: false; reason: 'scope' | 'error'; detail: string };

// ─── AI Discovery inputs ─────────────────────────────────────────────
// The two things the AI Discovery pillar needs that no amount of reading a store can supply:
// a key the merchant chose to publish, and questions the merchant wants asked.
//
// Both are carried on the snapshot rather than read by the checks themselves, because a check is
// a pure function of a snapshot — that is what makes it unit-testable without a database. The
// provider is given these already loaded (see store-data/index.ts), so the rule holds.

/** One real API call that really happened: this question, this model, this moment. */
export interface SnapshotPromptObservation {
  /** The provider's own model id, as asked. Never a family name and never inferred. */
  model: string;
  mentioned: boolean;
  /** The sentence the brand appeared in, quoted from the answer. Null when not mentioned. */
  mentionContext: string | null;
  checkedAt: string;
}

export interface SnapshotPromptQuery {
  id: number;
  /** The merchant's own question. Rankvora AI never invents one. */
  query: string;
  /** What counts as a mention for this query — usually the brand name. */
  brandTerm: string;
  active: boolean;
  /**
   * Every recorded observation for this query, newest first. EMPTY means never checked, which is
   * a different fact from "checked and never mentioned" and must be reported as such.
   */
  observations: SnapshotPromptObservation[];
}

export interface SnapshotAiDiscovery {
  /** The IndexNow key the merchant publishes, or null when they have not set one up. */
  indexNowKey: string | null;
  indexNowKeySetAt: string | null;
  promptQueries: SnapshotPromptQuery[];
  /**
   * Whether an AI provider is configured on this deployment. Prompt tracking cannot run without
   * one, and a store with no results because the operator configured no key is "not measured" —
   * never "your store is never mentioned".
   */
  aiConfigured: boolean;
}

// ─── PageSpeed Insights (Speed pillar · Core Web Vitals) ─────────────
// Core Web Vitals are RENDER-TIME facts: they exist only in a browser loading the real public
// page, and nothing in the Admin API approximates them. The measurement therefore comes from
// outside the store data entirely — Google's PageSpeed Insights API, run by the connector on the
// Integrations page — and reaches the snapshot the same way the AI Discovery inputs do: loaded in
// store-data/index.ts and handed to the provider, so the check stays a pure function.
//
// THE STORED MEASUREMENT IS REUSED, NOT RE-RUN. A PageSpeed run takes Google tens of seconds per
// strategy, and an audit that triggered two would add minutes to every run for a number that
// barely moves between them. The check therefore reports WHEN the measurement was taken and lets
// a stale one say so, rather than silently presenting an old reading as current.

export interface SnapshotPageSpeed {
  /** The newest measurement per strategy. Empty = never measured, which is not "no problems". */
  reports: PageSpeedReport[];
  /** Why the last attempt failed, when one did. Null = no failure on record. */
  lastError: string | null;
}

/** Which resource groups this snapshot actually contains. A check MUST consult this before
 * scoring: `false` means "we could not look", which is reported as `unavailable`, never as a
 * pass and never as a zero. This is what keeps "unknown" distinguishable from "healthy". */
export interface SnapshotCoverage {
  shop: boolean;
  products: boolean;
  collections: boolean;
  pages: boolean;
  articles: boolean;
  policies: boolean;
  metafields: boolean;
  theme: boolean;
  storefront: boolean;
  /** True only when the crawler fetched and parsed at least one rendered page. A check that
   * needs rendered HTML MUST consult this — Admin coverage says nothing about it. */
  crawl: boolean;
}

/** Scope limits genuinely applied while building the snapshot, surfaced in audit metadata
 * so a partially-scanned large store is never presented as a full scan. */
export interface SnapshotScope {
  productLimit: number;
  /**
   * How many products/collections the STORE actually has, so the UI can report
   * "analysed of available" instead of implying the analysed count is the whole catalogue.
   * null when the count could not be read. `exact: false` means Shopify reported AT_LEAST.
   */
  productsAvailable: { count: number; exact: boolean } | null;
  collectionsAvailable: { count: number; exact: boolean } | null;
  productsTruncated: boolean;
  collectionsTruncated: boolean;
  pagesTruncated: boolean;
  articlesTruncated: boolean;
}

export interface StoreSnapshot {
  storeId: number;
  capturedAt: Date;
  shop: SnapshotShop;
  products: SnapshotProduct[];
  collections: SnapshotCollection[];
  pages: SnapshotPage[];
  articles: SnapshotArticle[];
  policies: SnapshotPolicy[];
  /** Why `policies` is empty, when it is. `{ available: true }` whenever the fetch succeeded. */
  policyAccess: SnapshotPolicyAccess;
  /** Null when the theme could not be read (coverage.theme false). */
  theme: SnapshotTheme | null;
  /** Null when the storefront probes could not run (coverage.storefront false). */
  storefront: SnapshotStorefront | null;
  redirects: SnapshotRedirects;
  /** Complete handle lists for the handles-redirects check. Absent on snapshots built before it
   * existed (and in fixtures that do not need it) — the check then verifies nothing against it. */
  handleIndex?: SnapshotHandleIndex;
  /** Rendered-storefront evidence. Null when crawling was disabled or never attempted.
   * NEVER substitute Admin fields for this — see storefront/types.ts. */
  crawl: StorefrontCrawl | null;
  /**
   * Merchant-supplied AI Discovery inputs. Absent on snapshots built before this existed (and in
   * fixtures that do not need it); a check must then report "not configured" rather than assume
   * an empty configuration, because those are different facts.
   */
  aiDiscovery?: SnapshotAiDiscovery;
  /**
   * The store's most recent PageSpeed Insights measurements. Absent on snapshots built before
   * this existed (and in fixtures that do not need it); the Core Web Vitals check must then
   * report "not measured" rather than assume none was ever taken — those are different facts.
   */
  pageSpeed?: SnapshotPageSpeed;
  coverage: SnapshotCoverage;
  scope: SnapshotScope;
  /** Non-fatal problems hit while building the snapshot (e.g. a scope-denied resource).
   * Recorded rather than thrown so one missing resource cannot kill an entire audit. */
  warnings: string[];
}

/** The steps of reading a store, in the order a snapshot performs them. */
export type SnapshotStep =
  | 'shop'
  | 'products'
  | 'collections'
  | 'pages'
  | 'articles'
  | 'policies'
  | 'theme'
  | 'storefront'
  | 'redirects'
  | 'handles'
  | 'crawl';

/**
 * Reported by a provider as it reads the store — only ever for work that has actually happened.
 *
 * `label` is for the merchant and carries real counts ("Reading products — 1,250 of 6,762").
 * `fraction` is how far through this step it is, 0–1, and is given only when both sides are real
 * numbers (items read of a total Shopify reported, pages loaded of the pages chosen). A step with
 * no known total reports no fraction rather than a guessed one.
 */
export interface SnapshotProgress {
  step: SnapshotStep;
  label: string;
  fraction?: number;
}

export interface StoreDataProvider {
  readonly kind: string;
  /** Builds the full normalized snapshot. May throw StoreDataError for fatal conditions
   * (revoked token, unreachable API); per-resource failures should degrade to coverage
   * flags + warnings instead. `onProgress`, when given, is awaited at each step. */
  buildSnapshot(onProgress?: (update: SnapshotProgress) => Promise<void> | void): Promise<StoreSnapshot>;
}

export type StoreDataErrorCode =
  | 'NOT_CONNECTED'
  | 'TOKEN_REVOKED'
  | 'MISSING_SCOPES'
  | 'RATE_LIMITED'
  | 'API_UNAVAILABLE'
  | 'MALFORMED_RESPONSE';

export class StoreDataError extends Error {
  constructor(
    readonly code: StoreDataErrorCode,
    message: string,
    /** Transient errors are worth retrying; permanent ones (revoked token) are not. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StoreDataError';
  }
}
