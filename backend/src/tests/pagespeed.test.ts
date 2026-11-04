// ─── PageSpeed Insights · connector and Core Web Vitals check (npm test) ───
//
// THE PROPERTY THESE TESTS PROTECT is the one the whole engine is built on: "we could not measure
// this" must never render as "this is fine", and it must never render as a zero either. A speed
// connector is where that is easiest to get wrong, because there are two different measurements
// in one response and each is plausible in the other's place:
//
//   · FIELD (CrUX) is what real visitors experienced. It exists only where a url has enough real
//     traffic, so a new or quiet store genuinely has none.
//   · LAB is one Lighthouse run on an emulated phone. Always available, describes nobody.
//
// Substituting one for the other is a fabricated measurement, and INP is the sharpest case: it
// cannot be measured in a lab at all, so a lab INP could only ever be an invented number.
//
// Nothing in this file is a fixture standing in for a feature that does not exist. Every report
// here is the shape the service really stores, and every assertion is about behaviour a merchant
// would actually see.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { cwvCheck } from '../audit-engine/checks/speed/cwv.js';
import type { PageSpeedReport, SnapshotPageSpeed, StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { AuditCheck, SubPillarResult } from '../audit-engine/types.js';

const ORIGIN = 'https://t.myshopify.com';

function source(relativePath: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relativePath), 'utf8');
}

