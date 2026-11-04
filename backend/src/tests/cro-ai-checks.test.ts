// ─── CRO and AI Discovery checks (npm test) ──────────────────────────
// Pure functions of a snapshot — no DB, no network — which is exactly what the AuditCheck
// contract is designed to allow.
//
// The property these tests exist to protect is DATA HONESTY, the rule the whole engine is built
// on: "we could not measure this" must never be rendered as "this is fine", and a deliberate
// business decision must never be scored as a defect. So alongside the detection cases, every
// check is asserted on what it does with missing coverage, an empty catalogue, and — for the
// subscription check — a store that simply does not sell subscriptions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { returnsCheck } from '../audit-engine/checks/cro/returns.js';
import { optionsCheck } from '../audit-engine/checks/cro/options.js';
import { subscriptionCheck } from '../audit-engine/checks/cro/subscription.js';
import { feedCheck } from '../audit-engine/checks/ai-discovery/feed.js';
import { agenticAttrsCheck } from '../audit-engine/checks/ai-discovery/agentic-attrs.js';
import type { SnapshotProduct, SnapshotPolicy, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(`${check.id} unexpectedly returned a promise`);
  return result;
}

function variant(overrides: Partial<SnapshotProduct['variants'][number]> = {}) {
  return { id: 'v1', sku: 'SKU-1', barcode: '5012345678900', price: 20, availableForSale: true, ...overrides };
}

