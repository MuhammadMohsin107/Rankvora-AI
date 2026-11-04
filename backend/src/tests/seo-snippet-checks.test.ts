import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { titleTagsCheck } from '../audit-engine/checks/seo/title-tags.js';
import { metaDescriptionsCheck } from '../audit-engine/checks/seo/meta-descriptions.js';
import { EVIDENCE_ROW_LIMIT } from '../audit-engine/checks/seo/page-inventory.js';
import type { SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';
import type { CrawledPage, StorefrontCrawl } from '../audit-engine/storefront/types.js';

/** AuditCheck.execute may return a promise; these checks are synchronous, so unwrap and assert
 * that, rather than threading `await` through assertions that read better without it. */
function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(check.id + ' unexpectedly returned a promise');
  return result;
}

// Unit tests for the two SEO snippet checks. Pure functions of a snapshot — no DB, no network,
// which is exactly what the AuditCheck contract is designed to allow.

function product(overrides: Partial<SnapshotProduct> & { id: string }): SnapshotProduct {
  return {
    title: 'Untitled',
    handle: overrides.id,
    url: `https://t.myshopify.com/products/${overrides.id}`,
    bodyHtml: '',
    productType: '',
    vendor: '',
    tags: [],
    status: 'ACTIVE',
    publishedAt: null,
    updatedAt: null,
    images: [],
    variantCount: 1,
    options: [],
    variants: [],
    variantsTruncated: false,
    sellingPlanGroupCount: 0,
    metafields: [],
    metafieldsAvailable: false,
    seoTitle: null,
    seoDescription: null,
    ...overrides,
  };
}

function snapshot(products: SnapshotProduct[], overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 't.myshopify.com', primaryUrl: 'https://t.myshopify.com', name: 'T', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products,
    collections: [],
    pages: [],
    articles: [],
    policies: [],
    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'error', detail: 'not fetched in tests' },
    crawl: null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: false },
    scope: { productLimit: 2000, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
    ...overrides,
  };
}

/** 30-60 chars, so it classifies as healthy. */
const GOOD_TITLE = 'Merino Wool Crew Neck Sweater in Navy';
const GOOD_DESCRIPTION =
  'Soft merino wool crew neck sweater in navy, with free next-day delivery and easy returns within 30 days.';

