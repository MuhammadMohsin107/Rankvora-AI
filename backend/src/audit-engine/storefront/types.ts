// ─── Storefront crawl evidence ───────────────────────────────────────
// What a crawl-based check is allowed to reason about.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a check that asks "what does the rendered page contain?"
// must read it from here, never from the Admin snapshot. The Admin API knows what the merchant
// TYPED; only the storefront knows what the theme actually SERVED. A product whose Admin
// `seo.title` is perfect can still render a title the theme built from a different field, and a
// store whose Admin record lists no apps can still load six third-party scripts. Substituting one
// for the other produces a confident, wrong score — which is the single failure mode this whole
// separation is designed to make impossible.

/** Why a page could not be turned into evidence. Never collapsed into "failed" — the distinction
 * decides whether a check reports a real problem or reports that it could not look. */
export type CrawlFailureReason =
  | 'password_gated'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'ssl'
  | 'http_error'
  | 'not_html'
  | 'too_large'
  | 'redirect_loop'
  | 'blocked'
  | 'aborted';

export interface CrawlHeading {
  /** 1-6. */
  level: number;
  text: string;
}

export interface CrawlLink {
  /** Absolute, normalised, fragment stripped. */
  url: string;
  /** Raw href as authored, kept so evidence can quote what is actually in the markup. */
  href: string;
  text: string;
  internal: boolean;
  rel: string | null;
}

export interface CrawlImage {
  src: string;
  /** null = no alt ATTRIBUTE at all; '' = present but empty (decorative). The distinction is the
   * whole point of an alt-text check, so it is preserved exactly as authored. */
  alt: string | null;
  loading: string | null;
  width: string | null;
  height: string | null;
}

export interface CrawlScript {
  /** Absolute src, or null for an inline script. */
  src: string | null;
  /** Host of `src`, for third-party attribution. Null when inline or unparseable. */
  host: string | null;
  /** True when the host is not the storefront's own. */
  thirdParty: boolean;
  async: boolean;
  defer: boolean;
  /** Byte length of an inline script body; 0 for external. */
  inlineBytes: number;
}

/** One parsed JSON-LD block. `types` is flattened across @graph so a check can ask "is there a
 * Product?" without re-walking the structure. */
export interface CrawlJsonLd {
  /** Every @type found anywhere in this block, including inside @graph. */
  types: string[];
  /** Parsed value. Kept so a check can inspect required properties (offers, price, …). */
  data: unknown;
  /** Set when the block was present but could not be parsed — a real, reportable defect. */
  parseError: string | null;
}

/** A page Rankvora AI actually fetched and parsed. */
export interface CrawledPage {
  /** The URL Rankvora AI requested. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  /** Which Shopify resource this page represents, for grouping evidence by page type. */
  pageType: 'home' | 'product' | 'collection' | 'page' | 'article' | 'other';
  /** The Admin resource id this URL was built from, when it came from the snapshot. */
  resourceId: string | null;
  status: number;
  redirectChain: string[];
  responseTimeMs: number;
  /** Transferred bytes of the HTML document itself. */
  bytes: number;

  title: string | null;
  metaDescription: string | null;
  /** The first canonical in <head>, as authored. Null when <head> declares none. */
  canonical: string | null;
  /** Every canonical href in <head>, in document order, as authored ('' for a tag with no href).
   * More than one is a defect the canonicals check reports, so none are discarded. */
  canonicals: string[];
  /** Canonical tags found after </head>, which search engines ignore. */
  canonicalsOutsideHead: string[];
  /** Raw content of <meta name="robots">, lower-cased. */
  robots: string | null;
  /** True when the page asks not to be indexed. */
  noindex: boolean;

  headings: CrawlHeading[];
  links: CrawlLink[];
  images: CrawlImage[];
  scripts: CrawlScript[];
  jsonLd: CrawlJsonLd[];

  /** Visible text length, used as a crude content-presence signal. Not a quality judgement. */
  textLength: number;
  /** Lower-cased visible text, capped. Present so trust/locator checks can look for rendered
   * wording without every check re-deriving it from the HTML. */
  text: string;
}

export interface CrawlFailure {
  url: string;
  pageType: CrawledPage['pageType'];
  resourceId: string | null;
  reason: CrawlFailureReason;
  status: number;
  detail: string;
}

/** A non-HTML resource fetched verbatim (robots.txt, sitemap.xml, agents.md, llms.txt). */
export interface FetchedResource {
  url: string;
  finalUrl: string;
  status: number;
  /** Null when the fetch failed or the body was not captured. */
  body: string | null;
  contentType: string | null;
  /**
   * True when this response is Shopify's password screen rather than the resource.
   *
   * A gated storefront answers EVERY url with HTTP 200 and the password page, so `status === 200`
   * proves nothing on its own. Reporting agents.md as "present" because the gate returned 200
   * would be a fabricated result — this flag is what stops that.
   */
  passwordGated: boolean;
  reason: CrawlFailureReason | null;
}

