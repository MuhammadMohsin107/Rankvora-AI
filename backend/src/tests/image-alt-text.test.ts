// ─── Image alt text · evidence that can actually be fixed (npm test) ─
//
// THE BUG THIS PINS DOWN. Alt text was offered in the fix UI and could not work at any layer. The
// check wrote one row per PRODUCT whose current value was a coverage summary — "0 of 1 images
// labelled" — so the fix planner had no image to write to, no baseline to compare against, and
// nothing but that sentence to build a value from. It sent the sentence to a language model, the
// model echoed it back, validation rejected it as unchanged, and the merchant was told the AI was
// unavailable.
//
// The contract these tests hold in place:
//   · one row per IMAGE, named by its own media id, so a value has somewhere to go
//   · the image's REAL alt text as the current value, so "unchanged" means something
//   · the product's own fields on the row, because the merchant's template renders from them
//   · the product's verdict as the row status, because that is what the findings count
//
// Pure functions of a snapshot — no DB, no network, no Shopify.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageAltTextCheck } from '../audit-engine/checks/seo/image-alt-text.js';
import { parseProductImageId, parseResourceRef, productImageRef } from '../lib/ai/fix-policy.js';
import type { SnapshotImage, SnapshotProduct, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarEvidenceRow, SubPillarResult } from '../audit-engine/types.js';

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(check.id + ' unexpectedly returned a promise');
  return result;
}

function image(id: string, alt: string | null): SnapshotImage {
  return { id, src: `https://cdn.shopify.com/${id}.jpg`, alt, width: 800, height: 800 };
}

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

function snapshot(products: SnapshotProduct[]): StoreSnapshot {
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
  };
}

function rowsOf(result: SubPillarResult): SubPillarEvidenceRow[] {
  return ((result.details as { evidenceRows?: SubPillarEvidenceRow[] }).evidenceRows ?? []);
}

/** One unlabelled photo, one product that is half done, one fully described. */
const STORE = snapshot([
  product({
    id: '111',
    title: 'Biotin Hair Strengthening Duo',
    productType: 'Supplement',
    vendor: 'Nutristore',
    images: [image('900', null)],
  }),
  product({
    id: '222',
    title: 'Calment Sleep Support',
    images: [image('901', 'Calment bottle, front'), image('902', '   ')],
  }),
  product({
    id: '333',
    title: 'Ginky Plus',
    images: [image('903', 'Ginky Plus jar')],
  }),
]);

describe('seo.image-alt-text · evidence rows', () => {
  const rows = rowsOf(run(imageAltTextCheck, STORE));

  it('emits one row per image, not one per product', () => {
    assert.equal(rows.length, 4);
  });

  it('names the image it is about, so a value has somewhere to go', () => {
    // This is the whole fix: `product:111` could not say WHICH photo, and could not be written.
    assert.equal(rows[0].id, 'productImage:111/900');
    const parsed = parseResourceRef(rows[0].id);
    assert.deepEqual(parsed, { resourceType: 'productImage', resourceId: '111/900' });
  });

  it('carries the image\'s real alt text as the current value', () => {
    // Not "0 of 1 images labelled". An empty string is the honest current value of an undescribed
    // image, and it is what a proposed value is compared against.
    assert.equal(rows[0].current?.value, '');
    assert.equal(rows[1].current?.value, 'Calment bottle, front');
  });

  it('treats a whitespace-only alt attribute as no description', () => {
    // Shopify stores '' as a decorative marker; a product photo is not decorative.
    assert.equal(rows[2].current?.value, '');
  });

  it('carries what the merchant\'s template renders from', () => {
    assert.equal(rows[0].cells.name, 'Biotin Hair Strengthening Duo');
    assert.equal(rows[0].cells.productType, 'Supplement');
    assert.equal(rows[0].cells.vendor, 'Nutristore');
    assert.equal(rows[0].cells.position, 1);
    // A second photo of the same product is distinguishable in the review panel, where otherwise
    // two boxes would carry the same product name and nothing else.
    assert.equal(rows[2].cells.imageLabel, '2 of 2');
  });

  it('gives every row its product\'s verdict, which is what the findings count', () => {
    // The findings are about products — "no alt text at all" vs "partially labelled" — and a row's
    // status is what their filter chips select. An image-level verdict here would leave the
    // partial finding with a chip that matched nothing.
    assert.equal(rows[0].status, 'Missing');
    assert.equal(rows[1].status, 'Partial');
    assert.equal(rows[2].status, 'Partial');
    assert.equal(rows[3].status, 'Healthy');
  });

  it('still scores and counts by product', () => {
    const result = run(imageAltTextCheck, STORE);
    assert.equal(result.analyzedCount, 3);
    assert.equal(result.healthyCount, 1);
    assert.match(String((result.details as { summary?: string }).summary), /2 of 4 images labelled/);
  });

  it('raises both findings with the issue types its rows carry', () => {
    const result = run(imageAltTextCheck, STORE);
    const issueTypes = result.findings.map((finding) => (finding.details as { issueType: string }).issueType);
    assert.deepEqual(issueTypes.sort(), ['Missing', 'Partial']);
    for (const issueType of issueTypes) {
      assert.ok(rows.some((row) => row.status === issueType), `no evidence row carries status ${issueType}`);
    }
  });
});

describe('productImage references', () => {
  it('round-trips the two ids Shopify\'s media mutation needs', () => {
    assert.deepEqual(parseProductImageId('111/900'), { productId: '111', mediaId: '900' });
    assert.equal(productImageRef('111', '900'), 'productImage:111/900');
  });

  /**
   * These ids are rebuilt into gids and sent to a live store, so anything that is not a Shopify
   * numeric id is refused at the boundary rather than interpolated into a mutation.
   */
  it('refuses anything that is not a pair of numeric ids', () => {
    assert.equal(parseProductImageId('111'), null);
    assert.equal(parseProductImageId('111/900/1'), null);
    assert.equal(parseProductImageId('gid://shopify/MediaImage/900'), null);
    assert.equal(parseProductImageId('111/abc'), null);
    assert.equal(parseProductImageId(''), null);
    assert.equal(parseResourceRef('productImage:111'), null);
  });
});
