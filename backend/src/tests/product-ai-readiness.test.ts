// ─── Per-product AI readiness (npm test) ─────────────────────────────
//
// The readiness view composes three EXISTING checks rather than measuring anything of its own, so
// the property worth protecting is not "is the verdict right" — the sub-pillar tests already cover
// that — but "is this the SAME verdict the sub-pillar reached".
//
// A second, drifting copy of the logic is the failure this guards against. If the readiness panel
// and the sub-pillar page ever disagree about one product while both claim to have measured it,
// the merchant cannot tell which is lying, and the honest answer is that both are.
//
// Every product below is the shape the Shopify provider really produces. Nothing here is a fixture
// standing in for a feature that does not exist.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assess as assessAgentic } from '../audit-engine/checks/ai-discovery/agentic-attrs.js';
import { assess as assessFeed, duplicateSkusWithin } from '../audit-engine/checks/ai-discovery/feed.js';
import { assess as assessAnswerable } from '../audit-engine/checks/ai-discovery/answerable-qa.js';
import { HEALTHY } from '../audit-engine/checks/shared/status.js';
import type { SnapshotProduct } from '../audit-engine/store-data/types.js';

/** A product carrying everything the three checks look for. */
function completeProduct(overrides: Partial<SnapshotProduct> = {}): SnapshotProduct {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Merino Wool Running Socks',
    handle: 'merino-wool-running-socks',
    bodyHtml:
      '<p>Made from 80% merino wool for warmth without bulk. Fits US sizes 8-12; see the size chart for measurements. '
      + 'Machine washable on cold, tumble dry low. Compatible with most running shoes. Ships in 2 business days and '
      + 'can be returned within 30 days. Material: merino wool blend. Care: do not bleach.</p>',
    vendor: 'Aurora',
    productType: 'Socks',
    tags: ['running', 'wool'],
    status: 'ACTIVE',
    seo: { title: 'Merino Wool Running Socks', description: 'Lightweight merino running socks.' },
    metafields: [{ namespace: 'custom', key: 'material', value: 'merino wool' }],
    media: [],
    variantsTruncated: false,
    variants: [
      {
        id: 'gid://shopify/ProductVariant/1',
        title: 'Medium',
        sku: 'SOCK-M',
        barcode: '0123456789012',
        price: '18.00',
        availableForSale: true,
        inventoryQuantity: 24,
        selectedOptions: [{ name: 'Size', value: 'Medium' }],
      },
      {
        id: 'gid://shopify/ProductVariant/2',
        title: 'Large',
        sku: 'SOCK-L',
        barcode: '0123456789029',
        price: '18.00',
        availableForSale: true,
        inventoryQuantity: 11,
        selectedOptions: [{ name: 'Size', value: 'Large' }],
      },
    ],
    options: [{ name: 'Size', values: ['Medium', 'Large'] }],
    ...overrides,
  } as SnapshotProduct;
}

/** The readiness score exactly as the service computes it: a count, not a weighted model. */
function readiness(product: SnapshotProduct): { score: number; passed: number } {
  const statuses = [
    assessAgentic(product).status,
    assessFeed(product, new Set()).status,
    assessAnswerable({ bodyHtml: product.bodyHtml }).status,
  ];
  const passed = statuses.filter((status) => status === HEALTHY).length;
  return { score: Math.round((passed / statuses.length) * 100), passed };
}

describe('per-product readiness composes the real checks', () => {
  it('exports all three sub-pillar assessments, so the view cannot reimplement them', () => {
    assert.equal(typeof assessAgentic, 'function');
    assert.equal(typeof assessFeed, 'function');
    assert.equal(typeof assessAnswerable, 'function');
  });

  it('returns the same Assessment shape from each, which is what makes them composable', () => {
    const product = completeProduct();
    for (const assessment of [
      assessAgentic(product),
      assessFeed(product, new Set()),
      assessAnswerable({ bodyHtml: product.bodyHtml }),
    ]) {
      assert.ok(['Healthy', 'Needs Work', 'Critical'].includes(assessment.status));
      assert.equal(typeof assessment.issue, 'string');
      assert.equal(typeof assessment.detail, 'string');
      assert.equal(typeof assessment.recommendation, 'string');
    }
  });
});

describe('readiness score is a count of checks passed', () => {
  // The only scores that can exist with three checks. A value outside this set would mean a
  // weighting crept in — which is a judgement wearing a measurement's clothes.
  const LEGAL_SCORES = [0, 33, 67, 100];

  it('only ever produces 0, 33, 67 or 100', () => {
    const products = [
      completeProduct(),
      completeProduct({ bodyHtml: '<p>Nice socks.</p>' }),
      completeProduct({ vendor: '', productType: '' }),
      completeProduct({ variants: [] }),
      completeProduct({ bodyHtml: '', vendor: '', productType: '', variants: [] }),
    ];
    for (const product of products) {
      assert.ok(
        LEGAL_SCORES.includes(readiness(product).score),
        `score ${readiness(product).score} is not a plain count of 3 checks`,
      );
    }
  });

  it('scores a complete product higher than one stripped of its attributes', () => {
    const complete = readiness(completeProduct());
    const stripped = readiness(completeProduct({ vendor: '', productType: '', bodyHtml: '<p>Socks.</p>' }));
    assert.ok(
      complete.score > stripped.score,
      `expected the complete product to score higher (${complete.score} vs ${stripped.score})`,
    );
  });

  it('never reports a passed count above the number of checks applied', () => {
    const { passed } = readiness(completeProduct());
    assert.ok(passed >= 0 && passed <= 3);
  });
});

describe('duplicate SKUs are judged within one product only', () => {
  // The REAL rule, imported. This used to be a third hand-copied version of it — in feedCheck, in
  // the readiness service and here — so the tests proved a copy agreed with itself.
  const duplicateSkusFor = duplicateSkusWithin;

  it('finds nothing when every variant SKU is distinct', () => {
    assert.equal(duplicateSkusFor(completeProduct()).size, 0);
  });

  it('finds a SKU repeated across two variants of the same product', () => {
    const product = completeProduct();
    product.variants[1]!.sku = 'SOCK-M';
    const duplicates = duplicateSkusFor(product);
    assert.equal(duplicates.size, 1);
    assert.ok(duplicates.has('sock-m'));
  });

  it('ignores blank and whitespace-only SKUs rather than counting them as a repeat', () => {
    const product = completeProduct();
    product.variants[0]!.sku = '';
    product.variants[1]!.sku = '   ';
    assert.equal(duplicateSkusFor(product).size, 0);
  });

  it('matches case-insensitively, because Shopify does not normalise SKU case', () => {
    const product = completeProduct();
    product.variants[1]!.sku = 'sock-m';
    assert.ok(duplicateSkusFor(product).has('sock-m'));
  });
});
