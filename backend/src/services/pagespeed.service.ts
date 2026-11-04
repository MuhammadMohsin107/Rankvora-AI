import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pagespeedReports, stores } from '../db/schema.js';
import { env, pagespeedKeyed } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { markConnectorState, markConnectorSynced, readConnectorRow } from './integration.service.js';

/**
 * ─── PageSpeed Insights · measuring the real storefront ──────────────
 *
 * Every number this service returns was produced by Google's PageSpeed Insights API in the run
 * that produced it. Nothing here estimates, interpolates or carries a value forward: a store that
 * has never been measured has no report, and a metric Google did not return is null — never zero,
 * and never a stand-in from the other half of the response.
 *
 * ─── The two halves of a measurement, and why they never substitute ──
 *
 *   FIELD (CrUX)  What real visitors actually experienced, over Google's trailing 28-day window.
 *                 This is what Core Web Vitals ARE and what Search ranks on. It exists only for
 *                 urls with enough real traffic, so a new or quiet store has none — which is a
 *                 fact about sample size, not about speed, and is reported as such.
 *
 *   LAB           One Lighthouse run, right now, on Google's emulated Moto G Power over a
 *                 throttled connection. Always available, reproducible, and deliberately
 *                 pessimistic. It diagnoses; it does not describe anyone's experience.
 *
 * They are stored in separate columns and rendered as separate things. Presenting a lab LCP as
 * "your LCP" would be inventing a user experience nobody had, and INP makes the point sharper
 * still: it CANNOT be measured in a lab, because it needs a real person interacting. Lighthouse
 * reports Total Blocking Time instead. TBT is not INP and is never labelled as it.
 *
 * ─── No account, no OAuth ────────────────────────────────────────────
 * PageSpeed Insights measures a public url and asks for no merchant credential, so there is
 * nothing to connect and no token to store. The only server-side setting is an optional API key,
 * which buys quota (see env.pagespeedKeyed) and nothing else.
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** Google emulates a different device per strategy. The two are separate measurements, not views. */
export const PAGESPEED_STRATEGIES = ['mobile', 'desktop'] as const;
export type PageSpeedStrategy = (typeof PAGESPEED_STRATEGIES)[number];

/** How many Lighthouse opportunities to keep. Enough to act on, short of a wall of audit ids. */
const OPPORTUNITY_LIMIT = 8;

/** Google's own least saving worth reporting. Below this the audit is noise on a rerun. */
const MIN_SAVING_MS = 1;

// ─── The shape of a stored measurement ───────────────────────────────

/**
 * Lab metrics from THIS Lighthouse run. Every field is nullable because a run can complete with
 * some audits unable to produce a value, and an absent metric is absent, not zero.
 */
export interface PageSpeedLab {
  /** Largest Contentful Paint, milliseconds. */
  lcpMs: number | null;
  /** Cumulative Layout Shift — unitless, as Lighthouse reports it (0.1 is the "good" threshold). */
  cls: number | null;
  /** Total Blocking Time, milliseconds. Lighthouse's lab proxy for responsiveness. NOT INP. */
  tbtMs: number | null;
  /** First Contentful Paint, milliseconds. */
  fcpMs: number | null;
  /** Speed Index, milliseconds. */
  speedIndexMs: number | null;
  /** Time to Interactive, milliseconds. */
  ttiMs: number | null;
  /** Server response time (lab TTFB), milliseconds. */
  serverResponseMs: number | null;
}

/** One CrUX metric: the 75th-percentile value Google reports, plus its own verdict on it. */
export interface PageSpeedFieldMetric {
  /** The 75th percentile across real visits. Milliseconds, except CLS which is unitless. */
  p75: number;
  /** Google's bucket for that value. */
  rating: 'good' | 'needs-improvement' | 'poor';
}

/**
 * Real-user metrics from the Chrome UX Report.
 *
 * `scope` is load-bearing: Google falls back to the whole ORIGIN when a single url has too few
 * visits, and origin numbers describe every page on the domain rather than the one measured.
 * Reporting the fallback as if it were the page's own would attribute the homepage's experience
 * to a product page nobody has visited.
 */
