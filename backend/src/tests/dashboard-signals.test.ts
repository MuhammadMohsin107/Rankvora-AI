// ─── The four outcome cards on the dashboard (npm test) ──────────────
// Organic search clicks, mobile LCP, AI mention rate, drafts awaiting approval.
//
// THE PROPERTY THESE TESTS PROTECT: a card is either a real reading or an honest "not available" —
// never a number that was filled in. The shaping is tested as pure functions on fixtures (the same
// kind of fixture the rest of this suite uses); the Search Console read is tested against a stubbed
// Google that answers according to the dates it was asked for, so what is asserted is that the right
// two windows were requested and that each answer landed in the right field; the approvals count
// runs on the real in-memory database built from the D1 migration.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import './helpers/database.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { insertReturning } from '../db/returning.js';
import { aiFixProposals, audits, findings, googleConnections, stores, users } from '../db/schema.js';
import { encryptToken } from '../lib/crypto.js';
import { ApiError } from '../middleware/error.js';
import {
  aiMentionSignal,
  getDashboardSignals,
  mobileSpeedSignal,
  percentChange,
} from '../services/dashboard-signals.service.js';
import type { PageSpeedReport } from '../services/pagespeed.service.js';
import type { PromptHistory } from '../services/prompt-history.service.js';
import { precedingRange, rangeEndingWithLag } from '../services/reporting-window.js';
import { getSearchConsoleClicks } from '../services/search-console.service.js';

let counter = 0;
async function owner() {
  counter += 1;
  const user = await insertReturning(users, { fullName: 'Test', email: `signals${counter}@example.com` });
  const store = await insertReturning(stores, {
    ownerId: user.id, workspaceName: 'W', name: `Store ${counter}`, url: 'https://s.example', platform: 'Shopify',
    industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
  });
  return { user, store };
}

describe('percentChange', () => {
  it('is the change against the window before, to one decimal', () => {
    assert.equal(percentChange(1842, 1639), 12.4);
    assert.equal(percentChange(50, 100), -50);
    assert.equal(percentChange(100, 100), 0);
  });

  it('is null — not 0, not infinity — when the window before had no clicks to compare with', () => {
    // "+∞%" and "+0%" are both statements nobody measured.
    assert.equal(percentChange(40, 0), null);
    assert.equal(percentChange(0, 0), null);
  });
});

// ─── Mobile LCP ──────────────────────────────────────────────────────

function report(overrides: Partial<PageSpeedReport>): PageSpeedReport {
  return {
    strategy: 'mobile',
    requestedUrl: 'https://s.example/',
    finalUrl: 'https://s.example/',
    performanceScore: 80,
    lab: { lcpMs: null, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null, ttiMs: null, serverResponseMs: null },
    field: null,
    opportunities: [],
    lighthouseVersion: null,
    analyzedAt: '2026-10-20T10:00:00.000Z',
    fetchedAt: '2026-10-20T10:00:05.000Z',
    ...overrides,
  };
}

