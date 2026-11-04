import type { AuditCheck } from './types.js';
import { titleTagsCheck } from './checks/seo/title-tags.js';
import { metaDescriptionsCheck } from './checks/seo/meta-descriptions.js';
import { imageAltTextCheck } from './checks/seo/image-alt-text.js';
import { canonicalsCheck } from './checks/seo/canonicals.js';
import { sitemapIndexabilityCheck } from './checks/seo/sitemap-indexability.js';
import { handlesRedirectsCheck } from './checks/seo/handles-redirects.js';
import { imageWeightCheck } from './checks/speed/image-weight.js';
import { themeWeightCheck } from './checks/speed/theme-weight.js';
import { appBloatCheck } from './checks/speed/app-bloat.js';
import { cwvCheck } from './checks/speed/cwv.js';
import { productDescriptionsCheck, collectionDescriptionsCheck } from './checks/content/descriptions.js';
import { metafieldsCheck } from './checks/content/metafields.js';
import { dupTemplatedCheck } from './checks/content/dup-templated.js';
import { blogFreshnessCheck } from './checks/content/blog-freshness.js';
import { mediaRichnessCheck } from './checks/content/media-richness.js';
import { returnsCheck } from './checks/cro/returns.js';
import { optionsCheck } from './checks/cro/options.js';
import { subscriptionCheck } from './checks/cro/subscription.js';
import { feedCheck } from './checks/ai-discovery/feed.js';
import { agenticAttrsCheck } from './checks/ai-discovery/agentic-attrs.js';
import { agentsMdCheck } from './checks/ai-discovery/agents-md.js';
import { answerableQaCheck } from './checks/ai-discovery/answerable-qa.js';
import { indexNowCheck } from './checks/ai-discovery/indexnow.js';
import { indexingFreshnessCheck } from './checks/ai-discovery/indexing-freshness.js';
import { promptTrackingCheck } from './checks/ai-discovery/prompt-tracking.js';
import { schemaCheck } from './checks/seo/schema.js';
import { internalLinksCheck } from './checks/seo/internal-links.js';
import { clarityCheck } from './checks/cro/clarity.js';
import { codCheck, locatorCheck, mobileUxCheck, trustCheck, wishlistCheck } from './checks/cro/storefront-signals.js';

/**
 * Every audit check the engine will run, in one flat registry.
 *
 * The runner groups by `pillar` at execution time and isolates each check's failure, so this
 * list grows one check at a time with no runner changes and no risk to already-live checks.
 *
 * A sub-pillar with no check here is genuinely absent from the audit — the runner drops pillars
 * that produced no results, and the UI renders "not measured". That is deliberate: an
 * unimplemented check must never be persisted as a zero.
 */
export const checkRegistry: AuditCheck[] = [
  // ─── SEO ───────────────────────────────────────────────────────────
  titleTagsCheck,
  metaDescriptionsCheck,
  imageAltTextCheck, // catalog media only — theme images need the storefront crawl
  canonicalsCheck, // rendered canonical tags from the crawl + duplicate pages from Admin data
  sitemapIndexabilityCheck, // live HTTP probes: storefront gate, robots.txt, sitemap.xml
  handlesRedirectsCheck, // every UrlRedirect + every handle; "not measured" (naming the scope) without read_online_store_navigation
  schemaCheck, // rendered JSON-LD via the storefront crawl
  internalLinksCheck, // rendered anchors + verified target status via the storefront crawl
  // ─── Content ───────────────────────────────────────────────────────
  productDescriptionsCheck,
  collectionDescriptionsCheck,
  metafieldsCheck,
  dupTemplatedCheck,
  blogFreshnessCheck,
  mediaRichnessCheck,
  // ─── Speed ─────────────────────────────────────────────────────────
  imageWeightCheck, // source dimensions + format from the Admin API
  themeWeightCheck, // real asset bytes via read_themes
  appBloatCheck, // app embeds + hardcoded layout scripts via read_themes
  cwvCheck, // honestly unavailable until lab tooling + a public storefront exist
  // ─── CRO ───────────────────────────────────────────────────────────
  returnsCheck, // real refund policy text via read_content
  optionsCheck, // real option/variant structure via read_products
  subscriptionCheck, // real selling-plan enrolment; 'unavailable' when no programme exists
  clarityCheck, // rendered heading/content structure via the storefront crawl
  trustCheck, // rendered trust signals via the storefront crawl
  wishlistCheck, // rendered wishlist evidence via the storefront crawl
  locatorCheck, // rendered store-locator evidence via the storefront crawl
  codCheck, // honestly unavailable — checkout payment config is not readable
  mobileUxCheck, // honestly unavailable until a rendering browser exists
  // ─── AI Discovery ──────────────────────────────────────────────────
  feedCheck, // real variant identifiers, price and availability via read_products
  agenticAttrsCheck, // purchase-action readiness from the same variant data
  agentsMdCheck, // real HTTP requests for /agents.md and /llms.txt
  answerableQaCheck, // real description content (Admin) + rendered FAQ JSON-LD (crawl)
  indexNowCheck, // real HTTP request for the merchant's own /<key>.txt; 'not configured' without a key
  indexingFreshnessCheck, // per-crawler robots.txt verdicts, live bot probes, sitemap <lastmod> vs Shopify updatedAt
  promptTrackingCheck, // recorded assistant answers; 'not measured' until enough real samples exist
];

/**
 * Sub-pillars that have a registered check, as `pillar/subPillar`.
 *
 * The UI uses this to tell two very different empty states apart: "this store has not been
 * audited yet" (run one) versus "Rankvora AI cannot measure this yet" (running an audit will not
 * help). Derived from the registry rather than hand-listed, so it cannot drift out of date.
 */
export const implementedSubPillars: string[] = checkRegistry.map((check) => `${check.pillar}/${check.subPillar}`);
