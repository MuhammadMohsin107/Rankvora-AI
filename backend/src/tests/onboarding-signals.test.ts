// ─── Guided-setup derivation (npm test) ──────────────────────────────
// Every pre-filled answer in onboarding comes from these functions, and the single property that
// matters most is NEGATIVE: given a store with nothing to go on, they must produce nothing.
//
// A merchant is asked to confirm these values, not to author them, so a confident-looking wrong
// answer gets accepted without being read — and then becomes the input to every title tag and
// meta description Rankvora AI writes. The "empty in, empty out" tests below are therefore load-
// bearing, not edge cases.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDUSTRY_OPTIONS,
  deriveBrandedTerms,
  deriveCatalogShape,
  deriveIndustry,
  deriveKeywords,
} from '../services/onboarding-signals.js';
import type { CatalogSignals } from '../audit-engine/store-data/shopify.queries.js';

/** A store with no signal at all — a freshly created shop before its first product. */
const emptySignals: CatalogSignals = {
  productTotal: null,
  collections: [],
  productTypes: [],
  vendors: [],
  tags: [],
  sampledProducts: 0,
};

function signals(overrides: Partial<CatalogSignals>): CatalogSignals {
  return { ...emptySignals, ...overrides };
}

// ─── The negative property ───────────────────────────────────────────

describe('a store with nothing to go on produces nothing', () => {
  it('derives no industry', () => {
    assert.equal(deriveIndustry(emptySignals), null);
  });

  it('derives no catalogue shape when Shopify gave no product count', () => {
    assert.equal(deriveCatalogShape(emptySignals), null);
  });

  it('derives no keywords', () => {
    assert.deepEqual(deriveKeywords(emptySignals, []), []);
  });

  it('derives no branded terms from a shop with no name', () => {
    assert.deepEqual(deriveBrandedTerms(null, null), []);
  });

  it('never invents an industry for a catalogue the taxonomy does not cover', () => {
    // Real words, no taxonomy match. The correct answer is "we don't know", not the nearest label.
    const result = deriveIndustry(
      signals({
        collections: [{ title: 'Bespoke Consultancy Retainers', productCount: 4 }],
        productTypes: [{ value: 'Retainer', count: 4 }],
      }),
    );
    assert.equal(result, null);
  });
});

// ─── Industry classification ─────────────────────────────────────────

describe('industry is classified from the merchant’s own catalogue words', () => {
  it('reads the vertical from collection titles and product types', () => {
    const result = deriveIndustry(
      signals({
        collections: [
          { title: 'Merino Base Layers', productCount: 64 },
          { title: 'Insulated Jackets', productCount: 41 },
        ],
        productTypes: [{ value: 'Hoodie', count: 30 }],
      }),
    );
    assert.equal(result?.value, 'Apparel & fashion');
    assert.equal(result?.confidence, 'high');
  });

  it('cites the actual phrases that produced the answer', () => {
    const result = deriveIndustry(
      signals({ collections: [{ title: 'Skincare Serums', productCount: 30 }] }),
    );
    // The basis is shown under the field, so a merchant can judge the guess. It must quote their
    // own words rather than describe the rule that fired.
    assert.ok(result);
    assert.match(result.basis, /Skincare Serums/);
  });

  it('reports low confidence when the signal is one stray tag', () => {
    const result = deriveIndustry(signals({ tags: [{ value: 'gift', count: 1 }] }));
    assert.equal(result?.confidence, 'low');
  });

  it('weights a large collection above a small one', () => {
    // Both verticals are present; the one the merchant has actually built a catalogue around wins.
    const result = deriveIndustry(
      signals({
        collections: [
          { title: 'Dog Beds', productCount: 120 },
          { title: 'Notebooks', productCount: 2 },
        ],
      }),
    );
    assert.equal(result?.value, 'Pet supplies');
  });

  it('only ever returns a label the API will accept back', () => {
    const result = deriveIndustry(signals({ collections: [{ title: 'Espresso Beans', productCount: 12 }] }));
    assert.ok(result);
    assert.ok(INDUSTRY_OPTIONS.includes(result.value));
  });
});

// ─── Keyword seeding ─────────────────────────────────────────────────

