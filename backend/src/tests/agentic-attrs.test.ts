// ─── AI Discovery · agentic commerce attributes (npm test) ───────────
// Covers what the check concludes from a store's products and rendered product pages: stock
// decided from EVERY variant, products and pages counted apart, and each rendered page's offer
// validated field by field with advice for what was actually wrong.
//
// Pure — no database, no Shopify. The products, variants and JSON-LD below are test inputs shaped
// exactly like the snapshot the Shopify provider builds; they describe hypothetical stores.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticAttrsCheck,
  assess,
  assessOffers,
  describeOfferProblem,
  offerAdvice,
} from '../audit-engine/checks/ai-discovery/agentic-attrs.js';
import { scoreSubPillar } from '../audit-engine/scoring.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';
import type { SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { CrawlJsonLd, CrawledPage, StorefrontCrawl } from '../audit-engine/storefront/types.js';

const ORIGIN = 'https://t.myshopify.com';

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(`${check.id} unexpectedly returned a promise`);
  return result;
}

function variants(count: number, available: (index: number) => boolean) {
  return Array.from({ length: count }, (_, index) => ({
    id: `v${index + 1}`, sku: `SKU-${index + 1}`, barcode: null, price: 20, availableForSale: available(index),
  }));
}

function product(overrides: Partial<SnapshotProduct> & { id: string }): SnapshotProduct {
  return {
    title: `Product ${overrides.id}`,
    handle: overrides.id,
    url: `${ORIGIN}/products/${overrides.id}`,
    bodyHtml: '<p>A relaxed-fit shirt made from organic cotton, cut generously through the shoulder, machine washable at thirty degrees and made from responsibly sourced yarn.</p>',
    productType: 'Shirts',
    vendor: 'Acme',
    tags: ['cotton'],
    status: 'active',
    publishedAt: '2025-12-01T00:00:00Z',
    updatedAt: null,
    images: [],
    variantCount: 1,
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: variants(1, () => true),
    variantsTruncated: false,
    sellingPlanGroupCount: 0,
    metafields: [],
    metafieldsAvailable: true,
    seoTitle: null,
    seoDescription: null,
    ...overrides,
  };
}

/** A product with `total` variants of which the first `read` were returned. */
function sizedProduct(id: string, total: number, read: number, available: (index: number) => boolean): SnapshotProduct {
  return product({
    id,
    variantCount: total,
    options: [{ name: 'Size', values: Array.from({ length: total }, (_, index) => `S${index + 1}`) }],
    variants: variants(read, available),
    variantsTruncated: total > read,
  });
}

function jsonLd(data: unknown): CrawlJsonLd {
  return { types: [], data, parseError: null };
}

function productPage(id: string, blocks: CrawlJsonLd[]): CrawledPage {
  return {
    url: `${ORIGIN}/products/${id}`,
    finalUrl: `${ORIGIN}/products/${id}`,
    pageType: 'product',
    resourceId: id,
    status: 200,
    redirectChain: [],
    responseTimeMs: 100,
    bytes: 1000,
    title: null,
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
    jsonLd: blocks,
    textLength: 500,
    text: '',
  };
}

function crawl(pages: CrawledPage[]): StorefrontCrawl {
  return {
    origin: ORIGIN,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    available: true,
    unavailableReason: null,
    passwordGated: false,
    pages,
    failures: [],
    robots: null,
    sitemap: null,
    sitemapUrls: [],
    sitemapEntries: [],
    sitemapRecords: [],
    agentsMd: null,
    llmsTxt: null,
    indexNowKeyFile: null,
    botAccess: [],
    linkStatuses: {},
    canonicalTargets: {},
    budget: { maxPages: 40, concurrency: 3, timeoutMs: 12_000, pagesFetched: pages.length, truncated: false },
    warnings: [],
  };
}

function snapshot(products: SnapshotProduct[], pages: CrawledPage[] | null = null): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 't.myshopify.com', primaryUrl: ORIGIN, name: 'T', email: null, currency: 'PKR', country: 'PK', timezone: null, planName: null },
    products,
    collections: [],
    pages: [],
    articles: [],
    policies: [],
    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'scope', detail: 'not granted' },
    crawl: pages ? crawl(pages) : null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: true, theme: false, storefront: false, crawl: pages !== null },
    scope: { productLimit: 250, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  };
}

const completeOffer = { '@type': 'Offer', price: '1500.00', priceCurrency: 'PKR', availability: 'https://schema.org/InStock' };
const offerPage = (id: string, offer: unknown) => productPage(id, [jsonLd({ '@type': 'Product', name: id, offers: offer })]);