function product(overrides: Partial<SnapshotProduct> & { id: string }): SnapshotProduct {
  return {
    title: `Product ${overrides.id}`,
    handle: overrides.id,
    url: `https://t.myshopify.com/products/${overrides.id}`,
    // Long enough to clear the agentic-attrs description floor unless a test overrides it.
    bodyHtml: '<p>A well described product made from responsibly sourced organic cotton, cut for a relaxed fit and safe to machine wash at thirty degrees.</p>',
    productType: 'Shirts',
    vendor: 'Acme',
    tags: ['cotton'],
    status: 'active',
    // Published, as a live product is: the AI Discovery checks assess only what a shopper can reach.
    publishedAt: '2025-12-01T00:00:00Z',
    updatedAt: null,
    images: [],
    variantCount: 1,
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: [variant()],
    variantsTruncated: false,
    sellingPlanGroupCount: 0,
    metafields: [],
    metafieldsAvailable: false,
    seoTitle: null,
    seoDescription: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 't.myshopify.com', primaryUrl: 'https://t.myshopify.com', name: 'T', email: null, currency: 'GBP', country: 'GB', timezone: null, planName: null },
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

const FULL_POLICY_BODY = `
  <p>We accept returns within 30 days of delivery. To start a return, email us at help@example.com
  and we will send you a prepaid return label — we cover return shipping on faulty items, and the
  customer covers return postage otherwise. Once we have received the item we will issue a refund
  within 5 business days to your original payment method. Sale items and worn garments are final
  sale and cannot be returned; items must be unworn with original tags attached.</p>
`;

function policy(overrides: Partial<SnapshotPolicy> = {}): SnapshotPolicy {
  return { type: 'refund_policy', title: 'Refund policy', body: FULL_POLICY_BODY, url: 'https://t.myshopify.com/policies/refund-policy', ...overrides };
}

// ─── CRO · Returns ───────────────────────────────────────────────────

describe('cro.returns', () => {
  it('names the missing scope instead of reporting a generic failure', () => {
    // Shopify moved shopPolicies behind read_legal_policies, so this is the likeliest cause and
    // the merchant can fix it in one action — a generic "could not read" would leave them stuck.
    const result = run(returnsCheck, snapshot({
      policyAccess: { available: false, reason: 'scope', detail: 'Access denied for shopPolicies field.' },
    }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /read_legal_policies/);
    assert.match(result.details.unavailableReason ?? '', /reconnect/i);
  });

  it('reports unavailable — never a zero — when the policy fetch fails for another reason', () => {
    const result = run(returnsCheck, snapshot({
      policyAccess: { available: false, reason: 'error', detail: 'upstream timeout' },
    }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /could not read/i);
    assert.equal(result.score, 0);
    assert.equal(result.findings.length, 0);
  });

  it('scores a complete policy as fully healthy', () => {
    const result = run(returnsCheck, snapshot({ policies: [policy()] }));
    assert.equal(result.status, 'ok');
    assert.equal(result.healthyCount, result.analyzedCount);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('treats a missing policy as a MEASURED critical failure, not as unmeasurable', () => {
    const result = run(returnsCheck, snapshot({ policies: [] }));
    // The distinction matters: 'unavailable' is excluded from the pillar average, so reporting
    // this as unmeasurable would hide the single worst state this sub-pillar can be in.
    assert.equal(result.status, 'ok');
    assert.equal(result.score, 0);
    assert.equal(result.healthyCount, 0);
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.match(result.findings[0]?.title ?? '', /No refund policy/i);
  });

  it('flags the specific questions a thin policy leaves unanswered', () => {
    const result = run(returnsCheck, snapshot({
      policies: [policy({ body: '<p>All sales are final. Please choose carefully before ordering from us today.</p>' })],
    }));
    assert.equal(result.status, 'ok');
    assert.ok(result.healthyCount < result.analyzedCount);
    const titles = result.findings.map((finding) => finding.title).join(' | ');
    assert.match(titles, /main purchase questions unanswered/i);
    // Severity cap: a 'high' finding must hold the score at or below 80 (scoring.ts).
    assert.ok(result.score <= 80, `expected the high-severity cap to apply, got ${result.score}`);
  });

  it('flags a policy Shopify returned without a public URL', () => {
    const result = run(returnsCheck, snapshot({ policies: [policy({ url: null })] }));
    assert.ok(result.findings.some((finding) => /no public URL/i.test(finding.title)));
  });

  it('emits one evidence row per signal, all using the table vocabulary', () => {
    const result = run(returnsCheck, snapshot({ policies: [policy()] }));
    assert.equal(result.details.evidenceRows.length, result.analyzedCount);
    for (const row of result.details.evidenceRows) {
      assert.ok(['Healthy', 'Needs Work', 'Critical'].includes(row.status), `unexpected status ${row.status}`);
      assert.ok('surface' in row.cells && 'signal' in row.cells && 'coverage' in row.cells);
    }
  });
});

// ─── CRO · Options ───────────────────────────────────────────────────

describe('cro.options', () => {
  it('counts a single-variant product with only Shopify\'s placeholder option as healthy', () => {
    // A product sold in one version needs no options; flagging it would punish a correct catalogue.
    const result = run(optionsCheck, snapshot({ products: [product({ id: 'p1' })] }));
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('flags multi-variant products whose only option is the Default Title placeholder', () => {
    const result = run(optionsCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 4, options: [{ name: 'Title', values: ['Default Title'] }] })],
    }));
    assert.equal(result.healthyCount, 0);
    assert.equal(result.findings[0]?.severity, 'high');
    assert.match(result.findings[0]?.title ?? '', /no named option/i);
  });

  it('flags an option that offers exactly one value', () => {
    const result = run(optionsCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 1, options: [{ name: 'Color', values: ['Blue'] }] })],
    }));
    assert.ok(result.findings.some((finding) => /single-value option/i.test(finding.title)));
  });

  it('flags an option defined with no values at all', () => {
    const result = run(optionsCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 2, options: [{ name: 'Size', values: [] }] })],
    }));
    assert.ok(result.findings.some((finding) => /no values/i.test(finding.title)));
  });

  it('counts a genuine multi-value option structure as healthy', () => {
    const result = run(optionsCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 3, options: [{ name: 'Size', values: ['S', 'M', 'L'] }] })],
    }));
    assert.equal(result.healthyCount, 1);
    assert.equal(result.findings.length, 0);
  });

  it('reports unavailable when products could not be read', () => {
    const result = run(optionsCheck, snapshot({ coverage: { ...snapshot().coverage, products: false } }));
    assert.equal(result.status, 'unavailable');
  });
});

