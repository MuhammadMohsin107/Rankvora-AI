import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalsCheck } from '../audit-engine/checks/seo/canonicals.js';
import { extractCanonicals } from '../audit-engine/storefront/html-parser.js';
import type { SnapshotArticle, SnapshotCollection, SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { SubPillarResult } from '../audit-engine/types.js';
import type { CanonicalTargetStatus, CrawledPage, StorefrontCrawl } from '../audit-engine/storefront/types.js';

const ORIGIN = 'https://shop.example';

function run(snapshot: StoreSnapshot): SubPillarResult {
  const result = canonicalsCheck.execute(snapshot);
  if (result instanceof Promise) throw new Error('canonicals unexpectedly returned a promise');
  return result;
}

function product(id: string, handle: string, title: string, extra: Partial<SnapshotProduct> = {}): SnapshotProduct {
  return {
    id, title, handle,
    url: `${ORIGIN}/products/${handle}`,
    bodyHtml: '', productType: '', vendor: '', tags: [],
    status: 'active', publishedAt: '2026-01-01T00:00:00Z', updatedAt: null,
    images: [], variantCount: 1, options: [], variants: [], variantsTruncated: false,
    sellingPlanGroupCount: 0, metafields: [], metafieldsAvailable: false, seoTitle: null, seoDescription: null,
    ...extra,
  };
}

function collection(id: string, handle: string, title: string): SnapshotCollection {
  return { id, title, handle, url: `${ORIGIN}/collections/${handle}`, bodyHtml: '', productCount: null, updatedAt: null, image: null, seoTitle: null, seoDescription: null };
}

function article(id: string, blogHandle: string, handle: string, title: string): SnapshotArticle {
  return {
    id, blogId: blogHandle, blogHandle, title, handle,
    url: `${ORIGIN}/blogs/${blogHandle}/${handle}`,
    bodyHtml: '', publishedAt: '2026-01-01T00:00:00Z', updatedAt: null, image: null, seoTitle: null, seoDescription: null,
  };
}

function page(pageType: CrawledPage['pageType'], resourceId: string | null, path: string, canonicals: string[], outside: string[] = []): CrawledPage {
  return {
    url: `${ORIGIN}${path}`, finalUrl: `${ORIGIN}${path}`, pageType, resourceId,
    status: 200, redirectChain: [], responseTimeMs: 10, bytes: 100,
    title: null, metaDescription: null,
    canonical: canonicals[0] ?? null, canonicals, canonicalsOutsideHead: outside,
    robots: null, noindex: false, headings: [], links: [], images: [], scripts: [], jsonLd: [], textLength: 0, text: '',
  };
}

function snapshot(options: {
  products?: SnapshotProduct[];
  collections?: SnapshotCollection[];
  articles?: SnapshotArticle[];
  pages?: CrawledPage[] | null;
  targets?: Record<string, CanonicalTargetStatus>;
}): StoreSnapshot {
  const pages = options.pages ?? null;
  const crawl: StorefrontCrawl | null = pages === null ? null : {
    origin: ORIGIN, startedAt: new Date('2026-01-01T00:00:00Z'),
    available: pages.length > 0, unavailableReason: pages.length > 0 ? null : 'unreachable', passwordGated: false,
    pages, failures: [], robots: null, sitemap: null, sitemapUrls: [], sitemapEntries: [], sitemapRecords: [],
    agentsMd: null, llmsTxt: null, indexNowKeyFile: null, botAccess: [],
    linkStatuses: {}, canonicalTargets: options.targets ?? {},
    budget: { maxPages: 40, concurrency: 3, timeoutMs: 12000, pagesFetched: pages.length, truncated: false },
    warnings: [],
  };
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 'shop.example', primaryUrl: ORIGIN, name: 'Shop', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products: options.products ?? [],
    collections: options.collections ?? [],
    pages: [],
    articles: options.articles ?? [],
    policies: [],
    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'error', detail: 'not fetched in tests' },
    crawl,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: crawl?.available ?? false },
    scope: { productLimit: 2000, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  };
}

const statusOf = (result: SubPillarResult, id: string) => result.details.evidenceRows.find((row) => row.id === id)?.status;

describe('extractCanonicals', () => {
  it('separates <head> canonicals from ones after </head>, and ignores commented-out tags', () => {
    const html = `<html><head><!-- <link rel="canonical" href="/old"> --><link rel="canonical" href="/a"><link href="/b" rel="Canonical nofollow"></head><body><link rel="canonical" href="/c"></body></html>`;
    assert.deepEqual(extractCanonicals(html), { head: ['/a', '/b'], outsideHead: ['/c'] });
  });

  it('records a canonical tag with no href as empty rather than dropping it', () => {
    assert.deepEqual(extractCanonicals('<head><link rel="canonical"></head>'), { head: [''], outsideHead: [] });
  });

  it('treats the whole document as head when </head> never appears', () => {
    assert.deepEqual(extractCanonicals('<link rel="canonical" href="/x"><p>body</p>'), { head: ['/x'], outsideHead: [] });
  });
});

