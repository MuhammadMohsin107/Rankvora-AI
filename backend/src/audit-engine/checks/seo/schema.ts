import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawledPage } from '../../storefront/types.js';
import { crawlScopeNote, pageLabel, pageName, requireCrawl } from '../shared/crawl.js';
import { formatCount, takeEvidenceSample } from './page-inventory.js';

/**
 * ─── SEO · Structured data (JSON-LD) ─────────────────────────────────
 * Reads the `<script type="application/ld+json">` blocks the theme ACTUALLY renders.
 *
 * This check cannot be done any other way. Structured data is emitted by Liquid at render time —
 * it is not a field in the Admin API, and no combination of Admin data proves what a theme put on
 * the page. A store with immaculate product records can render no Product schema at all, and a
 * store with sparse records can render perfect schema from a app. Only the rendered HTML knows.
 *
 * WHAT EACH PAGE TYPE IS EXPECTED TO CARRY
 * Judged against what the page IS, because a homepage has no product to describe and marking it
 * down for a missing Product schema would be measuring the wrong thing:
 *   home        Organization or WebSite — the entity behind the store
 *   product     Product, and an Offer inside it (price/availability is what wins rich results)
 *   collection  a listing type (CollectionPage / ItemList) or BreadcrumbList
 *   article     Article / BlogPosting
 *   page        nothing specific is required
 *
 * A BLOCK THAT DOES NOT PARSE IS A REPORTED DEFECT, not a missing block. Invalid JSON-LD is worse
 * than none: it looks present to a merchant checking their theme, and is discarded by every
 * consumer that reads it. So it is called out separately and weighted higher.
 */

const HEALTHY = 'Healthy';
const NEEDS_WORK = 'Needs Work';
const CRITICAL = 'Critical';

/** Schema types that satisfy each page type. Matching is case-insensitive. */
const EXPECTED: Record<CrawledPage['pageType'], { types: string[]; label: string } | null> = {
  home: { types: ['organization', 'website', 'localbusiness', 'store'], label: 'Organization or WebSite' },
  product: { types: ['product'], label: 'Product' },
  collection: { types: ['collectionpage', 'itemlist', 'breadcrumblist'], label: 'CollectionPage or ItemList' },
  article: { types: ['article', 'blogposting', 'newsarticle'], label: 'Article' },
  page: null,
  other: null,
};

function hasType(page: CrawledPage, wanted: string[]): boolean {
  const present = new Set(page.jsonLd.flatMap((block) => block.types.map((type) => type.toLowerCase())));
  return wanted.some((type) => present.has(type));
}

