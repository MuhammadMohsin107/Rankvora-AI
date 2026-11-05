# Sub-pillar → data source map

What every one of the 36 sub-pillars needs, where that data can actually come from, and which
Shopify scope (if any) unlocks it.

This exists because "we have the Shopify Admin API" is not the same as "we can answer every SEO
question". A large share of Rankvora AI's checks are about what a *rendered page* contains — canonical
tags, JSON-LD, heading structure, script weight — and the Admin API cannot see any of that. Writing
a check that infers a rendered outcome from an Admin API field would produce a confident, wrong
score. The **Source** column below is the guard against that.

## Sources

| Key | Meaning |
|---|---|
| **Admin** | Shopify Admin GraphQL API — already implemented in `store-data/shopify.provider.ts` |
| **Crawl** | Rendered storefront HTML, fetched by `audit-engine/storefront/crawler.ts`. **Implemented.** |
| **Merchant** | A value only the merchant can supply, stored per store and carried on the snapshot as `aiDiscovery` (see `services/ai-discovery.service.ts`). No amount of reading a store produces it — an IndexNow key is a secret they publish, and a tracked question is one they choose. A store that has supplied neither is reported as *not configured*, never as failing. |
| **AI provider** | The model configured on the deployment (`AI_PROVIDER` + key). Only `prompt-tracking` needs it, and it reports `unavailable` rather than a zero when none is set. |
| **Field** | Real-user Core Web Vitals from the Chrome UX Report, read through Google's PageSpeed Insights API and carried on the snapshot as `pageSpeed` (see `services/pagespeed.service.ts`). **Implemented.** Exists only for urls with enough real traffic, so a new or quiet store genuinely has none — reported as *no real-visitor data yet*, never as a zero. |
| **Lab** | One Lighthouse run on Google's emulated device, from the same PageSpeed Insights response. **Implemented.** Always available and deliberately pessimistic; it diagnoses, it does not describe any real visit. INP has no lab equivalent and is never produced from one. |
| **Protected** | Requires a scope Rankvora AI deliberately does not request (`read_orders` / `read_customers`), which needs Shopify Protected Customer Data approval |

## Granted scopes

| Scope | Unlocks | Used by |
|---|---|---|
| `read_products` | Product, Collection: title, `descriptionHtml`, `seo`, media alt text, metafields, product options, variants (sku/barcode/price/availability), `sellingPlanGroupCount` | SEO, Content, CRO, AI Discovery |
| `read_content` | Page, Blog, Article (implicitly grants `read_online_store_pages`) | SEO, Content |
| `read_themes` | Online store theme records | Speed |
| `read_metaobjects` | Metaobject instances | Content, AI Discovery |
| `read_legal_policies` | Shop policies (refund/shipping/privacy/terms) | CRO |

---

## SEO (8)