// ─── CRO · Subscription ──────────────────────────────────────────────

describe('cro.subscription', () => {
  it('refuses to score a store that sells no subscriptions as failing', () => {
    // The core honesty property of this check: no programme is a business decision, not a defect.
    // 'unavailable' is excluded from the pillar average, so the store is not dragged down.
    const result = run(subscriptionCheck, snapshot({
      products: [product({ id: 'p1' }), product({ id: 'p2' })],
    }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /no subscription programme|does not score this as a failure/i);
  });

  it('measures enrolment once a programme exists', () => {
    const result = run(subscriptionCheck, snapshot({
      products: [
        product({ id: 'p1', productType: 'Coffee', sellingPlanGroupCount: 1 }),
        product({ id: 'p2', productType: 'Coffee', sellingPlanGroupCount: 0 }),
      ],
    }));
    assert.equal(result.status, 'ok');
    assert.equal(result.analyzedCount, 2);
    assert.equal(result.healthyCount, 1);
    assert.ok(result.findings.some((finding) => /left out of an existing subscription/i.test(finding.title)));
  });

  it('does not judge product types the programme never covered', () => {
    // A store selling coffee subscriptions and one-off mugs must not be marked down for the mugs.
    const result = run(subscriptionCheck, snapshot({
      products: [
        product({ id: 'p1', productType: 'Coffee', sellingPlanGroupCount: 1 }),
        product({ id: 'p2', productType: 'Mugs', sellingPlanGroupCount: 0 }),
        product({ id: 'p3', productType: 'Mugs', sellingPlanGroupCount: 0 }),
      ],
    }));
    assert.equal(result.analyzedCount, 1, 'only the Coffee type is in scope');
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('reports full enrolment without inventing a finding', () => {
    const result = run(subscriptionCheck, snapshot({
      products: [
        product({ id: 'p1', productType: 'Coffee', sellingPlanGroupCount: 1 }),
        product({ id: 'p2', productType: 'Coffee', sellingPlanGroupCount: 2 }),
      ],
    }));
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });
});

// ─── AI Discovery · Feed ─────────────────────────────────────────────

describe('ai-discovery.feed', () => {
  it('counts a fully identified product as healthy', () => {
    const result = run(feedCheck, snapshot({ products: [product({ id: 'p1' })] }));
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('treats an unpriced variant as critical', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', variants: [variant({ price: 0 })] })],
    }));
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.match(result.findings[0]?.title ?? '', /unpriced variant/i);
    // A critical finding caps the sub-pillar score at 60 (scoring.ts).
    assert.ok(result.score <= 60);
  });

  it('detects the same SKU repeated across variants of one product', () => {
    const result = run(feedCheck, snapshot({
      products: [product({
        id: 'p1',
        variantCount: 3,
        variants: [
          variant({ id: 'v1', sku: 'DUP-1' }),
          variant({ id: 'v2', sku: 'DUP-1' }),
          variant({ id: 'v3', sku: 'DUP-1' }),
        ],
      })],
    }));
    assert.ok(result.findings.some((finding) => /share one SKU/i.test(finding.title)));
  });

  it('does NOT treat the same SKU on two different products as a duplicate', () => {
    // Cross-product reuse is a different (and much rarer) problem; conflating them misreports both.
    const result = run(feedCheck, snapshot({
      products: [
        product({ id: 'p1', variants: [variant({ id: 'v1', sku: 'SHARED' })] }),
        product({ id: 'p2', variants: [variant({ id: 'v2', sku: 'SHARED' })] }),
      ],
    }));
    assert.equal(result.findings.filter((finding) => /share one SKU/i.test(finding.title)).length, 0);
    assert.equal(result.healthyCount, 2);
  });

  it('flags a product with no barcode on any variant', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', variants: [variant({ barcode: null })] })],
    }));
    assert.ok(result.findings.some((finding) => /no GTIN/i.test(finding.title)));
  });

  it('flags a missing brand or category', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', vendor: '', productType: '' })],
    }));
    assert.ok(result.findings.some((finding) => /brand or category/i.test(finding.title)));
  });

  it('records that a truncated variant list only covers the sample', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 80, variants: [variant()], variantsTruncated: true })],
    }));
    assert.match(result.details.summary, /variants sampled|more variants than were read/i);
  });

  it('reports unavailable rather than 100 when there are no products', () => {
    const result = run(feedCheck, snapshot({ products: [] }));
    assert.equal(result.status, 'unavailable');
  });
});