/** True when a Product block carries an offers node — the part that produces a price in results. */
function hasOffer(page: CrawledPage): boolean {
  const walk = (value: unknown, depth = 0): boolean => {
    if (depth > 8 || value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((entry) => walk(entry, depth + 1));
    const record = value as Record<string, unknown>;
    if (record.offers !== undefined) return true;
    const type = record['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((entry) => typeof entry === 'string' && entry.toLowerCase() === 'offer')) return true;
    return Object.values(record).some((entry) => walk(entry, depth + 1));
  };
  return page.jsonLd.some((block) => walk(block.data));
}

export const schemaCheck: AuditCheck = {
  id: 'seo.schema',
  pillar: 'seo',
  subPillar: 'schema',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const guard = requireCrawl(snapshot, 'schema', 'the structured data your theme renders');
    if (!guard.ok) return guard.result;
    const { crawl, pages } = guard.evidence;

    const rows: SubPillarEvidenceRow[] = [];
    const missing: CrawledPage[] = [];
    const broken: CrawledPage[] = [];
    const noSchemaAtAll: CrawledPage[] = [];
    const productsWithoutOffer: CrawledPage[] = [];
    let healthy = 0;

    for (const page of pages) {
      const expectation = EXPECTED[page.pageType];
      const parseErrors = page.jsonLd.filter((block) => block.parseError !== null);
      const allTypes = [...new Set(page.jsonLd.flatMap((block) => block.types))];

      let status = HEALTHY;
      let recommendation = '—';

      if (parseErrors.length > 0) {
        status = CRITICAL;
        recommendation = 'Fix the malformed structured data block — search engines discard the whole block, so it is doing nothing at all.';
        broken.push(page);
      } else if (page.jsonLd.length === 0) {
        status = expectation ? CRITICAL : NEEDS_WORK;
        recommendation = 'Add JSON-LD structured data to this template so search engines can read what the page is about.';
        noSchemaAtAll.push(page);
      } else if (expectation && !hasType(page, expectation.types)) {
        status = NEEDS_WORK;
        recommendation = `Add ${expectation.label} structured data to this template.`;
        missing.push(page);
      } else if (page.pageType === 'product' && !hasOffer(page)) {
        status = NEEDS_WORK;
        recommendation = 'Include an offers node with price and availability — that is what produces the price in a search result.';
        productsWithoutOffer.push(page);
      } else {
        healthy += 1;
      }

      rows.push({
        id: `page:${page.pageType}:${page.resourceId ?? 'home'}`,
        status,
        facet: status,
        cells: {
          // What identifies the row in the table: the resource's name as it is in Shopify. `url`
          // stays for search and as the fallback when the page maps to no snapshot resource.
          name: pageName(snapshot, page),
          url: pageLabel(page),
          pageType: page.pageType,
          schemaTypes: allTypes.join(', ') || 'none',
          blocks: page.jsonLd.length,
          status,
          recommendation,
        },
        current: {
          label: 'Rendered structured data',
          value: allTypes.join(', ') || 'None found on the page',
          meta: `${page.jsonLd.length} JSON-LD block(s)${parseErrors.length ? ` · ${parseErrors.length} invalid` : ''}`,
        },
        suggested: { label: 'Recommendation', value: recommendation },
      });
    }

    const analyzed = pages.length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);

    if (broken.length > 0) {
      findings.push({
        title: 'Pages rendering invalid JSON-LD',
        severity: 'critical',
        affectedCount: broken.length,
        affectedLabel: 'pages',
        scoreLift: lift(broken.length),
        resolutionType: 'theme',
        problem: `${formatCount(broken.length)} of the ${formatCount(analyzed)} pages loaded contain structured data that does not parse.`,
        why: 'A malformed block is discarded entirely, so the page gets none of the benefit while looking correctly marked up to anyone inspecting the theme. It is the most expensive kind of schema problem because nobody notices it.',
        recommendation: 'Validate the theme\'s JSON-LD output. An unescaped quote or newline in a product title is the usual cause.',
        evidence: broken.slice(0, 5).map((page) => `${pageLabel(page)}: ${page.jsonLd.find((block) => block.parseError)?.parseError ?? 'invalid JSON'}`),
        evidenceRows: rows.filter((row) => row.cells.status === CRITICAL).slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    if (noSchemaAtAll.length > 0) {
      findings.push({
        title: 'Pages rendering no structured data at all',
        severity: 'high',
        affectedCount: noSchemaAtAll.length,
        affectedLabel: 'pages',
        scoreLift: lift(noSchemaAtAll.length),
        resolutionType: 'theme',
        problem: `${formatCount(noSchemaAtAll.length)} of the ${formatCount(analyzed)} pages loaded emit no JSON-LD.`,
        why: 'Without structured data a search engine has to infer what the page is from its prose. That rules the page out of rich results — star ratings, prices, availability — and out of the feeds AI shopping assistants read.',
        recommendation: 'Add JSON-LD to the affected templates. Most modern Shopify themes include it; if yours does not, a schema app can add it without a theme edit.',
        evidence: [
          `${formatCount(noSchemaAtAll.length)} of ${formatCount(analyzed)} crawled pages have no JSON-LD.`,
          ...noSchemaAtAll.slice(0, 5).map((page) => `${pageLabel(page)} (${page.pageType}): no structured data.`),
        ],
        details: { issueType: CRITICAL },
      });
    }

    if (missing.length > 0) {
      findings.push({
        title: 'Pages missing the schema type their template needs',
        severity: 'medium',
        affectedCount: missing.length,
        affectedLabel: 'pages',
        scoreLift: lift(missing.length),
        resolutionType: 'theme',
        problem: `${formatCount(missing.length)} pages render structured data, but not the type expected for that page type.`,
        why: 'Schema is matched to page type. A product page carrying only Organization markup tells a search engine who you are but nothing about the thing for sale.',
        recommendation: 'Add the expected type to each template — Product on product pages, Article on blog posts, CollectionPage on collections.',
        evidence: missing.slice(0, 5).map((page) => `${pageLabel(page)} (${page.pageType}): expected ${EXPECTED[page.pageType]?.label}, found ${page.jsonLd.flatMap((block) => block.types).join(', ') || 'none'}.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (productsWithoutOffer.length > 0) {
      findings.push({
        title: 'Product schema with no Offer node',
        severity: 'medium',
        affectedCount: productsWithoutOffer.length,
        affectedLabel: 'pages',
        scoreLift: lift(productsWithoutOffer.length),
        resolutionType: 'theme',
        problem: `${formatCount(productsWithoutOffer.length)} product pages render Product schema without an offers node.`,
        why: 'The offer carries price, currency and availability. Without it the listing is eligible for far fewer rich results, and an AI shopping agent reading the page cannot tell what the product costs or whether it is in stock.',
        recommendation: 'Extend the Product schema with an offers node containing price, priceCurrency and availability.',
        evidence: productsWithoutOffer.slice(0, 5).map((page) => `${pageLabel(page)}: Product schema present, no offers node.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    const typesFound = [...new Set(pages.flatMap((page) => page.jsonLd.flatMap((block) => block.types)))];

    return {
      subPillar: 'schema',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} pages render the structured data their template needs. ${crawlScopeNote(crawl)}`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Schema types found',
        contextValue: typesFound.length > 0 ? typesFound.slice(0, 4).join(', ') : 'None',
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