describe('mobile LCP', () => {
  it('reads real visitors first, with Google’s own rating', () => {
    const signal = mobileSpeedSignal([
      report({
        lab: { lcpMs: 9_000, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null, ttiMs: null, serverResponseMs: null },
        field: {
          scope: 'url', overall: 'good', inp: null, cls: null, fcp: null, ttfb: null,
          lcp: { p75: 2_300, rating: 'good' },
        },
      }),
    ]);
    assert.deepEqual(signal, {
      status: 'ready',
      data: { source: 'field', lcpMs: 2_300, rating: 'good', scope: 'url', measuredAt: '2026-10-20T10:00:00.000Z' },
    });
  });

  it('says so when Google had too few visits to the page and answered for the whole domain', () => {
    const signal = mobileSpeedSignal([
      report({
        field: { scope: 'origin', overall: null, inp: null, cls: null, fcp: null, ttfb: null, lcp: { p75: 3_100, rating: 'needs-improvement' } },
      }),
    ]);
    assert.equal(signal.status === 'ready' && signal.data.scope, 'origin');
    assert.equal(signal.status === 'ready' && signal.data.rating, 'needs-improvement');
  });

  it('falls back to the lab run when there is no visitor data, and labels it lab', () => {
    // A new or quiet store has no field data — a fact about sample size, not about speed.
    const lab = (lcpMs: number) => ({ lcpMs, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null, ttiMs: null, serverResponseMs: null });
    const good = mobileSpeedSignal([report({ lab: lab(2_400) })]);
    const slow = mobileSpeedSignal([report({ lab: lab(4_200) })]);
    assert.equal(good.status === 'ready' && good.data.source, 'lab');
    assert.equal(good.status === 'ready' && good.data.rating, 'good');
    assert.equal(good.status === 'ready' && good.data.scope, null);
    assert.equal(slow.status === 'ready' && slow.data.rating, 'poor');
  });

  it('is "not measured" without a mobile measurement — a desktop one is not a substitute', () => {
    for (const reports of [[], [report({ strategy: 'desktop', field: { scope: 'url', overall: 'good', inp: null, cls: null, fcp: null, ttfb: null, lcp: { p75: 1_000, rating: 'good' } } })]]) {
      const signal = mobileSpeedSignal(reports);
      assert.equal(signal.status, 'unavailable');
      assert.equal(signal.status === 'unavailable' && signal.reason, 'not_measured');
    }
  });

  it('is "no data" when the mobile test returned no LCP at all, never a 0', () => {
    const signal = mobileSpeedSignal([report({})]);
    assert.equal(signal.status === 'unavailable' && signal.reason, 'no_data');
  });
});

// ─── AI mention rate ─────────────────────────────────────────────────