function run(check: AuditCheck, snapshot: StoreSnapshot): SubPillarResult {
  const result = check.execute(snapshot);
  if (result instanceof Promise) throw new Error(`${check.id} unexpectedly returned a promise`);
  return result;
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

/** A report in exactly the shape runPageSpeedMeasurement() stores. */
function report(overrides: Partial<PageSpeedReport> = {}): PageSpeedReport {
  return {
    strategy: 'mobile',
    requestedUrl: ORIGIN,
    finalUrl: `${ORIGIN}/`,
    performanceScore: 42,
    lab: { lcpMs: 4200, cls: 0.05, tbtMs: 890, fcpMs: 2100, speedIndexMs: 5400, ttiMs: 8100, serverResponseMs: 410 },
    field: null,
    opportunities: [],
    lighthouseVersion: '11.0.0',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function pageSpeed(overrides: Partial<SnapshotPageSpeed> = {}): SnapshotPageSpeed {
  return { reports: [], lastError: null, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────
describe('speed/cwv · nothing measured is never "nothing wrong"', () => {
  it('reports unavailable, not a score, when no measurement has ever been run', () => {
    const result = run(cwvCheck, snapshot({ pageSpeed: pageSpeed() }));

    assert.equal(result.status, 'unavailable');
    assert.equal(result.healthyCount, 0);
    assert.equal(result.analyzedCount, 0);
    assert.match(result.details.unavailableReason ?? '', /have not been measured yet/);
    // The only honest next step, and it names where the measurement is taken.
    assert.match(result.details.unavailableReason ?? '', /Integrations/);
    assert.match(result.details.unavailableReason ?? '', /Nothing is estimated in its place/);
  });

  it('distinguishes "this audit could not look" from "no measurement exists"', () => {
    // pageSpeed absent = built before the connector existed. Claiming "never measured" would be a
    // statement about the store made from a gap in the snapshot.
    const result = run(cwvCheck, snapshot());

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /ran before Rankvora AI could read PageSpeed/);
  });

  it('relays why the last measurement failed instead of reporting no data', () => {
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({ lastError: 'Google rate-limited this measurement.' }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /Google rate-limited this measurement/);
  });

  it('refuses to measure a password-gated storefront at all', () => {
    // The gate answers EVERY url with HTTP 200 and its own page, so a measurement of it would
    // score well and describe a page no customer ever sees.
    const result = run(cwvCheck, snapshot({
      storefront: {
        homepage: { status: 200, passwordGated: true },
        robots: { status: 200, passwordGated: true },
        sitemap: { status: 200, passwordGated: true },
        passwordProtected: true,
      },
      pageSpeed: pageSpeed({ reports: [report()] }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /password-protected/);
  });

  it('reports unavailable when Google ran but returned none of the vitals', () => {
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({
        reports: [report({ lab: { lcpMs: null, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null, ttiMs: null, serverResponseMs: null } })],
      }),
    }));

    assert.equal(result.status, 'unavailable');
    assert.equal(result.analyzedCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('speed/cwv · field and lab are never interchanged', () => {
  it('never produces an INP row from a lab run', () => {
    // INP needs a real person interacting; Lighthouse reports Total Blocking Time instead. A lab
    // INP could only be an invented number, so there must be no INP row at all.
    const result = run(cwvCheck, snapshot({ pageSpeed: pageSpeed({ reports: [report({ field: null })] }) }));

    assert.equal(result.status, 'ok');
    assert.equal(result.details.evidenceRows.some((row) => row.cells.metric === 'INP'), false);
    assert.equal(result.findings.some((finding) => finding.title.includes('INP')), false);
    // And TBT is not smuggled in under another name.
    assert.equal(JSON.stringify(result).includes('890'), false);
  });

  it('labels every lab row as a lab test, and says so in the summary', () => {
    const result = run(cwvCheck, snapshot({ pageSpeed: pageSpeed({ reports: [report()] }) }));

    for (const row of result.details.evidenceRows) {
      assert.equal(row.cells.source, 'Lab test');
      assert.match(row.note ?? '', /does not describe any real visit/);
    }
    assert.match(result.details.summary, /Lighthouse lab test/);
    assert.match(result.details.summary, /no real-visitor data/);
  });

  it('prefers real-visitor data over the lab run for the same metric', () => {
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({
        reports: [report({
          // Real visitors say LCP is fine; the throttled lab run says 4.2s. Scoring both would
          // count one metric twice and let the emulated phone outvote the actual customers.
          field: {
            scope: 'url',
            overall: 'good',
            lcp: { p75: 1800, rating: 'good' },
            inp: { p75: 150, rating: 'good' },
            cls: { p75: 0.04, rating: 'good' },
            fcp: null,
            ttfb: null,
          },
        })],
      }),
    }));

    const lcpRows = result.details.evidenceRows.filter((row) => row.cells.metric === 'LCP');
    assert.equal(lcpRows.length, 1);
    assert.equal(lcpRows[0]?.cells.source, 'Real visitors');
    assert.equal(result.healthyCount, 3);
    assert.equal(result.analyzedCount, 3);
    assert.equal(result.findings.length, 0);
  });

  it('says on the row when CrUX fell back to the whole domain', () => {
    // Origin-level data describes every page on the domain. Presented as this page's, it is a
    // misattribution — so the scope travels with the number.
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({
        reports: [report({
          field: { scope: 'origin', overall: 'needs-improvement', lcp: { p75: 3100, rating: 'needs-improvement' }, inp: null, cls: null, fcp: null, ttfb: null },
        })],
      }),
    }));

    const lcp = result.details.evidenceRows.find((row) => row.cells.metric === 'LCP');
    assert.match(lcp?.note ?? '', /whole domain/);
    assert.match(lcp?.current?.meta ?? '', /whole domain/);
  });

  it('uses Google’s own rating rather than re-deriving one for field metrics', () => {
    // Search Console shows Google's verdict. A second opinion computed here would disagree with
    // it at the boundaries and leave the merchant with two different answers.
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({
        reports: [report({
          field: { scope: 'url', overall: 'poor', lcp: { p75: 2400, rating: 'poor' }, inp: null, cls: null, fcp: null, ttfb: null },
        })],
      }),
    }));

    // 2400ms would be "good" against the published threshold; Google said poor, so poor it is.
    const lcp = result.details.evidenceRows.find((row) => row.cells.metric === 'LCP');
    assert.equal(lcp?.status, 'Poor');
    assert.equal(lcp?.cells.source, 'Real visitors');
    // CLS had no field metric, so the lab run fills that one in — and is labelled as the lab.
    assert.equal(result.details.evidenceRows.find((row) => row.cells.metric === 'CLS')?.cells.source, 'Lab test');
    assert.equal(result.analyzedCount, 2);
    assert.equal(result.healthyCount, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('speed/cwv · findings and score come from what was measured', () => {
  it('raises one finding per failing metric, not one per device', () => {
    const failing = {
      scope: 'url' as const,
      overall: 'poor' as const,
      lcp: { p75: 5200, rating: 'poor' as const },
      inp: { p75: 620, rating: 'poor' as const },
      cls: { p75: 0.02, rating: 'good' as const },
      fcp: null,
      ttfb: null,
    };
    const result = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({
        reports: [report({ strategy: 'mobile', field: failing }), report({ strategy: 'desktop', field: failing })],
      }),
    }));

    assert.equal(result.findings.length, 2);
    assert.deepEqual(result.findings.map((finding) => finding.severity), ['high', 'high']);
    // Both devices are named inside the one finding rather than duplicated as two.
    assert.equal(result.findings[0]?.affectedCount, 2);
    assert.equal(result.analyzedCount, 6);
    assert.equal(result.healthyCount, 2);
  });

  it('offers no fix it cannot write', () => {
    // There is no field on a Shopify record that makes a page render faster. 'theme' is what
    // classifyFixability() reads to report this as manual rather than offering to apply it.
    const result = run(cwvCheck, snapshot({ pageSpeed: pageSpeed({ reports: [report()] }) }));

    for (const finding of result.findings) {
      assert.equal(finding.resolutionType, 'theme');
      assert.equal('suggested' in finding, false);
    }
    for (const row of result.details.evidenceRows) {
      assert.equal(row.suggested, undefined, 'a suggested value implies Rankvora AI can write one');
    }
  });

  it('quotes Google’s performance score as given, and shows nothing when there is none', () => {
    const withScore = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({ reports: [report({ strategy: 'mobile', performanceScore: 37 })] }),
    }));
    assert.equal(withScore.details.contextValue, 'Mobile 37');

    const withoutScore = run(cwvCheck, snapshot({
      pageSpeed: pageSpeed({ reports: [report({ performanceScore: null })] }),
    }));
    // An em dash, never a 0 — Google returned no score, which is not a score of zero.
    assert.equal(withoutScore.details.contextValue, '—');
  });

  it('says how old the measurement is once it is stale', () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const result = run(cwvCheck, snapshot({ pageSpeed: pageSpeed({ reports: [report({ fetchedAt: old })] }) }));

    assert.match(result.details.summary, /30 days ago/);
    assert.match(result.details.summary, /re-run the measurement/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('pagespeed service invariants', () => {
  const service = source('../services/pagespeed.service.ts');

  it('undoes the CrUX CLS scaling exactly once', () => {
    // The CrUX API carries percentiles as integers, so a real CLS of 0.05 arrives as 5. Left raw
    // it would report every store as catastrophically unstable; divided twice it would report
    // every store as perfect. Both are fabricated numbers.
    assert.ok(service.includes("fieldMetric(metrics, ['CUMULATIVE_LAYOUT_SHIFT_SCORE'], 100)"));
    assert.equal((service.match(/CUMULATIVE_LAYOUT_SHIFT_SCORE/g) ?? []).length, 1);
  });

  it('reads both names Google has used for field INP', () => {
    // Renamed when INP left the experimental stage. Reading only one would silently drop the
    // metric for whichever vintage of the API answered.
    assert.ok(service.includes("'INTERACTION_TO_NEXT_PAINT'"));
    assert.ok(service.includes("'EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT'"));
  });

  it('never derives a field INP from a lab measurement', () => {
    const fieldBlock = service.slice(service.indexOf('function parseField'), service.indexOf('function parseLab'));
    assert.equal(/tbt|total-blocking-time/i.test(fieldBlock), false, 'Total Blocking Time is leaking into the field metrics');
  });

  it('treats a Lighthouse runtime error as a failure, not an empty measurement', () => {
    // A runtime error arrives with HTTP 200 and a well-formed body. Stored as a success it would
    // become a report whose every metric is null, shown as a measurement that found nothing wrong.
    assert.ok(service.includes('runtimeError'));
    assert.ok(service.includes('describeRuntimeError'));
  });

  it('refuses to store a measurement of the Shopify password screen', () => {
    assert.ok(service.includes('isPasswordGate'));
    assert.match(service, /password-protected, so Google measured the password screen/);
  });

  it('takes the url from the store record, never from the request', () => {
    // A merchant-supplied url would let a number presented as "your store's performance" point at
    // any site on the internet.
    assert.ok(service.includes('storefrontUrlFor'));
    const route = source('../routes/pagespeed.ts');
    assert.equal(/body:/.test(route), false, 'the run route accepts a body — the url must not be a parameter');
  });

  it('never writes the integrations table directly', () => {
    // A bare where(storeId) matches EVERY provider row on the store, so this connector's failure
    // would mark Shopify as needing attention too. The helpers carry the provider.
    assert.equal(/update\(integrations\)/.test(service), false);
    assert.ok(service.includes('markConnectorSynced'));
  });

  it('keeps a partial measurement rather than discarding the half that worked', () => {
    // Mobile and desktop are separate measurements of separate emulated devices. Throwing away a
    // good mobile reading because desktop hit a quota limit loses the more important of the two.
    assert.ok(service.includes('Promise.allSettled'));
    assert.ok(service.includes('measured.length > 0'));
  });

  it('logs no API key', () => {
    for (const line of service.split('\n')) {
      if (!line.includes('console.')) continue;
      assert.equal(/apiKey|pagespeedApiKey|endpoint\b/.test(line), false, `a log line may carry the key: ${line.trim()}`);
    }
  });
});