describe('keyword seeds come from collections and product types', () => {
  it('ranks the largest collections first and records where each came from', () => {
    const seeds = deriveKeywords(
      signals({
        collections: [
          { title: 'Merino Base Layers', productCount: 64 },
          { title: 'Wool Socks', productCount: 12 },
        ],
        productTypes: [{ value: 'Beanie', count: 9 }],
        sampledProducts: 85,
      }),
      [],
    );

    assert.deepEqual(
      seeds.map((seed) => seed.value),
      ['merino base layers', 'wool socks', 'beanie'],
    );
    // The source is shown on the suggestion chip so a merchant can judge it.
    assert.equal(seeds[0].source, 'Collection · 64 products');
    assert.equal(seeds[2].source, 'Product type · 9 of 85 sampled');
  });

  it('drops Shopify’s own default collection names, which carry no search intent', () => {
    const seeds = deriveKeywords(
      signals({
        collections: [
          { title: 'Home page', productCount: 30 },
          { title: 'Frontpage', productCount: 25 },
          { title: 'All', productCount: 400 },
          { title: 'Best Sellers', productCount: 20 },
          { title: 'Cast Iron Cookware', productCount: 18 },
        ],
      }),
      [],
    );
    assert.deepEqual(seeds.map((seed) => seed.value), ['cast iron cookware']);
  });

  it('excludes the merchant’s own brand, so targets stay non-branded', () => {
    const seeds = deriveKeywords(
      signals({ collections: [{ title: 'Northline', productCount: 50 }, { title: 'Rain Shells', productCount: 20 }] }),
      ['Northline'],
    );
    assert.deepEqual(seeds.map((seed) => seed.value), ['rain shells']);
  });

  it('de-duplicates case-insensitively', () => {
    const seeds = deriveKeywords(
      signals({
        collections: [{ title: 'Wool Socks', productCount: 12 }],
        productTypes: [{ value: 'wool socks', count: 12 }],
      }),
      [],
    );
    assert.equal(seeds.length, 1);
  });

  it('drops SKU-like and numeric titles that are organisational, not searched for', () => {
    const seeds = deriveKeywords(
      signals({ collections: [{ title: 'SS24', productCount: 10 }, { title: '2024', productCount: 8 }] }),
      [],
    );
    assert.deepEqual(seeds, []);
  });

  it('never returns more than the ten the step offers', () => {
    const seeds = deriveKeywords(
      signals({
        collections: Array.from({ length: 30 }, (_, index) => ({
          title: `Collection Number ${index}`,
          productCount: 30 - index,
        })),
      }),
      [],
    );
    assert.equal(seeds.length, 10);
  });
});

// ─── Branded terms ───────────────────────────────────────────────────

describe('branded terms are derived from the shop’s real identity', () => {
  it('offers the trading name alongside the full legal name', () => {
    const terms = deriveBrandedTerms('Northline Outdoor Supply Co.', 'northline-outdoor.myshopify.com');
    assert.ok(terms.includes('Northline Outdoor Supply Co.'));
    assert.ok(terms.includes('Northline Outdoor Supply'));
  });

  it('adds the store handle only when it differs from the name', () => {
    const same = deriveBrandedTerms('Northline', 'northline.myshopify.com');
    assert.deepEqual(same, ['Northline']);
  });

  it('does not repeat a variant that is identical to the name', () => {
    const terms = deriveBrandedTerms('Northline', null);
    assert.deepEqual(terms, ['Northline']);
  });
});

// ─── Catalogue shape ─────────────────────────────────────────────────

describe('catalogue shape is stated from the real product count', () => {
  it('calls a small catalogue focused and quotes the count back', () => {
    const result = deriveCatalogShape(signals({ productTotal: { count: 42, exact: true } }));
    assert.equal(result?.value, 'Focused catalogue');
    assert.match(result.basis, /42 products/);
  });

  it('calls a large catalogue broad', () => {
    const result = deriveCatalogShape(signals({ productTotal: { count: 4300, exact: true } }));
    assert.equal(result?.value, 'Broad catalogue');
  });

  it('preserves Shopify’s "at least" precision rather than stating a total it did not give', () => {
    const result = deriveCatalogShape(signals({ productTotal: { count: 10000, exact: false } }));
    assert.match(result!.basis, /at least 10,000/);
  });

  it('lowers confidence for an inexact count near the boundary', () => {
    const result = deriveCatalogShape(signals({ productTotal: { count: 250, exact: false } }));
    assert.equal(result?.confidence, 'medium');
  });
});
