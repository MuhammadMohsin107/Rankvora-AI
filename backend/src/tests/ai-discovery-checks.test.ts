// ─── AI Discovery pillar · every sub-pillar (npm test) ───────────────
//
// Eight sub-pillars, all pure functions of a snapshot — no DB, no network — which is exactly what
// the AuditCheck contract exists to allow.
//
// THE PROPERTY THESE TESTS PROTECT is the one the whole engine is built on: "we could not measure
// this" must never render as "this is fine", and it must never render as a zero either. So beside
// every detection case, each check is asserted on what it does with:
//
//   · a password-gated storefront, which answers EVERY url with HTTP 200 and the password page —
//     the single most convincing way a check can be made to fabricate a result
//   · no crawl at all
//   · no configuration (no IndexNow key, no tracked questions)
//   · real data that is genuinely insufficient (too few prompt samples to compute a rate)
//
// Nothing in this file is a fixture standing in for a feature that does not exist. Every snapshot
// here is the shape the provider really produces, and every assertion is about behaviour a
// merchant would actually see.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indexNowCheck } from '../audit-engine/checks/ai-discovery/indexnow.js';
import { indexingFreshnessCheck } from '../audit-engine/checks/ai-discovery/indexing-freshness.js';
import { promptTrackingCheck, MIN_SAMPLES } from '../audit-engine/checks/ai-discovery/prompt-tracking.js';
import { answerableQaCheck } from '../audit-engine/checks/ai-discovery/answerable-qa.js';
import { agentsMdCheck } from '../audit-engine/checks/ai-discovery/agents-md.js';
import { agenticAttrsCheck } from '../audit-engine/checks/ai-discovery/agentic-attrs.js';
import { feedCheck } from '../audit-engine/checks/ai-discovery/feed.js';
import { crawlerByName, crawlerByTypo, AI_CRAWLERS } from '../audit-engine/storefront/ai-crawlers.js';
import { extractSitemapEntries } from '../audit-engine/storefront/html-parser.js';
import { findMention } from '../services/prompt-tracking.service.js';
import { rankingStanding } from '../services/prompt-history.service.js';
import { generateAgentFiles } from '../services/llms-txt.service.js';
import type {
  SnapshotAiDiscovery,
  SnapshotProduct,
  StoreSnapshot,
} from '../audit-engine/store-data/types.js';
import type { CrawledPage, FetchedResource, StorefrontCrawl } from '../audit-engine/storefront/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';

const ORIGIN = 'https://t.myshopify.com';

/** The row-status vocabulary the checks and the evidence table share. */
const CRITICAL_STATUS = 'Critical';

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(`${check.id} unexpectedly returned a promise`);
  return result;
}

function resource(overrides: Partial<FetchedResource> = {}): FetchedResource {
  return {
    url: `${ORIGIN}/robots.txt`,
    finalUrl: `${ORIGIN}/robots.txt`,
    status: 200,
    body: '',
    contentType: 'text/plain',
    passwordGated: false,
    reason: null,
    ...overrides,
  };
}

function page(overrides: Partial<CrawledPage> & { url: string }): CrawledPage {
  return {
    finalUrl: overrides.url,
    pageType: 'product',
    resourceId: null,
    status: 200,
    redirectChain: [],
    responseTimeMs: 100,
    bytes: 1000,
    title: 'A product',
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
    textLength: 500,
    text: '',
    ...overrides,
  };
}

function crawl(overrides: Partial<StorefrontCrawl> = {}): StorefrontCrawl {
  return {
    origin: ORIGIN,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    available: true,
    unavailableReason: null,
    passwordGated: false,
    pages: [],
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
    budget: { maxPages: 40, concurrency: 3, timeoutMs: 12_000, pagesFetched: 0, truncated: false },
    warnings: [],
    ...overrides,
  };
}

function variant(overrides: Partial<SnapshotProduct['variants'][number]> = {}) {
  return { id: 'v1', sku: 'SKU-1', barcode: '5012345678900', price: 20, availableForSale: true, ...overrides };
}