export interface PageSpeedField {
  scope: 'url' | 'origin';
  /** Google's overall verdict for this url or origin. */
  overall: 'good' | 'needs-improvement' | 'poor' | null;
  /** Largest Contentful Paint. */
  lcp: PageSpeedFieldMetric | null;
  /** Interaction to Next Paint. Field-only — there is no lab equivalent. */
  inp: PageSpeedFieldMetric | null;
  /** Cumulative Layout Shift. */
  cls: PageSpeedFieldMetric | null;
  /** First Contentful Paint. */
  fcp: PageSpeedFieldMetric | null;
  /** Time to First Byte. */
  ttfb: PageSpeedFieldMetric | null;
}

/** A Lighthouse opportunity with a real estimated saving, exactly as Google ranked it. */
export interface PageSpeedOpportunity {
  /** Lighthouse audit id, e.g. `render-blocking-resources`. */
  id: string;
  title: string;
  /** Google's estimated saving, milliseconds. Only opportunities above MIN_SAVING_MS are kept. */
  savingsMs: number;
  /** Google's own summary line, e.g. "Potential savings of 1,200 ms". Null when it gave none. */
  displayValue: string | null;
}

export interface PageSpeedReport {
  strategy: PageSpeedStrategy;
  requestedUrl: string;
  /** Where Lighthouse ended up after redirects — the page the numbers actually describe. */
  finalUrl: string | null;
  /** Lighthouse performance category, 0–100. Null when the run produced no category score. */
  performanceScore: number | null;
  lab: PageSpeedLab;
  /** Null when Google has no sufficient real-user sample. Never a zeroed stand-in. */
  field: PageSpeedField | null;
  opportunities: PageSpeedOpportunity[];
  lighthouseVersion: string | null;
  /** When Google ran the analysis. */
  analyzedAt: string | null;
  /** When Rankvora AI stored it. */
  fetchedAt: string;
}

export interface PageSpeedStatus {
  /**
   * Whether runs go against Google's keyed quota. False still means the connector WORKS — Google
   * answers anonymous calls — so this is shown as a quota note, never as "not available".
   */
  keyed: boolean;
  /** The storefront url measurements are run against. Null = no store connected, nothing to measure. */
  storefrontUrl: string | null;
  /** The most recent successful measurement per strategy. Absent until one has been made. */
  reports: PageSpeedReport[];
  /** When the last successful measurement completed. Null = never measured. */
  lastMeasuredAt: string | null;
  /** Why the last attempt failed. Null = no failure on record. */
  lastError: string | null;
}

// ─── Google's response, as far as this service reads it ──────────────

interface CruxMetric {
  percentile?: number;
  category?: string;
}

interface LoadingExperience {
  metrics?: Record<string, CruxMetric>;
  overall_category?: string;
  origin_fallback?: boolean;
}

interface LighthouseAudit {
  numericValue?: number;
  displayValue?: string;
  title?: string;
  details?: { type?: string; overallSavingsMs?: number };
}

interface PageSpeedResponse {
  id?: string;
  analysisUTCTimestamp?: string;
  loadingExperience?: LoadingExperience;
  originLoadingExperience?: LoadingExperience;
  lighthouseResult?: {
    requestedUrl?: string;
    finalUrl?: string;
    finalDisplayedUrl?: string;
    lighthouseVersion?: string;
    runtimeError?: { code?: string; message?: string };
    audits?: Record<string, LighthouseAudit>;
    categories?: { performance?: { score?: number | null } };
  };
  error?: { code?: number; message?: string; status?: string };
}

// ─── Parsing ─────────────────────────────────────────────────────────

/** A finite number, or null. Google omits a metric it could not produce; `0` would be a claim. */
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ratingOf(category: string | undefined): PageSpeedFieldMetric['rating'] | null {
  switch (category) {
    case 'FAST': return 'good';
    case 'AVERAGE': return 'needs-improvement';
    case 'SLOW': return 'poor';
    default: return null;
  }
}

