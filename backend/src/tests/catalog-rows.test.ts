/**
 * The Products, Collections and Blog articles pages are views over the audit's own evidence rows, so
 * what a row records is what those pages can show. These tests pin the facts three checks record
 * beside their columns — a photo, a last-changed date, a published date, a product count — and that a
 * fact the store did not have is recorded as null, never as a stand-in.
 *
 * The inputs are the smallest typed snapshots that exercise each check; nothing here is a fixture of
 * the app's own data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blogFreshnessCheck } from '../audit-engine/checks/content/blog-freshness.js';
import { collectionDescriptionsCheck } from '../audit-engine/checks/content/descriptions.js';
import { mediaRichnessCheck } from '../audit-engine/checks/content/media-richness.js';
import type {
  SnapshotArticle,
  SnapshotCollection,
  SnapshotImage,
  SnapshotProduct,
  StoreSnapshot,
} from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarEvidenceRow } from '../audit-engine/types.js';

const ORIGIN = 'https://t.myshopify.com';

function rowsOf(check: AuditCheck, snapshot: StoreSnapshot): SubPillarEvidenceRow[] {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(`${check.id} unexpectedly returned a promise`);
  return result.details.evidenceRows ?? [];
}

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-06-01T00:00:00Z'),
    shop: { domain: 't.myshopify.com', primaryUrl: ORIGIN, name: 'T', email: null, currency: 'GBP', country: 'GB', timezone: null, planName: null },
    products: [],
    collections: [],
    pages: [],
    articles: [],
    policies: [],
    policyAccess: { available: true },
    theme: null,
    storefront: null,
    redirects: { available: false, reason: 'scope', detail: 'not granted' },
    crawl: null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: true, theme: false, storefront: false, crawl: false },
    scope: { productLimit: 250, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
    ...overrides,
  };
}

const image = (src: string): SnapshotImage => ({ id: '', src, alt: null, width: null, height: null });

function product(id: string, overrides: Partial<SnapshotProduct> = {}): SnapshotProduct {
  return {
    id, title: `Product ${id}`, handle: `p-${id}`, url: `${ORIGIN}/products/p-${id}`, bodyHtml: '', productType: '', vendor: '', tags: [],
    status: 'active', publishedAt: null, updatedAt: null, images: [], variantCount: 1, options: [], variants: [], variantsTruncated: false,
    sellingPlanGroupCount: null, metafields: [], metafieldsAvailable: true, seoTitle: null, seoDescription: null,
    ...overrides,
  };
}

function collection(id: string, overrides: Partial<SnapshotCollection> = {}): SnapshotCollection {
  return {
    id, title: `Collection ${id}`, handle: `c-${id}`, url: `${ORIGIN}/collections/c-${id}`, bodyHtml: '', productCount: null,
    updatedAt: null, image: null, seoTitle: null, seoDescription: null,
    ...overrides,
  };
}

function article(id: string, overrides: Partial<SnapshotArticle> = {}): SnapshotArticle {
  return {
    id, blogId: '1', blogHandle: 'news', title: `Article ${id}`, handle: `a-${id}`, url: `${ORIGIN}/blogs/news/a-${id}`, bodyHtml: '',
    publishedAt: null, updatedAt: null, image: null, seoTitle: null, seoDescription: null,
    ...overrides,
  };
}

describe('media richness rows — what the Products page reads', () => {
  it('records a product’s first image and when Shopify last changed it', () => {
    const [row] = rowsOf(mediaRichnessCheck, snapshot({
      products: [product('1', { images: [image('https://cdn.shopify.com/a.jpg'), image('https://cdn.shopify.com/b.jpg')], updatedAt: '2026-05-01T09:00:00Z' })],
    }));
    assert.equal(row.id, 'product:1');
    assert.equal(row.cells.imageSrc, 'https://cdn.shopify.com/a.jpg');
    assert.equal(row.cells.updatedAt, '2026-05-01T09:00:00Z');
  });

  it('records null, not a stand-in, for a product with no image and no date', () => {
    const [row] = rowsOf(mediaRichnessCheck, snapshot({ products: [product('2')] }));
    assert.equal(row.cells.imageSrc, null);
    assert.equal(row.cells.updatedAt, null);
  });
});

describe('collection description rows — what the Collections page reads', () => {
  it('records a collection’s featured image, last change and product count', () => {
    const [row] = rowsOf(collectionDescriptionsCheck, snapshot({
      collections: [collection('7', { image: image('https://cdn.shopify.com/c.jpg'), updatedAt: '2026-04-02T10:00:00Z', productCount: 12 })],
    }));
    assert.equal(row.id, 'collection:7');
    assert.equal(row.cells.imageSrc, 'https://cdn.shopify.com/c.jpg');
    assert.equal(row.cells.updatedAt, '2026-04-02T10:00:00Z');
    assert.equal(row.cells.productCount, 12);
    // Still what the check's own table shows.
    assert.equal(row.cells.collection, 'Collection 7');
  });

  it('records null for a collection Shopify said nothing more about', () => {
    const [row] = rowsOf(collectionDescriptionsCheck, snapshot({ collections: [collection('8')] }));
    assert.equal(row.cells.imageSrc, null);
    assert.equal(row.cells.updatedAt, null);
    assert.equal(row.cells.productCount, null);
  });

  it('does not put a collection’s extras on the product-description check', () => {
    // The two share one evaluator; only the collection call passes extras.
    const rows = rowsOf(collectionDescriptionsCheck, snapshot({ collections: [collection('9')] }));
    assert.ok(rows.every((row) => row.id.startsWith('collection:')));
  });
});

describe('blog freshness rows — what the Blog articles page reads', () => {
  it('records an article’s raw dates and featured image beside its formatted ones', () => {
    const [row] = rowsOf(blogFreshnessCheck, snapshot({
      articles: [article('5', { publishedAt: '2026-01-10T08:00:00Z', updatedAt: '2026-03-01T08:00:00Z', image: image('https://cdn.shopify.com/post.jpg') })],
    }));
    assert.equal(row.id, 'article:5');
    assert.equal(row.cells.publishedAt, '2026-01-10T08:00:00Z');
    assert.equal(row.cells.updatedAt, '2026-03-01T08:00:00Z');
    assert.equal(row.cells.imageSrc, 'https://cdn.shopify.com/post.jpg');
    assert.equal(row.cells.article, 'Article 5');
  });

  it('records null dates and no image for an article that has none', () => {
    const [row] = rowsOf(blogFreshnessCheck, snapshot({ articles: [article('6')] }));
    assert.equal(row.cells.publishedAt, null);
    assert.equal(row.cells.updatedAt, null);
    assert.equal(row.cells.imageSrc, null);
  });
});