describe('seo.title-tags', () => {
  it('falls back to the resource title when no SEO override is set', () => {
    // A null seoTitle is NOT a missing title — the theme renders the product title.
    const result = run(titleTagsCheck, snapshot([product({ id: 'a', title: GOOD_TITLE })]));
    assert.equal(result.status, 'ok');
    assert.equal(result.analyzedCount, 1);
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('prefers the SEO override over the resource title', () => {
    const result = run(titleTagsCheck, 
      snapshot([product({ id: 'a', title: 'short', seoTitle: GOOD_TITLE })]),
    );
    assert.equal(result.healthyCount, 1);
    assert.equal(result.details.evidenceRows[0]?.cells.title, GOOD_TITLE);
  });

  it('flags an empty title as critical', () => {
    const result = run(titleTagsCheck, snapshot([product({ id: 'a', title: '   ' })]));
    assert.equal(result.healthyCount, 0);
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.equal(result.findings[0]?.details.issueType, 'Missing');
    // critical caps the sub-pillar score at 60 even though the ratio alone would be 0 here
    assert.equal(result.score, 0);
  });

  it('classifies length boundaries inclusively', () => {
    const exactly30 = 'a'.repeat(30);
    const exactly60 = 'b'.repeat(60);
    const result = run(titleTagsCheck, 
      snapshot([
        product({ id: 'min', title: exactly30 }),
        product({ id: 'max', title: exactly60 }),
        product({ id: 'under', title: 'c'.repeat(29) }),
        product({ id: 'over', title: 'd'.repeat(61) }),
      ]),
    );
    assert.equal(result.analyzedCount, 4);
    assert.equal(result.healthyCount, 2, '30 and 60 are both acceptable');
    const issues = result.findings.map((finding) => finding.details.issueType).sort();
    assert.deepEqual(issues, ['Too Long', 'Too Short']);
  });

  it('detects duplicates case- and whitespace-insensitively, and caps the score at 80', () => {
    const result = run(titleTagsCheck, 
      snapshot([
        product({ id: 'a', title: GOOD_TITLE }),
        product({ id: 'b', title: `  ${GOOD_TITLE.toUpperCase()}  ` }),
      ]),
    );
    assert.equal(result.healthyCount, 0, 'both sides of a duplicate pair are flagged');
    const duplicate = result.findings.find((finding) => finding.details.issueType === 'Duplicate');
    assert.equal(duplicate?.affectedCount, 2);
    assert.equal(duplicate?.severity, 'high');
    assert.equal(result.score, 0);
  });

  it('reports unavailable — never a zero — when nothing could be read', () => {
    const result = run(titleTagsCheck, 
      snapshot([], { coverage: { shop: true, products: false, collections: false, pages: false, articles: false, policies: false, metafields: false, theme: false, storefront: false, crawl: false } }),
    );
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /could not read/);
    assert.equal(result.findings.length, 0);
  });

  it('treats an empty but readable store as 100, not unavailable', () => {
    const result = run(titleTagsCheck, snapshot([]));
    assert.equal(result.status, 'unavailable', 'no pages at all is unmeasurable, not perfect');
  });

  it('caps persisted evidence rows while still analyzing every page', () => {
    const many = Array.from({ length: EVIDENCE_ROW_LIMIT + 25 }, (_, i) =>
      product({ id: `p${i}`, title: `${GOOD_TITLE} No.${i}` }),
    );
    const result = run(titleTagsCheck, snapshot(many));
    assert.equal(result.analyzedCount, EVIDENCE_ROW_LIMIT + 25);
    assert.equal(result.details.evidenceRows.length, EVIDENCE_ROW_LIMIT);
  });

  it('puts issue rows ahead of healthy ones in the capped sample', () => {
    const healthy = Array.from({ length: EVIDENCE_ROW_LIMIT }, (_, i) =>
      product({ id: `h${i}`, title: `${GOOD_TITLE} No.${i}` }),
    );
    const broken = product({ id: 'broken', title: '' });
    const result = run(titleTagsCheck, snapshot([...healthy, broken]));
    assert.ok(
      result.details.evidenceRows.some((row) => row.id === 'product:broken'),
      'the one broken page must survive truncation',
    );
  });
});

describe('seo.meta-descriptions', () => {
  it('scores a well-formed description as healthy', () => {
    const result = run(metaDescriptionsCheck, 
      snapshot([product({ id: 'a', seoDescription: GOOD_DESCRIPTION })]),
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
  });

  it('treats a null description as Missing — there is no observable fallback', () => {
    const result = run(metaDescriptionsCheck, snapshot([product({ id: 'a', title: GOOD_TITLE })]));
    assert.equal(result.healthyCount, 0);
    const missing = result.findings.find((finding) => finding.details.issueType === 'Missing');
    assert.equal(missing?.severity, 'high');
    // The honesty caveat must travel with the finding, not just live in a code comment.
    assert.ok(missing?.evidence.some((line) => /Admin API/.test(line)));
  });

  it('classifies length boundaries inclusively', () => {
    const result = run(metaDescriptionsCheck, 
      snapshot([
        product({ id: 'min', seoDescription: 'a'.repeat(70) }),
        product({ id: 'max', seoDescription: 'b'.repeat(160) }),
        product({ id: 'under', seoDescription: 'c'.repeat(69) }),
        product({ id: 'over', seoDescription: 'd'.repeat(161) }),
      ]),
    );
    assert.equal(result.healthyCount, 2);
    const issues = result.findings.map((finding) => finding.details.issueType).sort();
    assert.deepEqual(issues, ['Too Long', 'Too Short']);
  });

  it('averages length over described pages only', () => {
    const result = run(metaDescriptionsCheck, 
      snapshot([
        product({ id: 'a', seoDescription: 'x'.repeat(100) }),
        product({ id: 'b' }), // no description — must not drag the average toward zero
      ]),
    );
    assert.equal(result.details.contextValue, '100 chars');
  });

  it('shows an em dash rather than "0 chars" when nothing has a description', () => {
    const result = run(metaDescriptionsCheck, snapshot([product({ id: 'a' })]));
    assert.equal(result.details.contextValue, '—');
  });

  it('never lets a finding claim more affected pages than were analyzed', () => {
    const result = run(metaDescriptionsCheck, 
      snapshot(Array.from({ length: 10 }, (_, i) => product({ id: `p${i}` }))),
    );
    for (const finding of result.findings) {
      assert.ok(finding.affectedCount <= result.analyzedCount);
    }
  });
});

// ─── The theme's title suffix ────────────────────────────────────────
// Most Shopify themes render "<page title> – <shop name>", and those trailing characters count
// against the same truncation budget. These cover the measurement itself — that it is recovered
// from rendered pages, believed only on agreement, and never invented when there is no crawl.

/** A crawled page carrying only what deriveTitleSuffix reads. */
function crawled(resourceId: string, title: string | null): CrawledPage {
  return {
    url: `https://t.myshopify.com/products/${resourceId}`,
    finalUrl: `https://t.myshopify.com/products/${resourceId}`,
    pageType: 'product',
    resourceId,
    status: 200,
    redirectChain: [],
    responseTimeMs: 10,
    bytes: 100,
    title,
    metaDescription: null,
    canonical: null,
    canonicals: [],
    canonicalsOutsideHead: [],
    robots: null,
    noindex: false,
    headings: [],
    links: [],
    images: [],
    scripts: [],
    jsonLd: [],
    textLength: 0,
    text: '',
  };
}

function crawlOf(pages: CrawledPage[]): StorefrontCrawl {
  return {
    origin: 'https://t.myshopify.com',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    available: pages.length > 0,
    unavailableReason: null,
    passwordGated: false,
    pages,
    failures: [],
    robots: null,
    sitemap: null,
    sitemapUrls: [],
    sitemapEntries: [],
    sitemapRecords: [],
    indexNowKeyFile: null,
    botAccess: [],
    agentsMd: null,
    llmsTxt: null,
    linkStatuses: {},
    canonicalTargets: {},
    budget: { maxPages: 40, concurrency: 3, timeoutMs: 12000, pagesFetched: pages.length, truncated: false },
    warnings: [],
  };
}

const SUFFIX = ' - My Nutrition Store';

describe('seo.title-tags · theme title suffix', () => {
  /** Four products whose titles are comfortably healthy BEFORE the suffix is counted. */
  const products = Array.from({ length: 4 }, (_, i) =>
    product({ id: `p${i}`, title: `${GOOD_TITLE} No.${i}` }),
  );

  it('counts the suffix the theme actually rendered, so a page Google truncates is not called healthy', () => {
    // 42 chars in Shopify — comfortably healthy on its own. The theme adds 21 more, so the page
    // actually renders 63 and gets truncated, which is the whole point of measuring it.
    const withSuffix = products.map((item) => crawled(item.id, `${item.title}${SUFFIX}`));
    const result = run(titleTagsCheck, snapshot(products, { crawl: crawlOf(withSuffix) }));

    const row = result.details.evidenceRows.find((entry) => entry.id === 'product:p0');
    assert.ok(row, 'p0 must be in the evidence sample');
    // The length shown is the rendered one, not the Shopify field's.
    assert.equal(row.cells.length, `${GOOD_TITLE} No.0`.length + SUFFIX.length);
    assert.match(result.details.summary, /appends " - My Nutrition Store" \(21 characters\)/);
  });

  it('scores exactly as before when there is no crawl to measure from', () => {
    const withCrawl = run(titleTagsCheck, snapshot(products, { crawl: crawlOf(products.map((item) => crawled(item.id, `${item.title}${SUFFIX}`))) }));
    const withoutCrawl = run(titleTagsCheck, snapshot(products));

    assert.equal(withoutCrawl.details.titleSuffix, null);
    assert.notEqual(withCrawl.score, withoutCrawl.score, 'the suffix must actually change the verdict, or this test proves nothing');
    const row = withoutCrawl.details.evidenceRows.find((entry) => entry.id === 'product:p0');
    assert.equal(row?.cells.length, `${GOOD_TITLE} No.0`.length);
  });

  it('ignores a suffix only one or two pages happen to share', () => {
    // Two of four agree — below SUFFIX_MIN_OBSERVATIONS and not a majority. A coincidence in two
    // titles is not a theme template, and treating it as one would mis-score the whole store.
    const mixed = [
      crawled('p0', `${products[0].title}${SUFFIX}`),
      crawled('p1', `${products[1].title}${SUFFIX}`),
      crawled('p2', products[2].title),
      crawled('p3', products[3].title),
    ];
    const result = run(titleTagsCheck, snapshot(products, { crawl: crawlOf(mixed) }));
    assert.equal(result.details.titleSuffix, null);
  });

  it('never infers a suffix from Admin data alone — an empty crawl measures nothing', () => {
    const result = run(titleTagsCheck, snapshot(products, { crawl: crawlOf([]) }));
    assert.equal(result.details.titleSuffix, null);
  });
});