/**
 * One CrUX metric, or null when Google reported none for it.
 *
 * CLS ARRIVES MULTIPLIED BY 100. The CrUX API carries percentiles as integers, so a real CLS of
 * 0.05 comes back as `5`. Storing it raw would report every store as catastrophically unstable —
 * `scale` is what undoes it, and it is why CLS is not read by the same path as the millisecond
 * metrics.
 */
function fieldMetric(metrics: Record<string, CruxMetric> | undefined, keys: string[], scale = 1): PageSpeedFieldMetric | null {
  for (const key of keys) {
    const metric = metrics?.[key];
    const percentile = numeric(metric?.percentile);
    const rating = ratingOf(metric?.category);
    if (percentile === null || !rating) continue;
    return { p75: percentile / scale, rating };
  }
  return null;
}

function overallOf(experience: LoadingExperience): PageSpeedField['overall'] {
  return ratingOf(experience.overall_category);
}

/**
 * The real-user half of the response, or null when there is none.
 *
 * Google sends `loadingExperience` for the url and `originLoadingExperience` for the whole domain,
 * and when the url itself has too few visits it copies the origin data into the first with
 * `origin_fallback` set. Either way the SCOPE is recorded, because origin numbers are not this
 * page's numbers. When neither half carries metrics there is no field data — which is the normal
 * state for a new store and is reported as "not enough real visits yet", not as a failure.
 */
function parseField(payload: PageSpeedResponse): PageSpeedField | null {
  const urlLevel = payload.loadingExperience;
  const originLevel = payload.originLoadingExperience;

  const useOrigin = !urlLevel?.metrics || Object.keys(urlLevel.metrics).length === 0 || urlLevel.origin_fallback === true;
  const experience = useOrigin ? (originLevel ?? urlLevel) : urlLevel;
  if (!experience?.metrics || Object.keys(experience.metrics).length === 0) return null;

  const metrics = experience.metrics;
  const field: PageSpeedField = {
    scope: useOrigin ? 'origin' : 'url',
    overall: overallOf(experience),
    lcp: fieldMetric(metrics, ['LARGEST_CONTENTFUL_PAINT_MS']),
    // Google renamed this metric when INP left the experimental stage; connections measured by
    // either vintage of the API have to read the same.
    inp: fieldMetric(metrics, ['INTERACTION_TO_NEXT_PAINT', 'EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT']),
    cls: fieldMetric(metrics, ['CUMULATIVE_LAYOUT_SHIFT_SCORE'], 100),
    fcp: fieldMetric(metrics, ['FIRST_CONTENTFUL_PAINT_MS']),
    ttfb: fieldMetric(metrics, ['EXPERIMENTAL_TIME_TO_FIRST_BYTE', 'TIME_TO_FIRST_BYTE']),
  };

  // Metrics were present but none of the ones Rankvora AI reads. Nothing to show is not "all good".
  if (!field.lcp && !field.inp && !field.cls && !field.fcp && !field.ttfb) return null;
  return field;
}

function parseLab(audits: Record<string, LighthouseAudit> | undefined): PageSpeedLab {
  const value = (id: string) => numeric(audits?.[id]?.numericValue);
  return {
    lcpMs: value('largest-contentful-paint'),
    cls: value('cumulative-layout-shift'),
    tbtMs: value('total-blocking-time'),
    fcpMs: value('first-contentful-paint'),
    speedIndexMs: value('speed-index'),
    ttiMs: value('interactive'),
    serverResponseMs: value('server-response-time'),
  };
}

/**
 * The opportunities Lighthouse costed, biggest saving first.
 *
 * Only audits Lighthouse itself typed as an `opportunity` and gave a saving to. Every other audit
 * in the response is a diagnostic with no estimated gain, and ranking those by an invented number
 * would be the report telling a merchant what to do first on no evidence.
 */