// ─── 1. Stock from every variant ─────────────────────────────────────

describe('stock is decided from every variant', () => {
  /** THE REPORTED CASE: 40 variants, the first 25 sold out, variant 30 in stock. */
  it('does not call a product unpurchasable when only its first 25 variants were read', () => {
    const verdict = assess(sizedProduct('p1', 40, 25, () => false));
    assert.notEqual(verdict.issue, 'Nothing purchasable');
    assert.equal(verdict.measured, false, 'the answer is in variants that were not read');
    assert.equal(verdict.issue, 'Availability not measured');
    assert.match(verdict.detail, /None of the first 25 of 40 variants is for sale, and the rest could not be read/);
  });

  it('finds the product purchasable once every variant has been read', () => {
    const verdict = assess(sizedProduct('p1', 40, 40, (index) => index === 29));
    assert.equal(verdict.status, 'Healthy');
    assert.match(verdict.detail, /^1 of 40 variants purchasable/);
  });

  it('calls a product unpurchasable only when every variant was read and none is for sale', () => {
    const verdict = assess(sizedProduct('p1', 40, 40, () => false));
    assert.equal(verdict.status, 'Critical');
    assert.equal(verdict.detail, 'All 40 variants are unavailable for sale');
  });

  it('settles "purchasable" from the sample when one variant in it is for sale, and says it was a sample', () => {
    const verdict = assess(sizedProduct('p1', 40, 25, (index) => index === 3));
    assert.equal(verdict.status, 'Healthy');
    assert.match(verdict.detail, /^1 purchasable among the first 25 of 40 variants read/);
  });

  it('still reports a failure the product definitely has, even when its stock is unknown', () => {
    const verdict = assess({ ...sizedProduct('p1', 40, 25, () => false), bodyHtml: '' });
    assert.equal(verdict.measured, true);
    assert.equal(verdict.issue, 'No description');
  });

  it('treats a product whose variants could not be read at all as not measured, not healthy', () => {
    const verdict = assess(product({ id: 'p1', variantCount: 3, options: [{ name: 'Size', values: ['S', 'M', 'L'] }], variants: [], variantsTruncated: true }));
    assert.equal(verdict.measured, false);
    assert.match(verdict.detail, /None of its 3 variants could be read/);
  });

  it('leaves a not-measured product out of every count and the score, and names it', () => {
    const result = run(agenticAttrsCheck, snapshot([product({ id: 'ok' }), sizedProduct('unknown', 40, 25, () => false)]));
    assert.equal(result.analyzedCount, 1, 'only the product with a verdict is counted');
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100, 'an unread product must not cost the store a point');
    const notMeasured = result.findings.find((finding) => finding.title === 'Products whose availability could not be fully read');
    assert.equal(notMeasured?.affectedCount, 1);
    assert.equal(notMeasured?.scoreLift, 0);
    assert.equal(notMeasured?.severity, 'low');
    assert.match(result.details.summary, /1 more product was not fully measured/);
    assert.equal(result.details.contextValue, '100%', 'Products with stock is taken over the products whose stock is known');
  });

  it('reports the check as not measured when no product and no page reached a verdict', () => {
    const result = run(agenticAttrsCheck, snapshot([sizedProduct('a', 40, 25, () => false), sizedProduct('b', 30, 25, () => false)]));
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /could not fully read the variants of any of this store’s 2 published products/);
  });
});

// ─── 2–4. Products and pages, counted apart ──────────────────────────