describe('seo.canonicals · rendered canonical tags', () => {
  it('passes a page whose canonical points at itself, ignoring trailing slash and case', () => {
    const result = run(snapshot({
      products: [product('1', 'shirt', 'Shirt')],
      pages: [page('product', '1', '/products/shirt', [`${ORIGIN}/Products/shirt/`])],
    }));
    assert.equal(statusOf(result, 'product:1'), 'Healthy');
    assert.equal(result.findings.length, 0);
  });

  it('flags a page with no canonical, and says so when the only one is outside <head>', () => {
    const result = run(snapshot({
      products: [product('1', 'a', 'A'), product('2', 'b', 'B')],
      pages: [page('product', '1', '/products/a', []), page('product', '2', '/products/b', [], ['/products/b'])],
    }));
    assert.equal(statusOf(result, 'product:1'), 'Missing Canonical');
    assert.equal(statusOf(result, 'product:2'), 'Missing Canonical');
    const row = result.details.evidenceRows.find((entry) => entry.id === 'product:2');
    assert.match(row?.current?.meta ?? '', /after <\/head>/);
    assert.equal(result.findings[0]?.affectedCount, 2);
  });

  it('flags conflicting canonicals as conflicting, and identical repeats as low severity', () => {
    const result = run(snapshot({
      products: [product('1', 'a', 'A'), product('2', 'b', 'B')],
      pages: [
        page('product', '1', '/products/a', ['/products/a', '/collections/all']),
        page('product', '2', '/products/b', ['/products/b', `${ORIGIN}/products/b`]),
      ],
    }));
    assert.equal(statusOf(result, 'product:1'), 'Conflicting Canonicals');
    assert.equal(statusOf(result, 'product:2'), 'Repeated Canonical Tag');
    assert.equal(result.findings.find((finding) => finding.details.issueType === 'Repeated Canonical Tag')?.severity, 'low');
  });

  it('flags an empty href and a canonical on another host or protocol', () => {
    const result = run(snapshot({
      products: [product('1', 'a', 'A'), product('2', 'b', 'B'), product('3', 'c', 'C')],
      pages: [
        page('product', '1', '/products/a', ['']),
        page('product', '2', '/products/b', ['https://shop-example.myshopify.com/products/b']),
        page('product', '3', '/products/c', ['http://shop.example/products/c']),
      ],
    }));
    assert.equal(statusOf(result, 'product:1'), 'Invalid Canonical');
    assert.equal(statusOf(result, 'product:2'), 'Off-Domain Canonical');
    assert.equal(statusOf(result, 'product:3'), 'Off-Domain Canonical');
  });

  it('judges a canonical pointing elsewhere by what its target actually answered', () => {
    const result = run(snapshot({
      products: [product('1', 'a', 'A'), product('2', 'b', 'B'), product('3', 'c', 'C')],
      pages: [
        page('product', '1', '/products/a', ['/products/gone']),
        page('product', '2', '/products/b', ['/products/moved']),
        page('product', '3', '/products/c', ['/products/other']),
      ],
      targets: {
        [`${ORIGIN}/products/gone`]: { status: 404, location: null, reason: null },
        [`${ORIGIN}/products/moved`]: { status: 301, location: `${ORIGIN}/products/new`, reason: null },
        [`${ORIGIN}/products/other`]: { status: 200, location: null, reason: null },
      },
    }));
    assert.equal(statusOf(result, 'product:1'), 'Canonical Target Broken');
    assert.equal(statusOf(result, 'product:2'), 'Canonical Target Redirects');
    assert.equal(statusOf(result, 'product:3'), 'Canonicalised Elsewhere');
    // Worst first: the broken target is critical and leads.
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.ok(result.score <= 60, 'a critical finding caps the score');
  });

  it('never reports a canonical for a page the crawl did not load', () => {
    const result = run(snapshot({
      products: [product('1', 'a', 'A'), product('2', 'b', 'B')],
      pages: [page('home', null, '/', [`${ORIGIN}/`]), page('product', '1', '/products/a', ['/products/a'])],
    }));
    const unloaded = result.details.evidenceRows.find((row) => row.id === 'product:2');
    assert.equal(unloaded?.status, 'Healthy');
    assert.equal(unloaded?.cells.canonical, null);
    assert.equal(unloaded?.current?.value, 'Not loaded in this audit');
    assert.equal(result.details.contextValue, '2 of 3 pages');
    assert.match(result.details.summary, /checked for duplicate handles only/);
  });

  it('still reports duplicate handles when the crawl could not run, and says why', () => {
    const result = run(snapshot({
      products: [product('1', 'shirt', 'Shirt'), product('2', 'shirt-1', 'Shirt')],
      pages: [],
    }));
    assert.equal(result.status, 'ok');
    assert.equal(result.details.contextValue, 'Not measured');
    assert.match(result.details.summary, /could not load any page/);
    assert.equal(statusOf(result, 'product:2'), 'Duplicate Handle');
  });

  it('is unavailable only when there is nothing at all to check', () => {
    const result = run(snapshot({ pages: null }));
    assert.equal(result.status, 'unavailable');
  });
});