function parseOpportunities(audits: Record<string, LighthouseAudit> | undefined): PageSpeedOpportunity[] {
  if (!audits) return [];
  return Object.entries(audits)
    .filter(([, audit]) => audit.details?.type === 'opportunity')
    // The saving is read BEFORE the row is built, so an opportunity Lighthouse costed at nothing
    // — or did not cost at all — is dropped rather than constructed with a zero that a later
    // filter has to catch. No number in the result is one this function chose.
    .flatMap(([id, audit]): PageSpeedOpportunity[] => {
      const savings = numeric(audit.details?.overallSavingsMs);
      if (savings === null || savings < MIN_SAVING_MS) return [];
      return [{
        id,
        title: audit.title ?? id,
        savingsMs: Math.round(savings),
        displayValue: audit.displayValue ?? null,
      }];
    })
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, OPPORTUNITY_LIMIT);
}

// ─── Calling Google ──────────────────────────────────────────────────

/**
 * Why a run failed, in words that name the remedy.
 *
 * Google's own message is not relayed verbatim: it is written for API developers, frequently
 * quotes the url back, and for quota errors reads as though the merchant's site were at fault.
 * The mapping is on Google's STATUS, which is stable, rather than on its prose.
 */
function describeApiFailure(status: number, googleStatus: string | undefined): string {
  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return pagespeedKeyed()
      ? 'Google’s PageSpeed Insights quota for this server’s API key is exhausted. Measurements resume when the quota resets.'
      : 'Google rate-limited this measurement. This server calls PageSpeed Insights without an API key, which shares a small anonymous quota — set PAGESPEED_API_KEY to get a quota of its own.';
  }
  if (status === 400 || googleStatus === 'INVALID_ARGUMENT') {
    return 'Google could not load your storefront to measure it. It must be reachable from the public internet — check that it is not password-protected, blocked to bots, or behind a redirect loop.';
  }
  if (status === 403 || googleStatus === 'PERMISSION_DENIED') {
    return 'Google refused this server’s PageSpeed Insights key. Check that the key is valid and that the PageSpeed Insights API is enabled on its Google Cloud project.';
  }
  if (status >= 500) {
    return 'Google’s PageSpeed Insights service could not complete the measurement. Try again shortly.';
  }
  return `Google’s PageSpeed Insights API refused the measurement (HTTP ${status}).`;
}

/**
 * What a Lighthouse run that started and then failed means, in the merchant's terms.
 *
 * A runtime error arrives with HTTP 200 and an otherwise well-formed body, so it has to be read
 * explicitly. Treated as success, it would store a report whose every metric is null and show it
 * as a measurement that found nothing wrong.
 */
function describeRuntimeError(code: string | undefined): string {
  switch (code) {
    case 'NO_FCP':
      return 'Google loaded your storefront but nothing ever rendered, so there was nothing to measure. This usually means the page failed to paint within the timeout, or its content is blocked to Google’s browser.';
    case 'ERRORED_DOCUMENT_REQUEST':
    case 'FAILED_DOCUMENT_REQUEST':
      return 'Google could not load your storefront at all. Check that it is reachable from the public internet and is not refusing requests from Google.';
    case 'DNS_FAILURE':
      return 'Google could not resolve your storefront’s domain.';
    case 'NO_SPEEDLINE_FRAMES':
      return 'Google loaded your storefront but captured no frames to measure. Try the measurement again.';
    default:
      return 'Google started the measurement but could not complete it. Try again shortly.';
  }
}

/** Shopify serves its "Restrict access" gate at /password for every url on a closed storefront. */
function isPasswordGate(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/password');
  } catch {
    return false;
  }
}

/** A failed run, carrying the sentence the merchant should read. */
class PageSpeedRunError extends Error {}

/**
 * One measurement of one url on one strategy.
 *
 * Google loads the page in a real headless browser on its own hardware, so this is slow by nature
 * — tens of seconds is normal. The timeout is generous for that reason; cutting it short would
 * report a measurement that was about to succeed as a failure.
 */