describe('products and pages are counted apart', () => {
  // 10 products: 7 healthy, 2 with no description, 1 sold out. 20 crawled pages, 5 incomplete.
  const products = [
    ...Array.from({ length: 7 }, (_, index) => product({ id: `ok${index}` })),
    product({ id: 'empty1', bodyHtml: '' }),
    product({ id: 'empty2', bodyHtml: '' }),
    product({ id: 'soldout', variants: variants(1, () => false) }),
  ];
  const pages = Array.from({ length: 20 }, (_, index) =>
    offerPage(`page${index}`, index < 5 ? { '@type': 'Offer', price: '10', priceCurrency: 'PKR' } : completeOffer));
  const result = run(agenticAttrsCheck, snapshot(products, pages));

  it('counts products as products — the rendered test is not an extra one', () => {
    assert.equal(result.analyzedCount, 10, 'was 11: the rendered-offer signal counted as a product');
    assert.equal(result.healthyCount, 7);
  });

  it('takes "% healthy" and "Products with stock" over products only', () => {
    assert.equal(result.details.healthChip, '70% healthy');
    assert.equal(result.details.contextValue, '90%');
  });

  it('counts issues in products, and reports pages separately', () => {
    assert.equal(result.details.issueCount, 3, 'was 3 products + 5 pages = 8');
    assert.deepEqual(result.details.issueUnits, [
      { unit: 'product', flagged: 3, of: 10 },
      { unit: 'page', flagged: 5, of: 20 },
    ]);
  });

  it('gives each finding the population its count is out of', () => {
    const pagesFinding = result.findings.find((finding) => finding.affectedLabel === 'pages');
    assert.equal(pagesFinding?.affectedCount, 5);
    assert.equal(pagesFinding?.details.population, 20);
    const thin = result.findings.find((finding) => /too little description/.test(finding.title));
    assert.equal(thin?.details.population, 10);
  });

  it('keeps the scoring method: the rendered half is one unit beside the products', () => {
    assert.equal(result.score, scoreSubPillar(10 + 1, 7 + 0, result.findings));
  });

  it('labels every evidence row with what it is', () => {
    const units = new Set(result.details.evidenceRows.map((row) => row.unit));
    assert.deepEqual([...units].sort(), ['page', 'product']);
  });
});

// ─── 5. The offer, field by field ────────────────────────────────────

describe('the rendered offer is validated field by field', () => {
  const problems = (offer: unknown) => assessOffers([jsonLd({ '@type': 'Product', offers: offer })]).problems.map((problem) => problem.code);

  it('passes an offer with a valid price, priceCurrency and availability', () => {
    const outcome = assessOffers([jsonLd({ '@type': 'Product', offers: completeOffer })]);
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.found, { price: '1500.00', currency: 'PKR', availability: 'https://schema.org/InStock' });
  });

  it('fails an offer with no priceCurrency — the case that used to pass', () => {
    assert.deepEqual(problems({ '@type': 'Offer', price: '10', availability: 'https://schema.org/InStock' }), ['currency-missing']);
  });

  it('checks the values, not only that they are present', () => {
    assert.deepEqual(problems({ '@type': 'Offer', price: 'Rs. 1,299', priceCurrency: 'PKR', availability: 'InStock' }), ['price-invalid']);
    assert.deepEqual(problems({ '@type': 'Offer', price: '10', priceCurrency: 'Rs.', availability: 'InStock' }), ['currency-invalid']);
    assert.deepEqual(problems({ '@type': 'Offer', price: '10', priceCurrency: 'PKR', availability: 'yes' }), ['availability-invalid']);
  });

  it('accepts every documented spelling of a schema.org availability value', () => {
    for (const availability of ['https://schema.org/InStock', 'http://schema.org/OutOfStock', 'schema:PreOrder', 'BackOrder']) {
      assert.deepEqual(problems({ '@type': 'Offer', price: '10', priceCurrency: 'PKR', availability }), [], availability);
    }
  });

  it('reads a price and currency from priceSpecification', () => {
    assert.deepEqual(problems({
      '@type': 'Offer',
      availability: 'https://schema.org/InStock',
      priceSpecification: { '@type': 'UnitPriceSpecification', price: 1500, priceCurrency: 'PKR' },
    }), []);
  });

  it('finds a complete offer nested inside an AggregateOffer', () => {
    assert.deepEqual(problems({
      '@type': 'AggregateOffer', lowPrice: '10', priceCurrency: 'PKR',
      offers: [{ '@type': 'Offer', price: '10', priceCurrency: 'PKR', availability: 'https://schema.org/InStock' }],
    }), []);
  });

  it('does not assemble one complete offer out of fields scattered across two', () => {
    const outcome = assessOffers([jsonLd({
      '@type': 'Product',
      offers: [
        { '@type': 'Offer', price: '10', priceCurrency: 'PKR' },
        { '@type': 'Offer', availability: 'https://schema.org/InStock' },
      ],
    })]);
    assert.equal(outcome.complete, false);
  });

  it('says when there is no product data at all', () => {
    assert.deepEqual(assessOffers([]).problems.map((problem) => problem.code), ['no-product']);
    assert.deepEqual(assessOffers([jsonLd({ '@type': 'Product', name: 'x' })]).problems.map((problem) => problem.code), ['no-offer']);
  });
});

// ─── 6. Each page's own problem, and advice that matches it ──────────