describe('seo.canonicals · duplicate handles', () => {
  it('flags both the original and the copy when a suffixed handle shares the title', () => {
    const result = run(snapshot({ products: [product('1', 'blue-shirt', 'Blue Shirt'), product('2', 'blue-shirt-1', ' blue  shirt ')] }));
    assert.equal(statusOf(result, 'product:1'), 'Duplicate Handle');
    assert.equal(statusOf(result, 'product:2'), 'Duplicate Handle');
    assert.match(result.details.evidenceRows.find((row) => row.id === 'product:1')?.note ?? '', /2 products with the same title: blue-shirt, blue-shirt-1/);
  });

  // Modelled on a real store: a product duplicated five times, each copy's title numbered, the
  // description, price and image untouched.
  const COPY = '<p>Saw palmetto extract supports prostate health and normal urinary flow in adult men.</p>';
  it('flags copies whose titles were numbered but whose description is word for word the same', () => {
    const result = run(snapshot({
      products: [
        product('1', 'formula', 'Prostaid Formula', { bodyHtml: COPY }),
        product('2', 'formula-1', 'Prostaid Formula 1', { bodyHtml: COPY }),
        // Whitespace and markup differences do not make a different description.
        product('3', 'formula-2', 'Prostaid Formula 2', { bodyHtml: `${COPY}\n  ` }),
      ],
    }));
    for (const id of ['product:1', 'product:2', 'product:3']) assert.equal(statusOf(result, id), 'Duplicate Handle');
    assert.match(result.details.evidenceRows.find((row) => row.id === 'product:2')?.note ?? '', /3 products with the same description: formula, formula-1, formula-2/);
  });

  it('flags suffixed copies even when the un-suffixed original is gone', () => {
    const result = run(snapshot({ products: [product('1', 'tonic-1', 'Tonic', { bodyHtml: COPY }), product('2', 'tonic-2', 'Tonic B', { bodyHtml: COPY })] }));
    assert.equal(statusOf(result, 'product:1'), 'Duplicate Handle');
    assert.match(result.findings[0]?.evidenceRows?.[0]?.suggested?.value ?? '', /Keep “tonic-1”/);
  });

  it('does not match on a description too short to identify anything', () => {
    const result = run(snapshot({ products: [product('1', 'kit', 'Kit', { bodyHtml: 'Coming soon.' }), product('2', 'kit-2', 'Kit 2', { bodyHtml: 'Coming soon.' })] }));
    assert.equal(result.findings.length, 0);
  });

  it('does not treat sizes, strengths or model numbers as duplicates', () => {
    const result = run(snapshot({
      products: [
        product('1', 'whey-protein-2', 'Whey Protein 2lb'),
        product('2', 'whey-protein-5', 'Whey Protein 5lb'),
        product('3', 'iphone', 'iPhone'),
        product('4', 'iphone-15', 'iPhone 15'),
      ],
    }));
    assert.equal(result.findings.length, 0);
    assert.equal(result.healthyCount, 4);
  });

  it('skips unpublished products, and compares handles only within one type and one blog', () => {
    const result = run(snapshot({
      products: [product('1', 'gift', 'Gift'), product('2', 'gift-1', 'Gift', { status: 'draft' })],
      collections: [collection('3', 'gift-1', 'Gift')],
      articles: [article('4', 'news', 'launch', 'Launch'), article('5', 'journal', 'launch-1', 'Launch')],
    }));
    assert.equal(result.findings.length, 0);
    assert.equal(result.analyzedCount, 4);
    assert.match(result.details.summary, /1 unpublished item was skipped/);
  });

  it('does not report a copy that canonicalises onto its original', () => {
    const result = run(snapshot({
      products: [product('1', 'shirt', 'Shirt'), product('2', 'shirt-1', 'Shirt')],
      pages: [page('product', '1', '/products/shirt', ['/products/shirt']), page('product', '2', '/products/shirt-1', ['/products/shirt'])],
    }));
    assert.equal(statusOf(result, 'product:1'), 'Healthy');
    assert.equal(statusOf(result, 'product:2'), 'Healthy');
    assert.equal(result.findings.length, 0);
  });

  it('lists a page with two problems under the worse one, and in both findings', () => {
    const result = run(snapshot({
      products: [product('1', 'shirt', 'Shirt'), product('2', 'shirt-1', 'Shirt')],
      pages: [page('product', '2', '/products/shirt-1', [])],
    }));
    assert.equal(statusOf(result, 'product:2'), 'Missing Canonical');
    const owners = result.findings.filter((finding) => finding.evidenceRows?.some((row) => row.id === 'product:2'));
    assert.deepEqual(owners.map((finding) => finding.details.issueType), ['Missing Canonical', 'Duplicate Handle']);
  });
});
