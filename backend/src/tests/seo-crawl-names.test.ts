import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { schemaCheck } from '../audit-engine/checks/seo/schema.js';
import { internalLinksCheck } from '../audit-engine/checks/seo/internal-links.js';
import type { SnapshotCollection, SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';
import type { CrawledPage, StorefrontCrawl } from '../audit-engine/storefront/types.js';

// The crawl-based SEO tables name each row by the resource's own Shopify title, not its path.
// These pin where that name comes from: the Admin snapshot, joined on the id the crawl carried —
// never the rendered <title>, which is the theme's output with the shop name appended.

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(check.id + ' unexpectedly returned a promise');
  return result;
}

function product(id: string, title: string): SnapshotProduct {
  return {
    id,
    title,
    handle: id,
    url: `https://t.myshopify.com/products/${id}`,
    bodyHtml: '',
    productType: '',
    vendor: '',
    tags: [],
    status: 'active',
    publishedAt: '2026-01-01T00:00:00Z',
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
  };
}

function collection(id: string, title: string): SnapshotCollection {
  return { id, title, handle: id, url: `https://t.myshopify.com/collections/${id}`, bodyHtml: '', productCount: null, updatedAt: null, image: null, seoTitle: null, seoDescription: null };
}

function crawled(pageType: CrawledPage['pageType'], resourceId: string | null, path: string): CrawledPage {
  return {
    url: `https://t.myshopify.com${path}`,
    finalUrl: `https://t.myshopify.com${path}`,
    pageType,
    resourceId,
    status: 200,
    redirectChain: [],
    responseTimeMs: 10,
    bytes: 100,
    // Deliberately NOT the Admin title: the name must never be read from here.
    title: 'Rendered title – My Nutrition Store',
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

function snapshot(pages: CrawledPage[]): StoreSnapshot {
  const crawl: StorefrontCrawl = {
    origin: 'https://t.myshopify.com',
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
    indexNowKeyFile: null,
    botAccess: [],
    agentsMd: null,
    llmsTxt: null,
    linkStatuses: {},
    canonicalTargets: {},
    budget: { maxPages: 40, concurrency: 3, timeoutMs: 12000, pagesFetched: pages.length, truncated: false },
    warnings: [],
  };
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 't.myshopify.com', primaryUrl: 'https://t.myshopify.com', name: 'T', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products: [product('101', 'GlowUp Collagen Biotin & Vitamin C')],
    collections: [collection('201', 'Hair Care')],
    pages: [],
    articles: [],
    policies: [],
    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'error', detail: 'not fetched in tests' },
    crawl,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: true },
    scope: { productLimit: 2000, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  };
}

const pages = [
  crawled('home', null, '/'),
  crawled('product', '101', '/products/glowup-collagen'),
  crawled('collection', '201', '/collections/hair-care'),
  // A page whose id matches nothing in the snapshot: it gets no name rather than an invented one.
  crawled('product', '999', '/products/gone'),
];

for (const check of [schemaCheck, internalLinksCheck]) {
  describe(`${check.id} · row names`, () => {
    it('names each row by the Shopify title of the resource the page was built from', () => {
      const rows = run(check, snapshot(pages)).details.evidenceRows;
      const nameOf = (path: string) => rows.find((row) => row.cells.url === path)?.cells.name;

      assert.equal(nameOf('Homepage'), 'Homepage');
      assert.equal(nameOf('/products/glowup-collagen'), 'GlowUp Collagen Biotin & Vitamin C');
      assert.equal(nameOf('/collections/hair-care'), 'Hair Care');
    });

    it('leaves the name empty when the page maps to no resource, so the UI shows the path', () => {
      const rows = run(check, snapshot(pages)).details.evidenceRows;
      const orphan = rows.find((row) => row.cells.url === '/products/gone');
      assert.ok(orphan, 'the unmatched page must still be a row');
      assert.equal(orphan.cells.name, null);
    });
  });
}
