import { api } from '../lib/api';
import { ApiError } from '../lib/api';

/**
 * ─── PageSpeed Insights ──────────────────────────────────────────────
 *
 * Every value here comes from Google's real PageSpeed Insights API through Rankvora AI's backend.
 * There is no sample report, no placeholder metric and no fallback row: a store that has never
 * been measured has no report, and a metric Google did not return is null — never zero, and never
 * borrowed from the other half of the response.
 *
 * THERE IS NO CONNECT CALL HERE, deliberately, and none is missing. PageSpeed Insights measures a
 * public url and asks for no merchant account, so there is nothing to authorise and no token to
 * hold. What the connector does is RUN a measurement of the storefront Shopify confirmed.
 */

export type PageSpeedStrategy = 'mobile' | 'desktop';

/** Lab metrics from one Lighthouse run. Null = Lighthouse produced no value, never zero. */
export interface PageSpeedLab {
  lcpMs: number | null;
  /** Unitless, as Lighthouse reports it. */
  cls: number | null;
  /** Total Blocking Time. Lighthouse's lab proxy for responsiveness — this is NOT INP. */
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  ttiMs: number | null;
  serverResponseMs: number | null;
}

/** One real-user metric: the 75th percentile across real visits, plus Google's verdict on it. */
export interface PageSpeedFieldMetric {
  /** Milliseconds, except CLS which is unitless. */
  p75: number;
  rating: 'good' | 'needs-improvement' | 'poor';
}

export interface PageSpeedField {
  /**
   * `origin` means Google had too few visits to this exact url and reported the whole domain
   * instead. The distinction is shown, never smoothed over — origin numbers describe every page.
   */
  scope: 'url' | 'origin';
  overall: 'good' | 'needs-improvement' | 'poor' | null;
  lcp: PageSpeedFieldMetric | null;
  /** Field-only. There is no lab INP, so this is null whenever there is no real-user data. */
  inp: PageSpeedFieldMetric | null;
  cls: PageSpeedFieldMetric | null;
  fcp: PageSpeedFieldMetric | null;
  ttfb: PageSpeedFieldMetric | null;
}

export interface PageSpeedOpportunity {
  /** Lighthouse audit id, e.g. `render-blocking-resources`. */
  id: string;
  title: string;
  savingsMs: number;
  displayValue: string | null;
}

export interface PageSpeedReport {
  strategy: PageSpeedStrategy;
  requestedUrl: string;
  /** Where Lighthouse ended up after redirects — the page the numbers describe. */
  finalUrl: string | null;
  /** Google's performance category, 0–100. Null when the run produced none. */
  performanceScore: number | null;
  lab: PageSpeedLab;
  /** Null when Google has no sufficient real-user sample — normal for a new or quiet store. */
  field: PageSpeedField | null;
  opportunities: PageSpeedOpportunity[];
  lighthouseVersion: string | null;
  analyzedAt: string | null;
  fetchedAt: string;
}

export interface PageSpeedStatus {
  /** Whether runs use Google's keyed quota. False still means the connector works. */
  keyed: boolean;
  /** The storefront measured. Null = no store connected, so there is nothing to measure. */
  storefrontUrl: string | null;
  reports: PageSpeedReport[];
  lastMeasuredAt: string | null;
  lastError: string | null;
}

export const fetchPageSpeedStatus = () => api.get<PageSpeedStatus>('/pagespeed/status');

/**
 * Runs a real measurement now.
 *
 * SLOW BY NATURE: Google loads the storefront in a headless browser on its own hardware, and tens
 * of seconds is normal for both strategies. Callers must say so while they wait rather than show
 * a spinner that looks stuck.
 */
export const runPageSpeedMeasurement = () => api.post<PageSpeedStatus>('/pagespeed/run', {});

/**
 * Why a measurement or a status read failed, in words that point at the fix.
 *
 * The backend already writes merchant-facing sentences for everything Google refused — quota,
 * an unreachable storefront, a Lighthouse runtime error — so those are relayed as they are. What
 * is handled here is the layer below: an API that is not running, a session that expired, and a
 * server still serving a build without these routes, none of which the backend can report on.
 */
export function describePageSpeedFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the Rankvora AI API. Check that the backend is running and that the app is pointed at it.';
  }
  if (error.status === 404) {
    return error.code === 'STORE_NOT_FOUND'
      ? 'This account has no store yet. Connect your Shopify store first — PageSpeed Insights measures your public storefront.'
      : 'This server has no PageSpeed Insights endpoint. The API is running an older build — redeploy and restart it.';
  }
  if (error.status === 401) return 'Your session has expired. Open Rankvora AI again from your Shopify admin.';
  // 409 (no storefront), 502 (Google refused or could not finish) and the rest already carry a
  // sentence written for the merchant.
  return error.message;
}

// ─── Formatting ──────────────────────────────────────────────────────
// Kept beside the types so the card and anything else reading these numbers render them the same
// way. Every function takes a real measured value; none of them invents one for a null.

export function formatMilliseconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** CLS is unitless and small — three decimals, because 0.09 and 0.11 sit either side of "good". */
export function formatCls(value: number): string {
  return value.toFixed(3);
}

export function formatMeasuredAt(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