async function measure(url: string, strategy: PageSpeedStrategy): Promise<PageSpeedReport> {
  const endpoint = new URL(ENDPOINT);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', strategy);
  endpoint.searchParams.set('category', 'performance');
  if (env.pagespeedApiKey) endpoint.searchParams.set('key', env.pagespeedApiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.pagespeedTimeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PageSpeedRunError(
        `Google did not finish measuring your storefront within ${Math.round(env.pagespeedTimeoutMs / 1000)} seconds. A very heavy page can exceed this — try again, and if it keeps happening the page itself is the finding.`,
      );
    }
    throw new PageSpeedRunError('Could not reach Google’s PageSpeed Insights API from this server.');
  } finally {
    clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => ({}))) as PageSpeedResponse;

  if (!response.ok) {
    // The key travels in the query string, so nothing from this request is ever logged whole.
    console.error(`[scorelo-pagespeed] ${strategy} run failed: HTTP ${response.status} ${payload.error?.status ?? ''}`.trim());
    throw new PageSpeedRunError(describeApiFailure(response.status, payload.error?.status));
  }

  const lighthouse = payload.lighthouseResult;
  if (lighthouse?.runtimeError?.code) {
    throw new PageSpeedRunError(describeRuntimeError(lighthouse.runtimeError.code));
  }
  if (!lighthouse) {
    throw new PageSpeedRunError('Google returned no Lighthouse result for your storefront.');
  }

  const finalUrl = lighthouse.finalDisplayedUrl ?? lighthouse.finalUrl ?? null;

  // The gate serves HTTP 200 for every url, so Lighthouse measures the password screen and scores
  // it well. Storing that as the storefront's performance would be a fabricated measurement of a
  // page no customer ever sees.
  if (isPasswordGate(finalUrl)) {
    throw new PageSpeedRunError(
      'Your storefront is password-protected, so Google measured the password screen instead of your store. Remove the storefront password (Shopify admin → Online Store → Preferences) to measure the real pages.',
    );
  }

  const score = numeric(lighthouse.categories?.performance?.score);

  return {
    strategy,
    requestedUrl: url,
    finalUrl,
    // Lighthouse reports the category as a 0–1 fraction; 0–100 is how it is read everywhere else.
    performanceScore: score === null ? null : Math.round(score * 100),
    lab: parseLab(lighthouse.audits),
    field: parseField(payload),
    opportunities: parseOpportunities(lighthouse.audits),
    lighthouseVersion: lighthouse.lighthouseVersion ?? null,
    analyzedAt: payload.analysisUTCTimestamp ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Store lookup ────────────────────────────────────────────────────

/**
 * The public storefront url to measure.
 *
 * Read from the store record rather than asked for, because a merchant typing a url here could
 * point a "your store's performance" number at any site on the internet. `stores.url` is written
 * by the Shopify install from the shop Shopify itself confirmed.
 */
async function storefrontUrlFor(storeId: number): Promise<string | null> {
  const [store] = await db.select({ url: stores.url }).from(stores).where(eq(stores.id, storeId)).limit(1);
  const url = store?.url?.trim();
  if (!url) return null;
  try {
    // A placeholder from signup is not a storefront. Measuring it would report example.com.
    const parsed = new URL(url);
    if (parsed.hostname === 'example.com') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function rowToReport(row: typeof pagespeedReports.$inferSelect): PageSpeedReport {
  return {
    strategy: row.strategy as PageSpeedStrategy,
    requestedUrl: row.requestedUrl,
    finalUrl: row.finalUrl,
    performanceScore: row.performanceScore,
    // Every insert writes a lab object, so this is a guard rather than a path in use. Null-filled
    // rather than defaulted: if a row ever lacked one, the honest reading is "no lab metric", and
    // a zero would report a page that paints instantly.
    lab: (row.lab as PageSpeedLab | null) ?? {
      lcpMs: null, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null, ttiMs: null, serverResponseMs: null,
    },
    field: (row.field as PageSpeedField | null) ?? null,
    opportunities: (row.opportunities as PageSpeedOpportunity[] | null) ?? [],
    lighthouseVersion: row.lighthouseVersion,
    analyzedAt: row.analyzedAt?.toISOString() ?? null,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

/**
 * The newest measurement for each strategy.
 *
 * One query per strategy rather than a window function: the table is append-only and the index is
 * (store, strategy, fetched_at), so each of these is a single index seek, and it keeps the audit
 * engine's read identical to the card's.
 */
export async function latestPageSpeedReports(storeId: number): Promise<PageSpeedReport[]> {
  const rows = await Promise.all(
    PAGESPEED_STRATEGIES.map(async (strategy) => {
      const [row] = await db
        .select()
        .from(pagespeedReports)
        .where(and(eq(pagespeedReports.storeId, storeId), eq(pagespeedReports.strategy, strategy)))
        .orderBy(desc(pagespeedReports.fetchedAt))
        .limit(1);
      return row ?? null;
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null).map(rowToReport);
}

// ─── The two operations the connector offers ─────────────────────────

export async function getPageSpeedStatus(storeId: number): Promise<PageSpeedStatus> {
  const [storefrontUrl, reports, connector] = await Promise.all([
    storefrontUrlFor(storeId),
    latestPageSpeedReports(storeId),
    readConnectorRow(storeId, 'pagespeed'),
  ]);

  return {
    keyed: pagespeedKeyed(),
    storefrontUrl,
    reports,
    // From the rows themselves, so a stored measurement and the time attributed to it can never
    // disagree — rather than from the connector row, which is display state.
    lastMeasuredAt: reports.reduce(
      (latest: string | null, report: PageSpeedReport) => (latest === null || report.fetchedAt > latest ? report.fetchedAt : latest),
      null as string | null,
    ),
    lastError: connector?.notice ?? null,
  };
}

/**
 * Measures the storefront on both strategies and stores what Google returned.
 *
 * BOTH ARE ATTEMPTED INDEPENDENTLY and a partial result is kept. Mobile and desktop are separate
 * measurements of separate emulated devices; one failing says nothing about the other, and
 * discarding a good mobile measurement because desktop hit a quota limit would throw away the
 * more important of the two.
 */
export async function runPageSpeedMeasurement(storeId: number): Promise<PageSpeedStatus> {
  const storefrontUrl = await storefrontUrlFor(storeId);
  if (!storefrontUrl) {
    throw new ApiError(
      409,
      'No storefront to measure. Connect your Shopify store first — PageSpeed Insights measures the public storefront.',
      'PAGESPEED_NO_STOREFRONT',
    );
  }

  const settled = await Promise.allSettled(
    PAGESPEED_STRATEGIES.map((strategy) => measure(storefrontUrl, strategy)),
  );

  const measured: PageSpeedReport[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') measured.push(result.value);
    else {
      const reason = result.reason instanceof PageSpeedRunError
        ? result.reason.message
        : 'The measurement could not be completed.';
      failures.push(`${PAGESPEED_STRATEGIES[index]}: ${reason}`);
    }
  });

  if (measured.length > 0) {
    await db.insert(pagespeedReports).values(
      measured.map((report) => ({
        storeId,
        requestedUrl: report.requestedUrl,
        finalUrl: report.finalUrl,
        strategy: report.strategy,
        performanceScore: report.performanceScore,
        lab: report.lab,
        field: report.field,
        opportunities: report.opportunities,
        lighthouseVersion: report.lighthouseVersion,
        analyzedAt: report.analyzedAt ? new Date(report.analyzedAt) : null,
        fetchedAt: new Date(report.fetchedAt),
      })),
    );
  }

  // The row records exactly what happened: a clean run clears the notice, a partial run keeps the
  // half that failed on screen beside the half that worked, and a total failure says so.
  if (measured.length === PAGESPEED_STRATEGIES.length) {
    await markConnectorSynced(storeId, 'pagespeed', storefrontUrl);
  } else if (measured.length > 0) {
    await markConnectorSynced(storeId, 'pagespeed', storefrontUrl, failures.join(' '));
  } else {
    await markConnectorState(storeId, 'pagespeed', 'needs_attention', failures.join(' '));
  }

  if (measured.length === 0) {
    // Every strategy failed for the same underlying reason often enough that relaying one of them
    // is more useful than a generic line. 502: Rankvora AI is fine, Google's answer was not.
    throw new ApiError(502, failures[0] ?? 'The measurement could not be completed.', 'PAGESPEED_RUN_FAILED');
  }

  return getPageSpeedStatus(storeId);
}