const END = '2026-10-29';
const dayBefore = (days: number) => new Date(Date.parse(`${END}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

function history(buckets: Array<{ ago: number; samples: number; mentions: number }>, overrides: Partial<PromptHistory> = {}): PromptHistory {
  const series = buckets
    .map((bucket) => ({ date: dayBefore(bucket.ago), samples: bucket.samples, mentions: bucket.mentions, rate: bucket.mentions / bucket.samples, provisional: false }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    days: 56, granularity: 'day', startDate: dayBefore(56), endDate: END, series,
    totalSamples: series.reduce((sum, bucket) => sum + bucket.samples, 0),
    totalMentions: series.reduce((sum, bucket) => sum + bucket.mentions, 0),
    overallRate: null,
    queries: [{ queryId: 1, query: 'q', brandTerm: 'b', active: true, samples: 1, mentions: 0, rate: 0, provisional: true, lastCheckedAt: null }],
    minSamples: 5, healthyRate: 0.5, criticalRate: 0.1, aiConfigured: true,
    ranking: {} as PromptHistory['ranking'],
    ...overrides,
  };
}

describe('AI mention rate', () => {
  it('is mentions over sampled answers in the last 28 days, with the change in points against the 28 before', () => {
    const signal = aiMentionSignal(history([
      { ago: 0, samples: 30, mentions: 12 }, { ago: 27, samples: 20, mentions: 9 },   // this window: 21 / 50 = 42%
      { ago: 28, samples: 25, mentions: 8 }, { ago: 55, samples: 25, mentions: 9 },   // the one before: 17 / 50 = 34%
    ]));
    assert.equal(signal.status, 'ready');
    if (signal.status !== 'ready') return;
    assert.equal(signal.data.mentions, 21);
    assert.equal(signal.data.samples, 50);
    assert.equal(signal.data.rate, 0.42);
    assert.equal(signal.data.previousRate, 0.34);
    assert.equal(signal.data.changePoints, 8);
    assert.equal(signal.data.provisional, false);
  });

  it('counts a day in exactly one window, and ignores answers older than both', () => {
    const signal = aiMentionSignal(history([
      { ago: 27, samples: 10, mentions: 10 },   // the oldest day of this window
      { ago: 28, samples: 10, mentions: 0 },    // the newest day of the one before
      { ago: 56, samples: 100, mentions: 100 }, // outside both
    ]));
    assert.equal(signal.status === 'ready' && signal.data.samples, 10);
    assert.equal(signal.status === 'ready' && signal.data.rate, 1);
    assert.equal(signal.status === 'ready' && signal.data.previousRate, 0);
  });

  it('shows a rate from too few answers as provisional and compares it with nothing', () => {
    // Two answers swinging 0% to 50% is noise; "+50 points" built on it would be a story.
    const signal = aiMentionSignal(history([{ ago: 1, samples: 2, mentions: 1 }, { ago: 40, samples: 40, mentions: 4 }]));
    assert.equal(signal.status === 'ready' && signal.data.provisional, true);
    assert.equal(signal.status === 'ready' && signal.data.changePoints, null);
  });

  it('does not compare with a window that had too few answers', () => {
    const signal = aiMentionSignal(history([{ ago: 1, samples: 20, mentions: 10 }, { ago: 40, samples: 3, mentions: 3 }]));
    assert.equal(signal.status === 'ready' && signal.data.previousRate, null);
    assert.equal(signal.status === 'ready' && signal.data.changePoints, null);
  });

  it('gives each reason a store can have no reading its own sentence, and never a 0%', () => {
    const reason = (value: PromptHistory) => {
      const signal = aiMentionSignal(value);
      return signal.status === 'unavailable' ? signal.reason : 'ready';
    };
    assert.equal(reason(history([], { aiConfigured: false })), 'not_configured');
    assert.equal(reason(history([], { queries: [] })), 'no_queries');
    assert.equal(reason(history([])), 'no_data');
    // Answers exist, but none in the last 28 days.
    assert.equal(reason(history([{ ago: 40, samples: 10, mentions: 5 }])), 'no_data');
  });
});

// ─── Organic search clicks, against a stubbed Google ─────────────────

interface Call { url: string; body: { startDate: string; endDate: string; dimensions?: string[] } }
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A Google that answers `clicksByStart[startDate]` for a window, and no rows for any other. */
function stubGoogle(clicksByStart: Record<string, number>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    const clicks = clicksByStart[body.startDate];
    return Response.json(clicks === undefined ? {} : { rows: [{ clicks, impressions: clicks * 10, ctr: 0.1, position: 4 }] });
  }) as typeof fetch;
  return calls;
}

async function connectedStore(siteUrl: string | null) {
  const { user, store } = await owner();
  await insertReturning(googleConnections, {
    storeId: store.id, siteUrl, scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    accessTokenEncrypted: encryptToken('access-token'), accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  });
  return { user, store };
}

describe('organic search clicks', () => {
  it('asks Google for this window and the equally long one before it, and puts each answer in its own field', async () => {
    const { store } = await connectedStore('sc-domain:example.com');
    const current = rangeEndingWithLag(28, 3);
    const previous = precedingRange(current);
    const calls = stubGoogle({ [current.startDate]: 1842, [previous.startDate]: 1639 });

    const result = await getSearchConsoleClicks(store.id, 28);

    assert.equal(calls.length, 2, 'two calls: this window and the one before');
    assert.ok(calls.every((call) => call.url.includes('searchAnalytics/query')));
    assert.deepEqual(calls.map((call) => [call.body.startDate, call.body.endDate]).sort(), [
      [current.startDate, current.endDate], [previous.startDate, previous.endDate],
    ].sort());
    // The headline is Google's own aggregate, so neither call may be grouped by query or page.
    assert.ok(calls.every((call) => call.body.dimensions === undefined), 'a grouped call would drop the rows Google withholds');
    assert.equal(result.clicks, 1842);
    assert.equal(result.previousClicks, 1639);
    assert.equal(result.startDate, current.startDate);
    assert.equal(result.previousEndDate, previous.endDate);
    assert.equal(percentChange(result.clicks, result.previousClicks), 12.4);
  });

  it('reports a window with no rows as zero clicks — a real zero, not an error', async () => {
    const { store } = await connectedStore('sc-domain:example.com');
    stubGoogle({});
    const result = await getSearchConsoleClicks(store.id, 28);
    assert.equal(result.clicks, 0);
    assert.equal(result.previousClicks, 0);
  });

  it('names what is missing instead of guessing a property', async () => {
    const { store: none } = await owner();
    await assert.rejects(getSearchConsoleClicks(none.id), (error: unknown) => error instanceof ApiError && error.code === 'GOOGLE_NOT_CONNECTED');
    const { store: noProperty } = await connectedStore(null);
    await assert.rejects(getSearchConsoleClicks(noProperty.id), (error: unknown) => error instanceof ApiError && error.code === 'GOOGLE_SITE_NOT_SELECTED');
  });
});

// ─── All four, through the service the route calls ───────────────────

describe('the dashboard signals', () => {
  it('give a store with nothing connected four honest "not available" cards — no zeros', async () => {
    const { user, store } = await owner();
    const signals = await getDashboardSignals(user.id, store.id);

    assert.equal(signals.searchTraffic.status, 'unavailable');
    assert.equal(signals.mobileSpeed.status === 'unavailable' && signals.mobileSpeed.reason, 'not_measured');
    assert.equal(signals.aiMentions.status, 'unavailable');
    // Approvals is a count, and a real zero is the true answer here.
    assert.deepEqual(signals.approvals, { status: 'ready', data: { total: 0, areas: [] } });
  });

  it('say "connect it" with Search Console configured but not connected, and "choose a property" before one is chosen', async () => {
    const mutable = env as unknown as Record<string, unknown>;
    const saved = { id: mutable.googleClientId, secret: mutable.googleClientSecret };
    mutable.googleClientId = 'test-client';
    mutable.googleClientSecret = 'test-secret';
    try {
      const { user: a, store: notConnected } = await owner();
      const first = await getDashboardSignals(a.id, notConnected.id);
      assert.equal(first.searchTraffic.status === 'unavailable' && first.searchTraffic.reason, 'not_connected');

      const { user: b, store: noProperty } = await connectedStore(null);
      const second = await getDashboardSignals(b.id, noProperty.id);
      assert.equal(second.searchTraffic.status === 'unavailable' && second.searchTraffic.reason, 'no_property');

      const { user: c, store: connected } = await connectedStore('sc-domain:example.com');
      const current = rangeEndingWithLag(28, 3);
      stubGoogle({ [current.startDate]: 200, [precedingRange(current).startDate]: 100 });
      const third = await getDashboardSignals(c.id, connected.id);
      assert.equal(third.searchTraffic.status === 'ready' && third.searchTraffic.data.clicks, 200);
      assert.equal(third.searchTraffic.status === 'ready' && third.searchTraffic.data.changePercent, 100);
    } finally {
      mutable.googleClientId = saved.id;
      mutable.googleClientSecret = saved.secret;
    }
  });

  it('keep one card failing from blanking the other three', async () => {
    const mutable = env as unknown as Record<string, unknown>;
    const saved = { id: mutable.googleClientId, secret: mutable.googleClientSecret };
    mutable.googleClientId = 'test-client';
    mutable.googleClientSecret = 'test-secret';
    try {
      const { user, store } = await connectedStore('sc-domain:example.com');
      globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
      const signals = await getDashboardSignals(user.id, store.id);
      assert.equal(signals.searchTraffic.status === 'unavailable' && signals.searchTraffic.reason, 'error');
      assert.equal(signals.approvals.status, 'ready');
      assert.equal(signals.mobileSpeed.status, 'unavailable');
    } finally {
      mutable.googleClientId = saved.id;
      mutable.googleClientSecret = saved.secret;
    }
  });
});

// ─── Drafts awaiting approval ────────────────────────────────────────

async function finding(auditId: number, subPillar: string, status = 'open') {
  return insertReturning(findings, {
    auditId, pillar: 'seo', subPillar, title: `Finding ${subPillar} ${Math.random()}`, severity: 'high', status,
    affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
  });
}

let proposalCounter = 0;
async function proposal(storeId: number, findingId: number, status: string) {
  proposalCounter += 1;
  await db.insert(aiFixProposals).values({
    findingId, storeId, resourceType: 'product', resourceId: String(proposalCounter), field: 'seo.title',
    currentValue: 'old', proposedValue: 'new', reason: 'r', status,
  });
}

describe('drafts awaiting approval', () => {
  it('counts only drafts nobody has decided on, grouped by where they are, largest first', async () => {
    const { user, store } = await owner();
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50 });
    const titles = await finding(audit.id, 'title-tags');
    const metas = await finding(audit.id, 'meta-descriptions');

    await proposal(store.id, titles.id, 'proposed');
    await proposal(store.id, metas.id, 'proposed');
    await proposal(store.id, metas.id, 'proposed');
    await proposal(store.id, titles.id, 'approved');
    await proposal(store.id, titles.id, 'applied');
    await proposal(store.id, titles.id, 'rejected');
    await proposal(store.id, titles.id, 'failed');

    const { approvals } = await getDashboardSignals(user.id, store.id);
    assert.deepEqual(approvals, {
      status: 'ready',
      data: { total: 3, areas: [{ pillar: 'seo', subPillar: 'meta-descriptions', count: 2 }, { pillar: 'seo', subPillar: 'title-tags', count: 1 }] },
    });
  });

  it('forgets a draft once the store has been analysed again, or the issue has been dismissed', async () => {
    const { user, store } = await owner();
    const older = await insertReturning(audits, { storeId: store.id, overallScore: 40 });
    const superseded = await finding(older.id, 'title-tags');
    await proposal(store.id, superseded.id, 'proposed');

    const newest = await insertReturning(audits, { storeId: store.id, overallScore: 60 });
    const dismissed = await finding(newest.id, 'meta-descriptions', 'ignored');
    const resolved = await finding(newest.id, 'image-alt-text', 'resolved');
    const live = await finding(newest.id, 'handles-redirects', 'reviewed');
    await proposal(store.id, dismissed.id, 'proposed');
    await proposal(store.id, resolved.id, 'proposed');
    await proposal(store.id, live.id, 'proposed');

    const { approvals } = await getDashboardSignals(user.id, store.id);
    assert.deepEqual(approvals.status === 'ready' && approvals.data, { total: 1, areas: [{ pillar: 'seo', subPillar: 'handles-redirects', count: 1 }] });
  });

  it('never counts another store’s drafts', async () => {
    const { user, store } = await owner();
    const { store: other } = await owner();
    const audit = await insertReturning(audits, { storeId: other.id, overallScore: 50 });
    await proposal(other.id, (await finding(audit.id, 'title-tags')).id, 'proposed');

    const { approvals } = await getDashboardSignals(user.id, store.id);
    assert.equal(approvals.status === 'ready' && approvals.data.total, 0);
  });
});

// ─── The route, through the real Express app ─────────────────────────

describe('GET /api/dashboard/signals over HTTP', () => {
  async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
    const { app } = await import('../app.js');
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as { port: number };
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('refuses a request with no sign-in, and a forged one', async () => {
    await withServer(async (base) => {
      assert.equal((await realFetch(`${base}/api/dashboard/signals`)).status, 401);
      const forged = await realFetch(`${base}/api/dashboard/signals`, { headers: { Authorization: 'Bearer not-a-token' } });
      assert.equal(forged.status, 401);
    });
  });

  it('answers a signed-in merchant with their own four cards, and no one else’s', async () => {
    const { user, store } = await owner();
    const { store: someoneElses } = await owner();
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50 });
    await proposal(store.id, (await finding(audit.id, 'title-tags')).id, 'proposed');
    const { signAccessToken } = await import('../lib/jwt.js');
    const headers = { Authorization: `Bearer ${signAccessToken(user.id)}` };

    await withServer(async (base) => {
      const response = await realFetch(`${base}/api/dashboard/signals?storeId=${store.id}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Record<string, { status: string; data?: unknown }> };
      assert.deepEqual(Object.keys(body.data).sort(), ['aiMentions', 'approvals', 'mobileSpeed', 'searchTraffic']);
      assert.deepEqual(body.data.approvals, { status: 'ready', data: { total: 1, areas: [{ pillar: 'seo', subPillar: 'title-tags', count: 1 }] } });
      assert.equal(body.data.mobileSpeed?.status, 'unavailable');

      // Another merchant's store id is not theirs to read: it is refused, never answered.
      const refused = await realFetch(`${base}/api/dashboard/signals?storeId=${someoneElses.id}`, { headers });
      assert.equal(refused.status, 404);
    });
  });
});

describe('GET /api/dashboard/signals', () => {
  it('sits behind sign-in, like every other dashboard route', () => {
    const route = readFileSync(new URL('../routes/dashboard.ts', import.meta.url), 'utf8');
    assert.ok(route.indexOf('dashboardRouter.use(authenticate)') !== -1);
    assert.ok(route.indexOf('dashboardRouter.use(authenticate)') < route.indexOf("'/signals'"), 'the signals route is declared before authentication');
    assert.match(route, /'\/signals', validateRequest\(\{ query: storeIdQuerySchema \}\)/);
  });
});