| Sub-pillar | Required data | Source | Scope | Status |
|---|---|---|---|---|
| `title-tags` | `Product.seo.title`, `Collection.seo.title`, Page/Article `global.title_tag` metafield, fallback titles | Admin | `read_products`, `read_content` | **Implemented** — `checks/seo/title-tags.ts` |
| `meta-descriptions` | `.seo.description` + `global.description_tag` | Admin | `read_products`, `read_content` | **Implemented** — `checks/seo/meta-descriptions.ts` |
| `schema` | JSON-LD blocks in rendered page `<head>` | **Crawl** | — | **Implemented** — `checks/seo/schema.ts` |
| `image-alt-text` | `MediaImage.alt` for catalog images; rendered `<img alt>` for theme images | Admin (partial) + **Crawl** | `read_products` | **Implemented (Admin half)** — `checks/seo/image-alt-text.ts`; rendered theme images are reported by `checks/cro/clarity.ts` |
| `canonicals` | `<link rel="canonical">` as rendered; duplicate handle detection | **Crawl** (+ Admin for handles) | `read_products` | **Implemented** — `checks/seo/canonicals.ts`: rendered `<link rel="canonical">` on every crawled page (missing, empty, conflicting, off-domain, pointing elsewhere; targets that point elsewhere are requested to catch broken and redirecting ones), plus duplicate pages across the published catalogue |
| `handles-redirects` | `UrlRedirect` records (complete, paginated), handles of every product/collection/page/article | Admin | `read_online_store_navigation` (requested; stores connected before it was added must re-approve) + `read_products`, `read_content` | **Implemented** — `checks/seo/handles-redirects.ts`: broken destinations, loops, chains, inactive redirects, duplicate sources, invalid targets, copy-of and badly formatted handles. Reports "not measured" with the exact scope when the permission is missing |
| `sitemap` | `/sitemap.xml`, `/robots.txt`, per-page `noindex` | **Crawl** | — | **Implemented** — `checks/seo/sitemap-indexability.ts` |
| `internal-links` | Rendered anchor graph, HTTP status of each target | **Crawl** | — | **Implemented** — `checks/seo/internal-links.ts` (a sample of the audit's pages and up to 25 targets). The complete picture — every page, every link to the store and to other websites — is the separate link scan (`link-scan/engine.ts`), shown on the same page |

## Content (6)

| Sub-pillar | Required data | Source | Scope | Status |
|---|---|---|---|---|
| `product-descriptions` | `Product.descriptionHtml` | Admin | `read_products` | **Implemented** — `checks/content/descriptions.ts` |
| `collection-descriptions` | `Collection.descriptionHtml` | Admin | `read_products` | **Implemented** — `checks/content/descriptions.ts` |
| `metafields` | `Product.metafields`, metaobject definitions | Admin | `read_products`, `read_metaobjects` | **Implemented** — `checks/content/metafields.ts` |
| `dup-templated` | Description corpus across products for similarity | Admin | `read_products` | **Implemented** — `checks/content/dup-templated.ts` |
| `blog-freshness` | `Article.publishedAt` / `updatedAt` | Admin | `read_content` | **Implemented** — `checks/content/blog-freshness.ts` |
| `media-richness` | Media count per product/article | Admin | `read_products`, `read_content` | **Implemented** — `checks/content/media-richness.ts` |

## Speed (4)

| Sub-pillar | Required data | Source | Scope | Status |
|---|---|---|---|---|
| `cwv` | LCP, INP, CLS — field (CrUX) preferred, lab (Lighthouse) where there is none | **Field** + **Lab** | — | **Implemented** — `checks/speed/cwv.ts`, from the PageSpeed Insights connector. Reports `unavailable` until a measurement has been run; INP only ever from field data |
| `image-weight` | Transferred bytes and dimensions per rendered image | **Lab** + Admin (dimensions) | `read_products` | **Implemented (Admin half)** — `checks/speed/image-weight.ts`; transferred bytes still need Lab |
| `app-bloat` | Third-party scripts on the rendered page | **Crawl** | — | **Implemented (Admin half)** — `checks/speed/app-bloat.ts`; rendered scripts are now captured by the crawler and not yet consumed |
| `theme-weight` | Theme record + rendered asset weight, font loading, lazy-load | Admin (partial) + **Lab** | `read_themes` | **Implemented (Admin half)** — `checks/speed/theme-weight.ts` |

## CRO (11)

| Sub-pillar | Required data | Source | Scope | Status |
|---|---|---|---|---|
| `clarity` | Rendered PDP structure and copy hierarchy | **Crawl** | — | **Implemented** — `checks/cro/clarity.ts` (objective structure only) |
| `cart-recovery` | Abandoned checkout behaviour | **Protected** | `read_orders` — not granted | **Requires additional Shopify permission** |
| `trust` | Review widgets, badges, policy links as rendered | **Crawl** (+ Admin for policies) | `read_content` | **Implemented** — `checks/cro/storefront-signals.ts` |
| `returns` | `ShopPolicy` of type `REFUND_POLICY` | Admin | `read_legal_policies` | **Implemented** — `checks/cro/returns.ts` |
| `tracking` | Fulfilment/tracking configuration | **Protected** | `read_orders` — not granted | **Requires additional Shopify permission** |
| `cod` | Payment method configuration at checkout | **Checkout — not readable** | — | **Implemented as permanently `not_measured`** — page copy is not proof of checkout config |
| `options` | `Product.options`, variant structure | Admin | `read_products` | **Implemented** — `checks/cro/options.ts` |
| `subscription` | Selling plan groups | Admin | `read_products` | **Implemented** — `checks/cro/subscription.ts` |
| `wishlist` | Wishlist app presence on rendered page | **Crawl** | — | **Implemented** — `checks/cro/storefront-signals.ts` |
| `locator` | Store locator page/app presence | **Crawl** (+ Admin for pages) | `read_content` | **Implemented** — `checks/cro/storefront-signals.ts` |
| `mobile-ux` | Rendered mobile viewport behaviour | **Lab** | — | **Implemented as `not_measured`** — needs a rendering browser |

## AI Discovery (7)

| Sub-pillar | Required data | Source | Scope | Status |
|---|---|---|---|---|
| `agents-md` | `/agents.md`, `/llms.txt` at the storefront root | **Crawl** | — | **Implemented** — `checks/ai-discovery/agents-md.ts` |
| `agentic-attrs` | Structured product attributes + rendered Product `offers` completeness | Admin + **Crawl** | `read_products`, `read_metaobjects` | **Implemented** — `checks/ai-discovery/agentic-attrs.ts` |
| `answerable-qa` | Description content that answers pre-purchase questions + FAQPage/Question JSON-LD as rendered | Admin (content) + **Crawl** (schema) | `read_products` | **Implemented** — `checks/ai-discovery/answerable-qa.ts` |
| `feed` | Product identifiers, availability, price completeness | Admin | `read_products` | **Implemented** — `checks/ai-discovery/feed.ts` |
| `indexing-freshness` | `robots.txt` parsed per named crawler, live fetch-as-bot responses, sitemap `<lastmod>` vs Shopify `updatedAt` | **Crawl** + Admin | — | **Implemented** — `checks/ai-discovery/indexing-freshness.ts` |
| `indexnow` | `/<key>.txt` at the storefront root, matched against the merchant's stored key | **Crawl** + **Merchant** | — | **Implemented** — `checks/ai-discovery/indexnow.ts`. Reports `unavailable`/`not configured` when the store has no key |
| `prompt-tracking` | Recorded assistant answers to the merchant's own questions | **Merchant** + **AI provider** | — | **Implemented** — `checks/ai-discovery/prompt-tracking.ts`. Reports `unavailable` with no provider, no questions, or too few real samples |

---

## Summary

Recalculated from `checkRegistry` in `index.ts`, which is the only source of truth. The table
above and these counts are derived from the same 36 rows and must always agree.

### Implementation

| | Count |
|---|---|
| Sub-pillars total | **36** |
| Registered in `checkRegistry` | **34** |
| Not implemented | **2** |

By pillar: SEO 8/8 · Content 6/6 · Speed 4/4 · CRO 9/11 · AI Discovery 7/7.

The 2 unimplemented rows are `cro/cart-recovery` and `cro/tracking` — both need `read_orders`,
which requires Shopify Protected Customer Data approval.

### Evidence source

| Source | Count |
|---|---|
| Admin only | **17** |
| Crawl only | **7** |
| Admin + Crawl (partially answerable from each) | **8** |
| Crawl + a merchant-supplied value | **1** |
| Merchant-supplied + an AI provider | **1** |
| Lab-dependent | **1** |
| Checkout config — not readable by any current permission | **1** |
| Requires a Shopify permission not currently requested | **2** |

The 7 Crawl-only rows are `schema`, `internal-links`, `clarity`, `wishlist`, `locator`,
`agents-md` and `sitemap`. The 8 Admin+Crawl rows are `image-alt-text`, `canonicals`, `trust`,
`app-bloat`, `theme-weight`, `answerable-qa`, `agentic-attrs` and `indexing-freshness` — each has
an Admin half that is implemented and a rendered half the crawler captures.

`indexnow` is Crawl + Merchant: the crawl can only request `/<key>.txt` once the merchant has told
Rankvora AI the key, because the IndexNow spec names the file after the key and a site root cannot be
enumerated. `prompt-tracking` depends on nothing in the store at all — it needs the merchant's own
questions and a configured model, and reports `unavailable` without either.

**So: 16 sub-pillars have a storefront-crawl dependency — 7 require crawling entirely, 8 are
partially answerable from Admin data, and 1 needs both a crawl and a merchant-supplied key.** They
are not all unavailable: `sitemap` was already answerable from HTTP probes, and every Admin half
listed above scores today.

### Registered but permanently or temporarily `not_measured`

Two registered checks return `unavailable` by design rather than a score, because the evidence
genuinely does not exist yet. They are registered so the UI can explain WHY rather than render an
empty state with no reason:

| Sub-pillar | Reason |
|---|---|
| `cro/mobile-ux` | Needs a rendering browser at a phone viewport |
| `cro/cod` | Checkout payment configuration is not inspectable; page copy is not proof |

`speed/cwv` reports `unavailable` until a PageSpeed measurement has been run for the store, and
says so in those words. That is a "nobody has measured this yet" state rather than a missing
capability — the measurement is one button on the Integrations page — and it stays `unavailable`
rather than scoring, because an unmeasured page is not a fast one.

`ai-discovery/indexnow` and `ai-discovery/prompt-tracking` report `unavailable` until the merchant
has supplied what they need — a key, and a set of questions plus a configured model. That is a
configuration state rather than a measurement gap, and both say which one is missing.

`seo/handles-redirects` reports `unavailable` only on stores whose connection predates the
`read_online_store_navigation` scope (the page offers Shopify's re-approval), or when Shopify errors
while listing redirects. `cro/returns` and `cro/subscription` also report `unavailable` on some stores — the first when
`read_legal_policies` has not been granted, the second when the store runs no subscription
programme at all. Both score normally otherwise.

### The rule these counts encode

An `unavailable` sub-pillar is EXCLUDED from every average (see `scoring.ts`), never counted as
zero. A store is never marked down for something Rankvora AI could not measure — only for something
it measured and found wanting. `implementedSubPillars` is derived from the registry, so this file
can go stale without the product lying to anyone.