function product(overrides: Partial<SnapshotProduct> & { id: string }): SnapshotProduct {
  return {
    title: `Product ${overrides.id}`,
    handle: overrides.id,
    url: `${ORIGIN}/products/${overrides.id}`,
    // Over the 40-word answerable-qa floor, and deliberately covering materials, size and care,
    // so it is HEALTHY for every check unless a test overrides it.
    bodyHtml:
      '<p>A relaxed-fit shirt made from organic cotton, measuring 70cm in length and 55cm across '
      + 'the chest, cut generously through the shoulder for an easy everyday shape. Machine wash at '
      + 'thirty degrees, line dry and warm iron on the reverse. Suitable for everyday wear, compatible '
      + 'with our standard hanger sizing, and made in Portugal from responsibly sourced yarn.</p>',
    productType: 'Shirts',
    vendor: 'Acme',
    tags: ['cotton'],
    status: 'active',
    // Published, as a live product is. The AI Discovery checks assess only what a shopper can
    // reach, so a fixture with no publication date would be (correctly) left out of every check.
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

function aiDiscovery(overrides: Partial<SnapshotAiDiscovery> = {}): SnapshotAiDiscovery {
  return { indexNowKey: null, indexNowKeySetAt: null, promptQueries: [], aiConfigured: true, ...overrides };
}

function snapshot(overrides: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
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

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/indexnow', () => {
  it('reports "not configured" as NOT MEASURED — never a 0, never "file missing" — when the store has no key', () => {
    // With no key there is no path to request, so Rankvora AI has learned nothing about the store:
    // claiming a file is missing would describe a request that was never made, and scoring 0 would
    // mark the store down for a row in Rankvora AI's own settings table. DATA-SOURCES.md: "reported as
    // not configured, never as failing".
    const result = run(indexNowCheck, snapshot({ aiDiscovery: aiDiscovery(), crawl: crawl() }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /not configured/i);
    assert.equal(result.findings.length, 0, 'an unconfigured key is not a problem found in the store');
    assert.ok(!JSON.stringify(result).includes('404'), 'must not mention a status for a request it never made');
  });

  it('verifies a published key file whose body matches the key', () => {
    const key = 'a1c9f0e2b7d84e6f9a2c5810de334f1b';
    const result = run(indexNowCheck, snapshot({
      aiDiscovery: aiDiscovery({ indexNowKey: key }),
      crawl: crawl({
        indexNowKeyFile: resource({ url: `${ORIGIN}/${key}.txt`, body: key }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, status: 200, body: '<urlset></urlset>' }),
      }),
    }));

    assert.equal(result.details.contextValue, 'Verified');
    assert.equal(result.findings.length, 0);
    assert.equal(result.score, 100);
  });

  it('fails a key file whose body does not match, and never echoes the published value', () => {
    const key = 'a1c9f0e2b7d84e6f9a2c5810de334f1b';
    const result = run(indexNowCheck, snapshot({
      aiDiscovery: aiDiscovery({ indexNowKey: key }),
      crawl: crawl({ indexNowKeyFile: resource({ url: `${ORIGIN}/${key}.txt`, body: 'deadbeefdeadbeefdeadbeefdeadbeef' }) }),
    }));

    assert.equal(result.details.contextValue, 'Not verified');
    assert.equal(result.findings[0]?.title, 'IndexNow key file is not verifiable');
    // Somebody else's key must not end up stored in this store's audit evidence.
    assert.ok(!JSON.stringify(result).includes('deadbeef'), 'must not echo the published body');
  });

  it('treats a password-gated response as not measured rather than as a verified key', () => {
    const key = 'a1c9f0e2b7d84e6f9a2c5810de334f1b';
    // The gate answers 200 with real HTML. A check reasoning from the status code would pass.
    const result = run(indexNowCheck, snapshot({
      aiDiscovery: aiDiscovery({ indexNowKey: key }),
      crawl: crawl({
        passwordGated: true,
        available: false,
        indexNowKeyFile: resource({ url: `${ORIGIN}/${key}.txt`, status: 200, body: null, passwordGated: true, reason: 'password_gated' }),
      }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /password protected/);
  });

  it('refuses to request a malformed key instead of reporting its 404', () => {
    const result = run(indexNowCheck, snapshot({
      aiDiscovery: aiDiscovery({ indexNowKey: '../../etc/passwd' }),
      crawl: crawl(),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /not valid hexadecimal/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/indexing-freshness', () => {
  const ALLOW_ALL = 'User-agent: *\nAllow: /\nSitemap: https://t.myshopify.com/sitemap.xml\n';

  it('flags a disallowed visibility crawler as critical', () => {
    const robots = 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n';
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({ robots: resource({ body: robots }) }),
    }));

    // PerplexityBot is a citation crawler: blocking it costs real visibility.
    const critical = result.findings.find((finding) => finding.title === 'Search and AI crawlers are disallowed in robots.txt');
    assert.ok(critical, 'expected a critical crawler finding');
    assert.equal(critical.severity, 'critical');
    assert.match(critical.problem, /PerplexityBot/);

    // GPTBot is a TRAINING crawler. Blocking it is a legitimate choice and must not be critical.
    const training = result.findings.find((finding) => finding.title === 'Training crawlers are disallowed');
    assert.ok(training, 'expected training crawlers reported separately');
    assert.equal(training.severity, 'low');
    assert.match(training.problem, /GPTBot/);
    assert.ok(!critical.problem.includes('GPTBot'), 'a training crawler must not be reported as a visibility loss');
  });

  it('catches a misspelled crawler name, which robots.txt silently ignores', () => {
    const robots = `${ALLOW_ALL}\nUser-agent: GPT-Bot\nDisallow: /\n`;
    const result = run(indexingFreshnessCheck, snapshot({ crawl: crawl({ robots: resource({ body: robots }) }) }));

    const finding = result.findings.find((entry) => entry.title === 'robots.txt names crawlers that do not exist');
    assert.ok(finding, 'expected the typo to be reported');
    assert.match(finding.recommendation, /Rename "GPT-Bot" to "GPTBot"/);
    // And the real GPTBot must be reported as ALLOWED, because the typo'd group never matched it.
    const gptRow = result.details.evidenceRows.find((row) => row.id === 'crawler:GPTBot');
    assert.match(String(gptRow?.cells.detail), /^Allowed/);
  });

  it('reports a live HTTP 403 to a crawler user-agent, which robots.txt cannot reveal', () => {
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({
        robots: resource({ body: ALLOW_ALL }),
        botAccess: [
          { bot: 'GPTBot', userAgent: 'GPTBot/1.2', status: 403, bytes: 120, passwordGated: false, reason: null },
          { bot: 'Googlebot', userAgent: 'Googlebot/2.1', status: 200, bytes: 48_000, passwordGated: false, reason: null },
        ],
      }),
    }));

    const finding = result.findings.find((entry) => entry.title === 'Your server refuses crawler user-agents');
    assert.ok(finding, 'expected the edge block to be reported');
    assert.match(finding.problem, /GPTBot received HTTP 403/);
    assert.ok(!finding.problem.includes('Googlebot'), 'a 200 must not be reported as a block');
    // The limits of the method are stated rather than implied.
    assert.match(finding.recommendation, /does not prove the verified crawler is served/);
  });

  it('never reports a failed probe as a block', () => {
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({
        robots: resource({ body: ALLOW_ALL }),
        botAccess: [{ bot: 'GPTBot', userAgent: 'GPTBot/1.2', status: 0, bytes: 0, passwordGated: false, reason: 'timeout' }],
      }),
    }));

    assert.ok(
      !result.findings.some((finding) => finding.title === 'Your server refuses crawler user-agents'),
      'a timeout is not evidence of a block',
    );
  });

  it('detects a sitemap lastmod older than Shopify’s own updatedAt', () => {
    const url = `${ORIGIN}/products/p1`;
    const result = run(indexingFreshnessCheck, snapshot({
      products: [product({ id: 'p1', updatedAt: '2026-01-10T00:00:00Z' })],
      crawl: crawl({
        robots: resource({ body: ALLOW_ALL }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
        sitemapRecords: [{ loc: url, lastmod: '2025-06-01T00:00:00Z' }],
        sitemapEntries: [url],
      }),
    }));

    const finding = result.findings.find((entry) => entry.title === 'Sitemap last-modified dates disagree with the catalogue');
    assert.ok(finding, 'expected a stale lastmod to be reported');
  });

  it('does not report staleness when the sitemap agrees with the catalogue', () => {
    const url = `${ORIGIN}/products/p1`;
    const result = run(indexingFreshnessCheck, snapshot({
      products: [product({ id: 'p1', updatedAt: '2026-01-10T00:00:00Z' })],
      crawl: crawl({
        robots: resource({ body: ALLOW_ALL }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
        sitemapRecords: [{ loc: url, lastmod: '2026-01-10T00:00:00Z' }],
        sitemapEntries: [url],
      }),
    }));

    assert.ok(!result.findings.some((finding) => finding.title.includes('disagree with the catalogue')));
  });

  it('reports unavailable when the storefront is gated, rather than "nothing is blocked"', () => {
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({ passwordGated: true, available: false, robots: resource({ status: 200, body: null, passwordGated: true }) }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /password protected/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/prompt-tracking', () => {
  const query = (id: number, mentions: number, total: number) => ({
    id,
    query: `question ${id}`,
    brandTerm: 'Acme',
    active: true,
    observations: Array.from({ length: total }, (_, index) => ({
      model: 'gpt-test',
      mentioned: index < mentions,
      mentionContext: index < mentions ? 'Acme sells these.' : null,
      checkedAt: '2026-01-01T00:00:00Z',
    })),
  });

  it('reports unavailable — never 0% — when no AI provider is configured', () => {
    const result = run(promptTrackingCheck, snapshot({
      aiDiscovery: aiDiscovery({ aiConfigured: false, promptQueries: [query(1, 0, 10)] }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /No AI provider is configured/);
  });

  it('reports unavailable when no questions are tracked, and refuses to invent any', () => {
    const result = run(promptTrackingCheck, snapshot({ aiDiscovery: aiDiscovery() }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /will not invent them/);
  });

  it('withholds a score until a question has enough real samples', () => {
    // One miss out of one check is a coin flip, not evidence of invisibility.
    const result = run(promptTrackingCheck, snapshot({
      aiDiscovery: aiDiscovery({ promptQueries: [query(1, 0, MIN_SAMPLES - 1)] }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', new RegExp(`${MIN_SAMPLES} checks`));
    // The real observations are still shown — they are genuine, just not yet a rate.
    assert.equal(result.details.evidenceRows.length, 1);
    assert.match(String(result.details.evidenceRows[0]?.cells.detail), /too few to report a rate/);
  });

  it('distinguishes "never checked" from "checked and never mentioned"', () => {
    const result = run(promptTrackingCheck, snapshot({
      aiDiscovery: aiDiscovery({ promptQueries: [query(1, 0, 0), query(2, 0, 10)] }),
    }));

    const never = result.details.evidenceRows.find((row) => row.id === 'query:1');
    const checked = result.details.evidenceRows.find((row) => row.id === 'query:2');
    assert.equal(never?.cells.detail, 'Not checked yet');
    assert.match(String(checked?.cells.detail), /Mentioned in 0 of 10 checks/);
  });

  it('reports a rate and never a rank', () => {
    const result = run(promptTrackingCheck, snapshot({
      aiDiscovery: aiDiscovery({ promptQueries: [query(1, 6, 10), query(2, 0, 10)] }),
    }));

    assert.equal(result.status, 'ok');
    assert.equal(result.analyzedCount, 2);
    assert.equal(result.healthyCount, 1);
    const serialized = JSON.stringify(result);
    assert.ok(!/\bposition \d/i.test(serialized), 'must never report a ranking position');
    assert.ok(!/\brank(ed|ing)? #?\d/i.test(serialized), 'must never report a rank');
    assert.match(result.details.summary, /rates, not rankings/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('prompt-tracking mention matching', () => {
  it('matches on word boundaries so a substring is not a mention', () => {
    assert.equal(findMention('The architecture is modern.', 'Arc'), null);
    assert.ok(findMention('We recommend Arc for this.', 'Arc'));
  });

  it('handles brands with regex-significant characters', () => {
    // Without escaping, "M+S" is a valid pattern meaning "one or more M followed by S".
    assert.equal(findMention('MMMS is not the brand.', 'M+S'), null);
    assert.ok(findMention('Try M+S for this.', 'M+S'));
  });

  it('matches a brand that cannot carry a word boundary', () => {
    assert.ok(findMention('We like +Beauty products.', '+Beauty'));
  });

  it('quotes the surrounding sentence so the merchant sees what counted', () => {
    const context = findMention('Some preamble. Acme Coffee is a good option for this. More text.', 'Acme');
    assert.ok(context?.includes('Acme Coffee is a good option'));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/answerable-qa', () => {
  it('separates an empty description from a long one that answers nothing', () => {
    const result = run(answerableQaCheck, snapshot({
      products: [
        product({ id: 'empty', bodyHtml: '' }),
        // Long, fluent, and containing no fact a shopper could qualify on.
        product({ id: 'fluffy', bodyHtml: `<p>${'An elevated everyday essential that speaks to the modern soul and captures a feeling of quiet confidence wherever the day takes you. '.repeat(3)}</p>` }),
        product({ id: 'good' }),
      ],
    }));

    const empty = result.findings.find((finding) => finding.title === 'Products with no description at all');
    const shallow = result.findings.find((finding) => finding.title === 'Descriptions that read well but answer nothing specific');
    assert.equal(empty?.affectedCount, 1);
    assert.equal(shallow?.affectedCount, 1);
    assert.equal(result.healthyCount, 1);
  });

  it('reports FAQ schema as not measured on a gated storefront, rather than as absent', () => {
    const result = run(answerableQaCheck, snapshot({
      products: [product({ id: 'p1' })],
      crawl: crawl({ passwordGated: true, available: false }),
    }));

    const row = result.details.evidenceRows.find((entry) => entry.id === 'schema:faq');
    assert.match(String(row?.cells.detail), /Not measured — the storefront is password protected/);
    // No figure for something never read — not even 0.
    assert.equal(row?.cells.coverage, undefined);
    // Never a finding claiming the markup is ABSENT — Rankvora AI never looked.
    assert.ok(!result.findings.some((finding) => finding.title.includes('FAQ structured data')));
    // But the row is owned by a finding that says it was not checked, and costs nothing.
    const notChecked = result.findings.find((finding) => finding.title === 'FAQ markup could not be checked');
    assert.equal(notChecked?.scoreLift, 0);
    assert.deepEqual(notChecked?.evidenceRows?.map((entry) => entry.id), ['schema:faq']);
  });

  it('with crawling switched off server-wide, says so in the summary and adds no finding', () => {
    // An operator setting is not something the merchant can act on; a "could not be checked" item
    // on every audit would be noise.
    const result = run(answerableQaCheck, snapshot({ products: [product({ id: 'p1' })] }));
    assert.match(result.details.summary, /not measured on this run — storefront crawling is switched off/);
    assert.ok(!result.details.evidenceRows.some((entry) => entry.id === 'schema:faq'));
    assert.equal(result.findings.length, 0);
  });

  it('detects rendered FAQPage markup from the crawl', () => {
    const withFaq = run(answerableQaCheck, snapshot({
      products: [product({ id: 'p1' })],
      coverage: { ...snapshot().coverage, crawl: true },
      crawl: crawl({
        pages: [page({ url: `${ORIGIN}/products/p1`, jsonLd: [{ types: ['FAQPage'], data: {}, parseError: null }] })],
      }),
    }));
    assert.ok(!withFaq.findings.some((finding) => finding.title.includes('No FAQ structured data')));

    const without = run(answerableQaCheck, snapshot({
      products: [product({ id: 'p1' })],
      coverage: { ...snapshot().coverage, crawl: true },
      crawl: crawl({ pages: [page({ url: `${ORIGIN}/products/p1`, jsonLd: [{ types: ['Product'], data: {}, parseError: null }] })] }),
    }));
    assert.ok(without.findings.some((finding) => finding.title === 'No FAQ structured data on any crawled page'));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/agentic-attrs · rendered offer half', () => {
  const productJsonLd = (offers: unknown) => ({
    types: ['Product'],
    data: { '@type': 'Product', name: 'A product', offers },
    parseError: null,
  });

  it('flags a priced offer that never says whether the product can be bought', () => {
    const result = run(agenticAttrsCheck, snapshot({
      products: [product({ id: 'p1' })],
      coverage: { ...snapshot().coverage, crawl: true },
      crawl: crawl({
        pages: [page({ url: `${ORIGIN}/products/p1`, jsonLd: [productJsonLd({ '@type': 'Offer', price: '20.00', priceCurrency: 'GBP' })] })],
      }),
    }));

    const finding = result.findings.find((entry) => entry.title === 'Rendered product pages without a complete offer');
    assert.ok(finding, 'expected the incomplete offer to be reported');
    assert.match(finding.evidence[0] ?? '', /Offer has no availability/);
  });

  // The fixture carries priceCurrency. It used to leave it out and still pass, because the check
  // never looked for a currency — the very gap the recommendation told merchants to close.
  it('passes a complete offer, including one nested in @graph', () => {
    const result = run(agenticAttrsCheck, snapshot({
      products: [product({ id: 'p1' })],
      coverage: { ...snapshot().coverage, crawl: true },
      crawl: crawl({
        pages: [page({
          url: `${ORIGIN}/products/p1`,
          jsonLd: [{
            types: ['Product', 'Offer'],
            data: { '@graph': [{ '@type': 'Product', offers: { '@type': 'Offer', price: 20, priceCurrency: 'GBP', availability: 'https://schema.org/InStock' } }] },
            parseError: null,
          }],
        })],
      }),
    }));

    assert.ok(!result.findings.some((finding) => finding.title.includes('Rendered product pages')));
  });

  it('reports the rendered half as not measured on a gated storefront, with no invented figure', () => {
    const result = run(agenticAttrsCheck, snapshot({
      products: [product({ id: 'p1' })],
      crawl: crawl({ passwordGated: true, available: false }),
    }));

    const row = result.details.evidenceRows.find((entry) => entry.id === 'rendered:offers');
    assert.match(String(row?.cells.detail), /Not measured — the storefront is password protected/);
    assert.equal(row?.cells.coverage, undefined, 'nothing was read, so there is no coverage — not even 0');
    const notChecked = result.findings.find((finding) => finding.title === 'Rendered offer data could not be checked');
    assert.equal(notChecked?.scoreLift, 0);
    assert.equal(result.score, 100, 'an unread signal must not cost the store a point');
  });

  it('with no crawl, states it in the summary and no longer claims Rankvora AI cannot crawl', () => {
    const result = run(agenticAttrsCheck, snapshot({ products: [product({ id: 'p1' })] }));

    assert.match(result.details.summary, /not measured on this run — storefront crawling is switched off/);
    // Regression guard: this summary used to state that Rankvora AI does not run a storefront crawl,
    // which stopped being true once the crawler shipped and was shown to merchants for months.
    assert.ok(
      !/does not run (that crawl|yet)/i.test(result.details.summary),
      'the summary must not claim Rankvora AI cannot crawl',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/agents-md · gate handling', () => {
  it('never reads the password page as a published file', () => {
    // A gated store returns 200 and ~11KB of real HTML for /llms.txt. This is the fabrication the
    // passwordGated flag exists to prevent.
    const gated = resource({ status: 200, body: null, passwordGated: true, reason: 'password_gated' });
    const result = run(agentsMdCheck, snapshot({
      crawl: crawl({
        passwordGated: true,
        available: false,
        agentsMd: { ...gated, url: `${ORIGIN}/agents.md` },
        llmsTxt: { ...gated, url: `${ORIGIN}/llms.txt` },
      }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /password protected/);
  });

  it('treats a 200 that returns HTML as "not published", not as a file', () => {
    const result = run(agentsMdCheck, snapshot({
      crawl: crawl({
        agentsMd: resource({ url: `${ORIGIN}/agents.md`, status: 200, body: '<!doctype html><html><body>Not found</body></html>', contentType: 'text/html' }),
        llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, status: 404, body: null }),
      }),
    }));

    assert.equal(result.status, 'ok');
    assert.equal(result.healthyCount, 0);
    assert.match(result.findings[0]?.title ?? '', /No agent-readable instructions published/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/agents-md · the size it reports', () => {
  // THE PROPERTY: a figure labelled "bytes" is bytes. The check used `String.length`, which counts
  // UTF-16 code units, so the number was always measured and always mis-labelled — the hardest
  // kind of error to catch, because nothing on screen looks wrong.

  function published(body: string) {
    return run(agentsMdCheck, snapshot({
      crawl: crawl({
        agentsMd: resource({ url: `${ORIGIN}/agents.md`, status: 200, body, contentType: 'text/markdown' }),
        llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, status: 404, body: null }),
      }),
    }));
  }

  it('counts bytes, not characters', () => {
    // Sixty ASCII characters and five em dashes: 65 characters, 75 bytes. The card used to say 65.
    const body = `${'a'.repeat(60)}—————`;
    assert.notEqual(body.length, Buffer.byteLength(body, 'utf8'), 'the fixture must contain multi-byte characters');

    const row = published(body).details.evidenceRows.find((entry) => entry.id === 'file:agents.md');
    assert.equal(String(row?.cells.detail), `Published, ${Buffer.byteLength(body, 'utf8')} bytes`);
  });

  it('measures the useful-content threshold in bytes too, so a short non-Latin file is not called thin', () => {
    // A real llms.txt for a Chinese store: few characters, plenty of bytes. Measured as characters
    // it fell under MIN_USEFUL_BYTES, and the merchant was told their published file was almost
    // empty — a wrong verdict, not just a wrong number.
    const body = '本店销售天然营养补充剂与健康食品，欢迎选购。';
    assert.ok(body.length < 40, 'the fixture must be short in characters');
    assert.ok(Buffer.byteLength(body, 'utf8') > 40, 'and substantial in bytes');

    const result = published(body);
    assert.equal(result.healthyCount, 1);
    assert.ok(
      !result.findings.some((finding) => /too thin/i.test(finding.title)),
      'a file above the byte threshold must not be reported as thin',
    );
  });

  it('writes no display characters and no invented coverage into a healthy row', () => {
    const row = published('a'.repeat(200)).details.evidenceRows.find((entry) => entry.id === 'file:agents.md');
    // The em dash belongs to the renderer. A check that writes it is putting presentation in data.
    assert.equal(row?.cells.recommendation, '');
    // A single file is published or it is not; 100 was a percentage nobody measured.
    assert.equal(row?.cells.coverage, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/agents-md · a file that could not be read', () => {
  function partial() {
    return run(agentsMdCheck, snapshot({
      crawl: crawl({
        agentsMd: resource({ url: `${ORIGIN}/agents.md`, status: 200, body: 'a'.repeat(200), contentType: 'text/markdown' }),
        llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, status: 0, body: null, reason: 'timeout' }),
      }),
    }));
  }

  it('is excluded from the counts, so it is never scored as a failure', () => {
    const result = partial();
    assert.equal(result.analyzedCount, 1, 'only the file Rankvora AI actually read is analyzed');
    assert.equal(result.healthyCount, 1);
    assert.equal(result.score, 100, 'an unread file must not cost the store a point');
  });

  it('raises a finding that owns its own row, rather than leaving the row orphaned', () => {
    // The row carries NEEDS_WORK — the only word the shared vocabulary has for "needs attention" —
    // so without a finding to claim it the table offered a filter the issue total said was empty,
    // and Investigate opened whichever unrelated finding happened to share that status.
    const result = partial();
    const finding = result.findings.find((entry) => /could not be checked/i.test(entry.title));
    assert.ok(finding, 'an unreadable file must produce a finding');
    assert.equal(finding?.scoreLift, 0, 'reading the file changes what is known, not what is passing');
    assert.deepEqual(finding?.evidenceRows?.map((row) => row.id), ['file:llms.txt']);
    assert.equal(finding?.details.issueType, finding?.evidenceRows?.[0]?.status);
  });

  it('says so in the summary rather than implying the file is missing', () => {
    const result = partial();
    assert.match(result.details.summary, /\/llms\.txt could not be checked/);
    assert.equal(result.details.healthChip, '100% healthy', 'a denominator of one cannot carry a decimal place');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-discovery/feed · unchanged behaviour', () => {
  it('still reports an unpriced variant as critical', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', variants: [variant({ price: 0 })] })],
    }));
    assert.equal(result.findings[0]?.severity, 'critical');
    assert.match(result.findings[0]?.title ?? '', /unpriced variant/);
  });

  it('reports unavailable for a store with no products rather than scoring zero', () => {
    const result = run(feedCheck, snapshot({ products: [] }));
    assert.equal(result.status, 'unavailable');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ai-crawlers reference', () => {
  it('matches canonical names exactly and case-insensitively', () => {
    assert.equal(crawlerByName('GPTBot')?.vendor, 'OpenAI');
    assert.equal(crawlerByName('gptbot')?.vendor, 'OpenAI');
    assert.equal(crawlerByName('NotARealBot'), null);
  });

  it('maps a known typo to the crawler it was meant to be', () => {
    assert.equal(crawlerByTypo('GPT-Bot')?.name, 'GPTBot');
    assert.equal(crawlerByTypo('Claude-Bot')?.name, 'ClaudeBot');
  });

  it('does not call a real, retired Google crawler token a misspelling', () => {
    // Googlebot-Mobile was Google's own feature-phone crawler. A rule naming it is deliberate.
    assert.equal(crawlerByTypo('Googlebot-Mobile'), null);
  });

  it('never reports a correctly spelled name as a typo', () => {
    for (const crawler of AI_CRAWLERS) {
      assert.equal(crawlerByTypo(crawler.name), null, `${crawler.name} must not be treated as a misspelling`);
    }
  });

  it('only claims a live probe for crawlers that publish a real user-agent', () => {
    // Google-Extended is a robots.txt token with no user-agent of its own. Probing it would be a
    // request no real crawler makes, reported as though it tested something.
    assert.equal(crawlerByName('Google-Extended')?.userAgent, null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('finding issueType matches its own evidence rows', () => {
  // The sub-pillar page filters the evidence table BY a finding's issueType — that is what the
  // "Review evidence" button and the health breakdown both do. When a check hardcodes an issueType
  // that none of its own rows carry, the table filters down to nothing and the merchant lands on
  // "Nothing matches these filters" after pressing a button whose entire purpose is to show
  // evidence. The UI now falls back to 'All', but a check should not rely on that rescue.

  /** Every finding that ships evidence rows must name a status at least one of them carries. */
  function assertRowsMatchIssueType(result: SubPillarResult, checkId: string) {
    for (const finding of result.findings) {
      const rows = finding.evidenceRows ?? [];
      if (rows.length === 0) continue;
      const statuses = new Set(rows.map((row) => row.status));
      assert.ok(
        statuses.has(finding.details.issueType),
        `${checkId} · "${finding.title}" declares issueType "${finding.details.issueType}" but its rows carry ${[...statuses].join(', ')}`,
      );
    }
  }

  it('holds when a sitemap publishes no lastmod at all', () => {
    // The regression that prompted this: the finding hardcoded 'Needs Work' while the row goes
    // CRITICAL at zero coverage, so filtering to the finding matched none of its own evidence.
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({
        robots: resource({ body: 'User-agent: *\nAllow: /\n' }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
        // Entries present, none carrying a lastmod → zero coverage → CRITICAL row.
        sitemapRecords: [{ loc: `${ORIGIN}/products/p1`, lastmod: null }, { loc: `${ORIGIN}/products/p2`, lastmod: null }],
        sitemapEntries: [`${ORIGIN}/products/p1`, `${ORIGIN}/products/p2`],
      }),
    }));

    const finding = result.findings.find((entry) => entry.title === 'Sitemap does not publish reliable last-modified dates');
    assert.ok(finding, 'expected the missing-lastmod finding');
    assert.equal(finding.details.issueType, CRITICAL_STATUS);
    assertRowsMatchIssueType(result, 'indexing-freshness');
  });

  it('holds when only some entries publish a lastmod', () => {
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({
        robots: resource({ body: 'User-agent: *\nAllow: /\n' }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
        sitemapRecords: [{ loc: `${ORIGIN}/products/p1`, lastmod: '2026-01-01' }, { loc: `${ORIGIN}/products/p2`, lastmod: null }],
        sitemapEntries: [`${ORIGIN}/products/p1`, `${ORIGIN}/products/p2`],
      }),
    }));

    assertRowsMatchIssueType(result, 'indexing-freshness');
  });

  it('holds across every AI Discovery check on a store with real problems', () => {
    // A store that fails each check in a different way, so most findings are produced at once.
    const broken = snapshot({
      products: [
        product({ id: 'p1', bodyHtml: '', variants: [variant({ barcode: null, sku: null, availableForSale: false })] }),
        product({ id: 'p2', vendor: '', productType: '', variants: [variant({ price: 0 })] }),
      ],
      coverage: { ...snapshot().coverage, crawl: true },
      aiDiscovery: aiDiscovery({
        indexNowKey: 'a1c9f0e2b7d84e6f9a2c5810de334f1b',
        promptQueries: [{
          id: 1,
          query: 'best thing',
          brandTerm: 'Acme',
          active: true,
          observations: Array.from({ length: 10 }, () => ({ model: 'm', mentioned: false, mentionContext: null, checkedAt: '2026-01-01T00:00:00Z' })),
        }],
      }),
      crawl: crawl({
        robots: resource({ body: 'User-agent: *\nAllow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPT-Bot\nDisallow: /\n' }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, status: 404, body: null }),
        agentsMd: resource({ url: `${ORIGIN}/agents.md`, status: 404, body: null }),
        llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, status: 404, body: null }),
        indexNowKeyFile: resource({ url: `${ORIGIN}/a1c9f0e2b7d84e6f9a2c5810de334f1b.txt`, status: 404, body: null }),
        botAccess: [{ bot: 'GPTBot', userAgent: 'GPTBot/1.2', status: 403, bytes: 100, passwordGated: false, reason: null }],
        pages: [page({ url: `${ORIGIN}/products/p1`, jsonLd: [] })],
      }),
    });

    for (const check of [agentsMdCheck, agenticAttrsCheck, feedCheck, answerableQaCheck, indexNowCheck, indexingFreshnessCheck, promptTrackingCheck]) {
      const result = run(check, broken);
      assert.ok(result.findings.length >= 0, `${check.id} ran`);
      assertRowsMatchIssueType(result, check.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('only what a shopper can reach is assessed', () => {
  // A draft or archived product's storefront URL answers 404. Counting it in an AI Discovery
  // figure measures a page nobody can see; listing it in llms.txt publishes a dead link.
  const draft = () => product({ id: 'draft', title: 'The Draft Snowboard', status: 'draft', publishedAt: null, bodyHtml: '' });
  const archived = () => product({ id: 'archived', title: 'The Archived Snowboard', status: 'archived', bodyHtml: '' });
  const hidden = () => product({ id: 'hidden', title: 'The Hidden Snowboard', publishedAt: null, bodyHtml: '' });

  it('leaves draft, archived and unpublished products out of all three product checks', () => {
    for (const check of [agenticAttrsCheck, feedCheck, answerableQaCheck]) {
      const result = run(check, snapshot({ products: [product({ id: 'live' }), draft(), archived(), hidden()] }));
      const productRows = result.details.evidenceRows.filter((row) => row.id.startsWith('product:'));
      assert.deepEqual(productRows.map((row) => row.id), ['product:live'], `${check.id} assessed an unreachable product`);
      assert.match(result.details.summary, /3 draft, archived or unpublished products were left out/, `${check.id} must say what it left out`);
    }
  });

  it('reports unavailable — never a zero — when nothing is published', () => {
    for (const check of [agenticAttrsCheck, feedCheck, answerableQaCheck]) {
      const result = run(check, snapshot({ products: [draft(), archived()] }));
      assert.equal(result.status, 'unavailable', `${check.id} scored a store with nothing published`);
      assert.match(result.details.unavailableReason ?? '', /published to the online store/);
    }
  });

  it('keeps unpublished products out of the generated llms.txt and says so', () => {
    const files = generateAgentFiles(snapshot({ products: [product({ id: 'live' }), draft(), archived()] }));
    assert.ok(files.llmsTxt.content.includes('/products/live'));
    assert.ok(!files.llmsTxt.content.includes('Draft Snowboard'), 'a draft product must not be published as a link');
    assert.ok(!files.llmsTxt.content.includes('Archived Snowboard'));
    assert.equal(files.source.products, 1);
    assert.equal(files.source.unpublishedProducts, 2);
    assert.ok(files.llmsTxt.omitted.some((line) => /2 draft, archived or unpublished products/.test(line)));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('generated files keep every link where it really points', () => {
  it('writes storefront links as paths and a policy on another host in full', () => {
    const files = generateAgentFiles(snapshot({
      products: [product({ id: 'live' })],
      policies: [{ type: 'privacy_policy', title: 'Privacy policy', body: 'We collect only what we need to fulfil your order.', url: 'https://checkout.shopify.com/1037/policies/57.html' }],
    }));
    assert.ok(files.llmsTxt.content.includes('](/products/live)'), 'a storefront URL stays root-relative');
    // Cutting the host off turned this into a path on the storefront that does not exist there.
    assert.ok(files.llmsTxt.content.includes('](https://checkout.shopify.com/1037/policies/57.html)'));
    assert.ok(files.agentsMd.content.includes('https://checkout.shopify.com/1037/policies/57.html'));
    assert.ok(files.llmsTxt.includes.includes('1 shop policy'), 'one policy is "1 shop policy", not "1 shop policies"');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('no invented figure or display character reaches the audit data', () => {
  // Every AI Discovery check, on a store where most things are healthy: the case where a check is
  // most tempted to fill a cell with "—" or a yes/no dressed as 100.
  const healthyStore = () => snapshot({
    products: [product({ id: 'p1' })],
    aiDiscovery: aiDiscovery({
      indexNowKey: 'a1c9f0e2b7d84e6f9a2c5810de334f1b',
      promptQueries: [{
        id: 1, query: 'best shirt', brandTerm: 'Acme', active: true,
        observations: Array.from({ length: 6 }, () => ({ model: 'm', mentioned: true, mentionContext: 'Acme makes it.', checkedAt: '2026-01-01T00:00:00Z' })),
      }],
    }),
    crawl: crawl({
      robots: resource({ body: 'User-agent: *\nAllow: /\n' }),
      sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
      sitemapRecords: [{ loc: `${ORIGIN}/products/p1`, lastmod: '2026-01-01T00:00:00Z' }],
      sitemapEntries: [`${ORIGIN}/products/p1`],
      agentsMd: resource({ url: `${ORIGIN}/agents.md`, body: 'a'.repeat(200), contentType: 'text/markdown' }),
      llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, body: 'b'.repeat(200) }),
      indexNowKeyFile: resource({ url: `${ORIGIN}/a1c9f0e2b7d84e6f9a2c5810de334f1b.txt`, body: 'a1c9f0e2b7d84e6f9a2c5810de334f1b' }),
    }),
  });

  it('writes no em dash as a value anywhere', () => {
    for (const check of [agentsMdCheck, agenticAttrsCheck, feedCheck, answerableQaCheck, indexNowCheck, indexingFreshnessCheck, promptTrackingCheck]) {
      const result = run(check, healthyStore());
      for (const row of result.details.evidenceRows) {
        for (const [key, value] of Object.entries(row.cells)) {
          assert.notEqual(value, '—', `${check.id} · ${row.id}.${key} holds a display character`);
        }
        assert.notEqual(row.suggested?.value, '—', `${check.id} · ${row.id} suggests "—"`);
      }
    }
  });

  it('never puts 100 or 0 in Coverage for a yes/no signal', () => {
    for (const check of [agenticAttrsCheck, feedCheck, answerableQaCheck, indexNowCheck]) {
      const result = run(check, healthyStore());
      for (const row of result.details.evidenceRows.filter((entry) => entry.id.startsWith('product:') || entry.id.startsWith('indexnow:'))) {
        assert.equal(row.cells.coverage, undefined, `${check.id} · ${row.id} carries an invented coverage`);
      }
    }
  });

  it('carries the real lastmod percentage the row itself states', () => {
    const result = run(indexingFreshnessCheck, snapshot({
      crawl: crawl({
        robots: resource({ body: 'User-agent: *\nAllow: /\n' }),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
        sitemapRecords: [
          { loc: `${ORIGIN}/a`, lastmod: '2026-01-01' }, { loc: `${ORIGIN}/b`, lastmod: '2026-01-01' },
          { loc: `${ORIGIN}/c`, lastmod: '2026-01-01' }, { loc: `${ORIGIN}/d`, lastmod: null },
        ],
      }),
    }));
    const row = result.details.evidenceRows.find((entry) => entry.id === 'lastmod-coverage');
    // The detail says 75%; the Coverage cell used to say 0 on the same line.
    assert.match(String(row?.cells.detail), /\(75%\)/);
    assert.equal(row?.cells.coverage, 75);
  });

  it('gives a question with no rate no coverage figure', () => {
    const result = run(promptTrackingCheck, snapshot({
      aiDiscovery: aiDiscovery({
        promptQueries: [
          { id: 1, query: 'asked enough', brandTerm: 'Acme', active: true, observations: Array.from({ length: 6 }, () => ({ model: 'm', mentioned: false, mentionContext: null, checkedAt: '2026-01-01T00:00:00Z' })) },
          { id: 2, query: 'never asked', brandTerm: 'Acme', active: true, observations: [] },
        ],
      }),
    }));
    const never = result.details.evidenceRows.find((row) => row.id === 'query:2');
    const asked = result.details.evidenceRows.find((row) => row.id === 'query:1');
    assert.equal(never?.cells.coverage, undefined, 'never asked is not 0%');
    assert.equal(asked?.cells.coverage, 0, 'asked six times and never named IS 0%');
    // Not "the next scheduled run" — scheduled analysis can be switched off.
    assert.doesNotMatch(String(never?.cells.recommendation), /scheduled/);
    // The unsettled row is owned by a finding that costs nothing.
    const gathering = result.findings.find((finding) => /still gathering/i.test(finding.title));
    assert.equal(gathering?.scoreLift, 0);
    assert.deepEqual(gathering?.evidenceRows?.map((row) => row.id), ['query:2']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('a file that redirects to another host', () => {
  // The usual Shopify workaround: a file under Content → Files, and a URL redirect from the root
  // path to it on Shopify's CDN. The crawler does not follow the hop, and the checks used to report
  // that as "The server answered with HTTP 0" — a response no server ever sent.
  const key = '03598eb2806f5339eebeaaf1101b0c05';
  const redirected = (path: string) => resource({
    url: `${ORIGIN}${path}`,
    finalUrl: `https://cdn.shopify.com/s/files/1/1037/files${path}`,
    status: 0,
    body: null,
    reason: 'blocked',
  });

  it('IndexNow names where the key file points and never reports HTTP 0', () => {
    const result = run(indexNowCheck, snapshot({
      aiDiscovery: aiDiscovery({ indexNowKey: key }),
      crawl: crawl({
        indexNowKeyFile: redirected(`/${key}.txt`),
        sitemap: resource({ url: `${ORIGIN}/sitemap.xml`, body: '<urlset></urlset>' }),
      }),
    }));

    assert.ok(!JSON.stringify(result).includes('HTTP 0'), 'no server answered HTTP 0');
    const row = result.details.evidenceRows.find((entry) => entry.id === 'indexnow:file');
    assert.match(String(row?.cells.detail), /Redirects to cdn\.shopify\.com/);
    const finding = result.findings.find((entry) => entry.title === 'IndexNow key file redirects to another host');
    assert.ok(finding, 'the redirect is explained');
    assert.equal(finding?.scoreLift, 0, 'not a failure — Rankvora AI cannot know whether IndexNow accepts it');
    assert.match(finding?.recommendation ?? '', /api\.indexnow\.org/);
    assert.ok(!result.findings.some((entry) => entry.title === 'IndexNow key file is not verifiable'));
    // And nowhere recommends an app proxy, which cannot cover /products/.
    assert.ok(!/app proxy/i.test(JSON.stringify(result)));
  });

  it('agents.md reports the redirect instead of HTTP 0', () => {
    const result = run(agentsMdCheck, snapshot({
      crawl: crawl({ agentsMd: redirected('/agents.md'), llmsTxt: resource({ url: `${ORIGIN}/llms.txt`, status: 404, body: null }) }),
    }));
    assert.ok(!JSON.stringify(result).includes('HTTP 0'));
    const row = result.details.evidenceRows.find((entry) => entry.id === 'file:agents.md');
    assert.match(String(row?.cells.detail), /Redirects to cdn\.shopify\.com/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('figures that used to be computed from the wrong total', () => {
  it('"Products with stock" is a share of products, not of products plus a signal', () => {
    // Ten products, all in stock, and a rendered product page — which adds one signal to
    // `analyzed`. Dividing by it reported 91%.
    const products = Array.from({ length: 10 }, (_, index) => product({ id: `p${index}` }));
    const result = run(agenticAttrsCheck, snapshot({
      products,
      crawl: crawl({ pages: [page({ url: `${ORIGIN}/products/p0` })] }),
    }));
    assert.equal(result.details.contextValue, '100%');
  });

  it('names the SKU that is actually repeated, with its own count', () => {
    const result = run(feedCheck, snapshot({
      products: [product({ id: 'p1', variantCount: 3, variants: [variant({ id: 'v1', sku: 'A1' }), variant({ id: 'v2', sku: 'B2' }), variant({ id: 'v3', sku: 'B2' })] })],
    }));
    const finding = result.findings.find((entry) => entry.title === 'Products where several variants share one SKU');
    // It used to say "3 variants sharing SKU A1": the wrong SKU and the wrong count.
    assert.match(finding?.evidence[0] ?? '', /SKU B2 repeats on 2 variants/);
  });

  it('reads the placement denominator from the same answers as the rank', () => {
    // Named 3rd of 3 once; two more answers named nobody at all. Averaged over all three answers
    // the denominator was 1.0, and the card read "3.0 of 1.0".
    const standing = rankingStanding([
      { mentioned: true, mentionPosition: '0.8000', brandRank: 3, brandsNamed: 3, competitorsNamed: [{ term: 'aurora', position: 0.1 }, { term: 'birch', position: 0.3 }] },
      { mentioned: false, mentionPosition: null, brandRank: null, brandsNamed: 0, competitorsNamed: [] },
      { mentioned: false, mentionPosition: null, brandRank: null, brandsNamed: 0, competitorsNamed: [] },
    ]);
    assert.equal(standing.averageRank, 3);
    assert.equal(standing.averageBrandsNamed, 3);
    assert.ok((standing.averageRank ?? 0) <= (standing.averageBrandsNamed ?? 0), 'a rank can never exceed its own denominator');
    assert.equal(standing.rankedAnswers, 3);
  });

  it('reports no placement at all when the store was never named', () => {
    const standing = rankingStanding([
      { mentioned: false, mentionPosition: null, brandRank: null, brandsNamed: 1, competitorsNamed: [{ term: 'aurora', position: 0.2 }] },
    ]);
    assert.equal(standing.averageRank, null);
    assert.equal(standing.averageBrandsNamed, null, 'no denominator is invented for a rank that does not exist');
    assert.equal(standing.answersLostEntirely, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('sitemap lastmod extraction', () => {
  it('pairs each loc with its own lastmod rather than positionally', () => {
    // The middle entry has no lastmod. A parser collecting all <loc> and all <lastmod> separately
    // would attach /c's date to /b.
    const xml = `
      <urlset>
        <url><loc>https://t.myshopify.com/a</loc><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://t.myshopify.com/b</loc></url>
        <url><loc>https://t.myshopify.com/c</loc><lastmod>2026-02-02</lastmod></url>
      </urlset>`;

    const entries = extractSitemapEntries(xml);
    assert.deepEqual(entries, [
      { loc: 'https://t.myshopify.com/a', lastmod: '2026-01-01' },
      { loc: 'https://t.myshopify.com/b', lastmod: null },
      { loc: 'https://t.myshopify.com/c', lastmod: '2026-02-02' },
    ]);
  });

  it('returns nothing for a sitemap with no entries', () => {
    assert.deepEqual(extractSitemapEntries('<urlset></urlset>'), []);
  });
});