describe('each rendered page reports its own problem', () => {
  const pages = [
    productPage('noschema', []),
    offerPage('nocurrency', { '@type': 'Offer', price: '10', availability: 'https://schema.org/InStock' }),
    offerPage('noavail', { '@type': 'Offer', price: '10', priceCurrency: 'PKR' }),
    offerPage('noavail2', { '@type': 'Offer', price: '10', priceCurrency: 'PKR' }),
    offerPage('fine', completeOffer),
  ];
  const result = run(agenticAttrsCheck, snapshot([product({ id: 'fine' })], pages));
  const pageRow = (id: string) => result.details.evidenceRows.find((row) => row.id === `page:${ORIGIN}/products/${id}`);

  it('gives every crawled page a row carrying the problem found on it', () => {
    assert.equal(pageRow('noschema')?.cells.detail, 'No Product structured data on the page');
    assert.equal(pageRow('nocurrency')?.cells.detail, 'Offer has no priceCurrency');
    assert.equal(pageRow('noavail')?.cells.detail, 'Offer has no availability');
    assert.equal(pageRow('fine')?.cells.detail, 'Complete offer');
    assert.equal(pageRow('fine')?.status, 'Healthy');
  });

  it('shows the values it read when an offer is complete', () => {
    assert.equal(pageRow('fine')?.current?.value, 'price 1500.00 PKR · https://schema.org/InStock');
  });

  it('advises on the problem that page actually has', () => {
    assert.match(String(pageRow('noschema')?.cells.recommendation), /Add Product JSON-LD with an offers node/);
    assert.match(String(pageRow('nocurrency')?.cells.recommendation), /priceCurrency/);
    assert.doesNotMatch(String(pageRow('nocurrency')?.cells.recommendation), /availability/);
    assert.match(String(pageRow('noavail')?.cells.recommendation), /schema\.org\/InStock/);
  });

  it('names the store’s own currency, read from Shopify, in the currency advice', () => {
    assert.match(offerAdvice({ code: 'currency-missing' }, 'PKR'), /for this store, PKR/);
    assert.doesNotMatch(offerAdvice({ code: 'currency-missing' }, null), /for this store/);
  });

  it('counts each kind of problem in the finding, and advises on each', () => {
    const finding = result.findings.find((entry) => entry.title === 'Rendered product pages without a complete offer');
    assert.equal(finding?.affectedCount, 4);
    assert.match(finding?.problem ?? '', /4 of 5 crawled product pages/);
    assert.match(finding?.problem ?? '', /2 have no availability/);
    assert.match(finding?.problem ?? '', /1 has no priceCurrency/);
    assert.match(finding?.problem ?? '', /1 has no Product structured data/);
    assert.match(finding?.recommendation ?? '', /^2 pages: Add availability/);
    assert.match(finding?.recommendation ?? '', /1 page: Add priceCurrency/);
  });

  it('words an invalid value with the value found', () => {
    assert.equal(describeOfferProblem({ code: 'currency-invalid', value: 'Rs.' }), 'Offer priceCurrency “Rs.” is not a three-letter currency code');
  });
});

// ─── 7. Severity, rows and counters agree ────────────────────────────

describe('severity, row status and counters agree', () => {
  it('rates unselectable variants high, marks their rows Needs Work, and keeps them out of Critical', () => {
    const result = run(agenticAttrsCheck, snapshot([product({ id: 'p1', variantCount: 3, variants: variants(3, () => true) })]));
    const finding = result.findings.find((entry) => /no attribute to select on/.test(entry.title));
    assert.equal(finding?.severity, 'high');
    assert.equal(finding?.details.issueType, 'Needs Work', 'was Critical, so the Critical counter counted a high');
    assert.ok(finding?.evidenceRows?.every((row) => row.status === 'Needs Work'));
  });

  it('keeps Critical for the one issue rated critical', () => {
    const result = run(agenticAttrsCheck, snapshot([product({ id: 'p1', variants: variants(2, () => false), variantCount: 2, options: [{ name: 'Size', values: ['S', 'M'] }] })]));
    const finding = result.findings.find((entry) => entry.title === 'Products with no purchasable variant');
    assert.equal(finding?.severity, 'critical');
    assert.equal(finding?.details.issueType, 'Critical');
  });
});

// ─── 8. No typed-in ratings ──────────────────────────────────────────

describe('findings carry no hand-typed ratings', () => {
  it('has no impact and no effort on any finding', () => {
    const result = run(agenticAttrsCheck, snapshot(
      [product({ id: 'a', bodyHtml: '' }), product({ id: 'b', variants: variants(1, () => false) })],
      [productPage('a', [])],
    ));
    assert.ok(result.findings.length > 0);
    for (const finding of result.findings) {
      assert.ok(!('impact' in finding), `${finding.title} carries impact`);
      assert.ok(!('effort' in finding.details), `${finding.title} carries effort`);
    }
  });
});