// ─── AI Discovery · Agentic attributes ───────────────────────────────

describe('ai-discovery.agentic-attrs', () => {
  it('counts a purchasable, described, structured product as healthy', () => {
    const result = run(agenticAttrsCheck, snapshot({ products: [product({ id: 'p1' })] }));
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100);
    assert.equal(result.findings.length, 0);
  });

  it('treats a product with nothing in stock as critical, even when its feed data is perfect', () => {
    // This is the case that separates this check from ai-discovery.feed: flawless identifiers,
    // and still impossible for an agent to buy.
    const withoutStock = product({ id: 'p1', variants: [variant({ availableForSale: false })] });
    const feedResult = run(feedCheck, snapshot({ products: [withoutStock] }));
    const agentResult = run(agenticAttrsCheck, snapshot({ products: [withoutStock] }));

    assert.equal(feedResult.healthyCount, 1, 'feed readiness is unaffected by stock');
    assert.equal(agentResult.healthyCount, 0);
    assert.equal(agentResult.findings[0]?.severity, 'critical');
    assert.match(agentResult.findings[0]?.title ?? '', /no purchasable variant/i);
  });

  it('flags variants an agent has no named attribute to select on', () => {
    const result = run(agenticAttrsCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 3, options: [{ name: 'Title', values: ['Default Title'] }] })],
    }));
    assert.ok(result.findings.some((finding) => /no attribute to select on/i.test(finding.title)));
  });

  it('flags an empty or too-short description', () => {
    const empty = run(agenticAttrsCheck, snapshot({ products: [product({ id: 'p1', bodyHtml: '' })] }));
    assert.ok(empty.findings.some((finding) => /too little description/i.test(finding.title)));

    const short = run(agenticAttrsCheck, snapshot({ products: [product({ id: 'p1', bodyHtml: '<p>A shirt.</p>' })] }));
    assert.ok(short.findings.some((finding) => /too little description/i.test(finding.title)));
  });

  it('flags a product with almost no structured attributes', () => {
    const result = run(agenticAttrsCheck, snapshot({
      products: [product({ id: 'p1', vendor: '', productType: '', tags: [], metafields: [] })],
    }));
    assert.ok(result.findings.some((finding) => /almost no structured attributes/i.test(finding.title)));
  });

  it('emits evidence rows using the AI table vocabulary', () => {
    const result = run(agenticAttrsCheck, snapshot({ products: [product({ id: 'p1' })] }));
    for (const row of result.details.evidenceRows) {
      assert.ok(['Healthy', 'Needs Work', 'Critical'].includes(row.status));
      assert.ok('signal' in row.cells && 'detail' in row.cells);
      // A product passes or it does not. 100/0 under "Coverage" was that yes/no dressed up as a
      // percentage, and a signal that was not measured has no figure at all.
      assert.equal(row.cells.coverage, undefined, `${row.id} must not carry an invented coverage figure`);
    }
  });
});

// ─── Registry wiring ─────────────────────────────────────────────────

describe('check registry', () => {
  it('registers every new CRO and AI Discovery check under the slug its page routes to', async () => {
    const { checkRegistry, implementedSubPillars } = await import('../audit-engine/index.js');
    // These slugs must match croCatalog.ts / aiCatalog.ts exactly or the results attach to no page.
    for (const slug of ['cro/returns', 'cro/options', 'cro/subscription', 'ai-discovery/feed', 'ai-discovery/agentic-attrs']) {
      assert.ok(implementedSubPillars.includes(slug), `${slug} is not registered`);
    }
    const ids = checkRegistry.map((check) => check.id);
    assert.equal(new Set(ids).size, ids.length, 'check ids must be unique');
  });
});