/**
 * One `<url>` entry of a sitemap, with the freshness claim it carries.
 *
 * `lastmod` is the whole reason this exists alongside the plain URL list: it is the ONLY signal a
 * store publishes about when a page last changed, and it is what decides whether a crawler
 * bothers to re-fetch. A sitemap with no lastmod, or with one that disagrees with the catalogue,
 * is why a changed product can sit un-recrawled for weeks.
 */
export interface SitemapEntry {
  loc: string;
  /** Raw `<lastmod>` as published, null when the entry declares none. Never inferred. */
  lastmod: string | null;
}

/**
 * What the storefront answered when asked for a page AS a named AI or search crawler.
 *
 * Rankvora AI sends the bot's own user-agent string and nothing else — it does not forge a reverse-DNS
 * identity, and says so in its evidence. The point is not to impersonate: it is to catch an edge
 * rule, WAF or bot-manager that answers Googlebot and GPTBot differently from a normal browser.
 * That difference is invisible to robots.txt parsing, because it happens above robots.txt.
 */
export interface BotAccessProbe {
  /** The crawler's canonical name, e.g. 'GPTBot'. */
  bot: string;
  /** The exact User-Agent sent. */
  userAgent: string;
  status: number;
  /** Bytes of the body returned, so a soft-block ("Access denied" page, HTTP 200) is visible. */
  bytes: number;
  /** True when the response was Shopify's password screen rather than a real answer. */
  passwordGated: boolean;
  /** Set when no response arrived at all — reported as "not measured", never as "blocked". */
  reason: CrawlFailureReason | null;
}

/**
 * What a canonical URL answered when Rankvora AI requested it, redirects NOT followed.
 *
 * Only targets that differ from the page declaring them are requested — a self-referencing
 * canonical points at a page the crawl has just loaded.
 */
export interface CanonicalTargetStatus {
  /** HTTP status of the first response. 0 when no response arrived (see `reason`). */
  status: number;
  /** Where a 3xx sent the request, absolute. Null when it did not redirect. */
  location: string | null;
  /** Set when the request failed before any response — never reported as a broken target. */
  reason: CrawlFailureReason | null;
}

/** Why a whole crawl produced nothing. Checks turn this into an honest `unavailable` reason. */
export type CrawlUnavailableReason =
  | 'disabled'
  | 'password_gated'
  | 'unreachable'
  | 'no_targets';

export interface StorefrontCrawl {
  origin: string;
  startedAt: Date;
  /** True when at least one HTML page was fetched and parsed. */
  available: boolean;
  /** Set only when `available` is false. */
  unavailableReason: CrawlUnavailableReason | null;
  /**
   * True when the storefront is behind Shopify's access gate and Rankvora AI could not get past it.
   * Every rendered-HTML check must report `unavailable` in this state — the password page is real
   * HTML, and analysing it would describe Shopify's markup, not the merchant's.
   */
  passwordGated: boolean;
  pages: CrawledPage[];
  failures: CrawlFailure[];
  robots: FetchedResource | null;
  sitemap: FetchedResource | null;
  /** Sitemaps referenced by robots.txt, or child sitemaps of a sitemap index. */
  sitemapUrls: string[];
  /** URLs listed across the sitemap(s) actually fetched. */
  sitemapEntries: string[];
  /**
   * The same entries with their published `<lastmod>`. Kept alongside `sitemapEntries` rather than
   * replacing it so every existing check keeps the shape it already reads.
   */
  sitemapRecords: SitemapEntry[];
  agentsMd: FetchedResource | null;
  llmsTxt: FetchedResource | null;
  /**
   * `/<key>.txt` as the IndexNow spec requires it, fetched only when the store has a key on file.
   * Null means Rankvora AI had no key to look for — which is "not configured", never "missing file".
   */
  indexNowKeyFile: FetchedResource | null;
  /** Per-crawler responses to the storefront root. Empty when bot probing was not performed. */
  botAccess: BotAccessProbe[];
  /** Status of internal link targets Rankvora AI verified, keyed by absolute URL. */
  linkStatuses: Record<string, number>;
  /** Canonical URLs that differ from the page declaring them, as requested without following
   * redirects, keyed by absolute URL. Off-origin targets are never requested and so are absent. */
  canonicalTargets: Record<string, CanonicalTargetStatus>;
  /** Limits actually applied, so a partial crawl is never presented as exhaustive. */
  budget: { maxPages: number; concurrency: number; timeoutMs: number; pagesFetched: number; truncated: boolean };
  /** Non-fatal problems worth surfacing to an operator. Never contains credentials. */
  warnings: string[];
}
