import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiFixProposals, findings } from '../db/schema.js';
import { lcpRating } from '../audit-engine/checks/speed/cwv.js';
import { googleConfigured } from '../config/env.js';
import { describeError } from '../lib/logger.js';
import { ApiError } from '../middleware/error.js';
import { latestAuditCondition } from './finding.service.js';
import { getPageSpeedStatus, type PageSpeedReport } from './pagespeed.service.js';
import { getPromptHistory, type PromptHistory } from './prompt-history.service.js';
import { getSearchConsoleClicks } from './search-console.service.js';
import { getCurrentStoreId } from './store.service.js';

/**
 * ─── The four outcome cards under the pillars on the dashboard ───────
 *
 * Organic search clicks, mobile LCP, AI mention rate and drafts awaiting approval. The pillar cards
 * above them say how well the store is PREPARED; these say what is actually HAPPENING — what Google
 * sent, how fast real visitors found the page, how often an assistant named the store, and what is
 * waiting on the merchant.
 *
 * ─── EVERY FIGURE IS READ, NEVER STAND-IN ────────────────────────────
 * Each signal is either `ready`, carrying numbers that came from Google, from Google's own Chrome
 * UX data, from recorded assistant answers or from a database count — or `unavailable`, carrying the
 * one reason it is not ready and the sentence the card shows. A store that has not connected Search
 * Console gets "connect it", not a zero; a store that never ran a prompt check gets "no checks yet",
 * not 0%. Nothing here is defaulted, estimated or carried over from another store.
 *
 * ─── EACH SIGNAL FAILS ALONE ─────────────────────────────────────────
 * Google being slow or refusing must not blank the other three, so every signal is read inside its
 * own try. An error nobody anticipated is logged (without bound values — see describeError) and the
 * card says it could not be read right now; the cause stays in the log, not on the merchant's screen.
 */

/** The window every card describes, and its label on screen. */
export const SIGNAL_WINDOW_DAYS = 28;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SignalReason =
  | 'not_configured'
  | 'not_connected'
  | 'no_property'
  | 'not_measured'
  | 'no_queries'
  | 'no_data'
  | 'error';

export type Signal<T> =
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; reason: SignalReason; message: string };

const ready = <T>(data: T): Signal<T> => ({ status: 'ready', data });
const unavailable = (reason: SignalReason, message: string): Signal<never> => ({ status: 'unavailable', reason, message });

export interface SearchTrafficSignal {
  siteUrl: string;
  days: number;
  startDate: string;
  endDate: string;
  clicks: number;
  previousClicks: number;
  /** Percent change against the window before, one decimal. Null when that window had no clicks to compare with. */
  changePercent: number | null;
}

export interface MobileSpeedSignal {
  /** `field` = real visitors (Chrome UX Report, 75th percentile); `lab` = one Lighthouse run. */
  source: 'field' | 'lab';
  lcpMs: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  /** Field only: `origin` means Google had too few visits to this page and reported the whole domain. */
  scope: 'url' | 'origin' | null;
  measuredAt: string;
}

export interface AiMentionSignal {
  days: number;
  /** mentions ÷ samples, a fraction. */
  rate: number;
  mentions: number;
  samples: number;
  /** True when there are fewer answers than the floor the prompt-tracking check uses. */
  provisional: boolean;
  minSamples: number;
  previousRate: number | null;
  /** Percentage points against the window before. Null unless BOTH windows are settled. */
  changePoints: number | null;
}

export interface ApprovalArea {
  pillar: string;
  subPillar: string;
  count: number;
}

export interface ApprovalSignal {
  total: number;
  /** Where the waiting drafts are, largest first. */
  areas: ApprovalArea[];
}

export interface DashboardSignals {
  searchTraffic: Signal<SearchTrafficSignal>;
  mobileSpeed: Signal<MobileSpeedSignal>;
  aiMentions: Signal<AiMentionSignal>;
  approvals: Signal<ApprovalSignal>;
}

// ─── Pure shaping, tested on its own ─────────────────────────────────

/** `current` against `previous`, in percent to one decimal — null when there is nothing to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  const value = Math.round(((current - previous) / previous) * 1000) / 10;
  // -0 would print as "0" in JSON anyway, but an equal pair should read as exactly no change.
  return value === 0 ? 0 : value;
}

/**
 * Mobile LCP from what the last PageSpeed measurement stored.
 *
 * FIELD FIRST. Real visitors' 75th percentile is what Search Console and Google's ranking see, and it
 * carries Google's own rating. A new or quiet store has none — a fact about sample size, not speed —
 * so the lab LCP of the last Lighthouse run is used and SAYS it is lab (`source`), rated the way the
 * audit's own Core Web Vitals check rates a lab value.
 */
export function mobileSpeedSignal(reports: PageSpeedReport[]): Signal<MobileSpeedSignal> {
  const mobile = reports.find((report) => report.strategy === 'mobile');
  if (!mobile) {
    return unavailable('not_measured', 'Run a PageSpeed test to measure mobile speed.');
  }
  const measuredAt = mobile.analyzedAt ?? mobile.fetchedAt;

  const field = mobile.field?.lcp;
  if (field && mobile.field) {
    return ready({ source: 'field', lcpMs: field.p75, rating: field.rating, scope: mobile.field.scope, measuredAt });
  }
  if (mobile.lab.lcpMs !== null) {
    return ready({ source: 'lab', lcpMs: mobile.lab.lcpMs, rating: lcpRating(mobile.lab.lcpMs), scope: null, measuredAt });
  }
  return unavailable('no_data', 'The last mobile test returned no Largest Contentful Paint.');
}

/**
 * The AI mention rate for the last `days` days, set against the `days` before — from the recorded
 * answers `getPromptHistory` already aggregates, split by date.
 *
 * `history` must be a daily one covering at least `2 × days` (so ≤ 120 days). The two windows are
 * adjacent and equally long, and a day with no answers contributes nothing to either — it is a gap,
 * not a zero.
 *
 * A rate from fewer answers than `minSamples` is returned, flagged `provisional`, and never
 * compared: two answers swinging between 0% and 50% is noise, and "+50 points" built on it would be
 * a story the data does not tell.
 */
export function aiMentionSignal(history: PromptHistory, days = SIGNAL_WINDOW_DAYS): Signal<AiMentionSignal> {
  if (history.totalSamples === 0) {
    if (!history.aiConfigured) return unavailable('not_configured', 'AI mention tracking is not set up on this server.');
    if (history.queries.length === 0) return unavailable('no_queries', 'Add the questions your shoppers ask to start measuring.');
    return unavailable('no_data', 'No assistant answers have been sampled yet.');
  }

  const end = Date.parse(`${history.endDate}T00:00:00Z`);
  const currentStart = end - (days - 1) * MS_PER_DAY;
  const previousStart = currentStart - days * MS_PER_DAY;

  const current = { samples: 0, mentions: 0 };
  const previous = { samples: 0, mentions: 0 };
  for (const bucket of history.series) {
    const day = Date.parse(`${bucket.date}T00:00:00Z`);
    const into = day >= currentStart && day <= end ? current : day >= previousStart && day < currentStart ? previous : null;
    if (!into) continue;
    into.samples += bucket.samples;
    into.mentions += bucket.mentions;
  }

  if (current.samples === 0) {
    return unavailable('no_data', `No assistant answers were sampled in the last ${days} days.`);
  }

  const rate = current.mentions / current.samples;
  const provisional = current.samples < history.minSamples;
  const previousRate = previous.samples >= history.minSamples ? previous.mentions / previous.samples : null;

  return ready({
    days,
    rate,
    mentions: current.mentions,
    samples: current.samples,
    provisional,
    minSamples: history.minSamples,
    previousRate,
    changePoints: !provisional && previousRate !== null ? Math.round((rate - previousRate) * 100) : null,
  });
}

// ─── The reads ───────────────────────────────────────────────────────

async function searchTrafficSignal(storeId: number): Promise<Signal<SearchTrafficSignal>> {
  if (!googleConfigured()) return unavailable('not_configured', 'Google Search Console is not set up on this server.');
  try {
    const result = await getSearchConsoleClicks(storeId, SIGNAL_WINDOW_DAYS);
    return ready({
      siteUrl: result.siteUrl,
      days: SIGNAL_WINDOW_DAYS,
      startDate: result.startDate,
      endDate: result.endDate,
      clicks: result.clicks,
      previousClicks: result.previousClicks,
      changePercent: percentChange(result.clicks, result.previousClicks),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'GOOGLE_NOT_CONNECTED') return unavailable('not_connected', 'Connect Google Search Console to see organic clicks.');
      if (error.code === 'GOOGLE_SITE_NOT_SELECTED') return unavailable('no_property', 'Choose which Search Console property this store reports on.');
      // Google's own refusal, already worded for the merchant and free of the account or property.
      return unavailable('error', error.message);
    }
    throw error;
  }
}

async function mobileSpeedFor(storeId: number): Promise<Signal<MobileSpeedSignal>> {
  return mobileSpeedSignal((await getPageSpeedStatus(storeId)).reports);
}

async function aiMentionsFor(storeId: number): Promise<Signal<AiMentionSignal>> {
  // Twice the window, so the one before it comes from the same read.
  return aiMentionSignal(await getPromptHistory(storeId, SIGNAL_WINDOW_DAYS * 2), SIGNAL_WINDOW_DAYS);
}

/**
 * Drafts the merchant has not yet decided on.
 *
 * Only `proposed` rows — approved-and-failed or rejected ones are decided. Only drafts on findings of
 * the store's NEWEST audit that are still outstanding: a re-run writes a fresh set of findings, and a
 * draft on a superseded or dismissed one is not something to approve.
 */
async function approvalsFor(storeId: number): Promise<Signal<ApprovalSignal>> {
  const rows = await db
    .select({ pillar: findings.pillar, subPillar: findings.subPillar, waiting: sql<number>`count(*)` })
    .from(aiFixProposals)
    .innerJoin(findings, eq(findings.id, aiFixProposals.findingId))
    .where(and(
      eq(aiFixProposals.storeId, storeId),
      eq(aiFixProposals.status, 'proposed'),
      latestAuditCondition(storeId),
      inArray(findings.status, ['open', 'reviewed']),
    ))
    .groupBy(findings.pillar, findings.subPillar)
    .orderBy(desc(sql`count(*)`), findings.pillar, findings.subPillar);

  const areas = rows.map((row) => ({ pillar: row.pillar, subPillar: row.subPillar, count: Number(row.waiting) }));
  return ready({ total: areas.reduce((sum, area) => sum + area.count, 0), areas });
}

/** One signal, isolated: an unexpected failure becomes that card's "could not be read", and is logged. */
async function isolated<T>(name: string, read: () => Promise<Signal<T>>): Promise<Signal<T>> {
  try {
    return await read();
  } catch (error) {
    console.error(`[rankvora-dashboard] ${name} could not be read: ${describeError(error)}`);
    return unavailable('error', 'This could not be read right now. Try again shortly.');
  }
}

export async function getDashboardSignals(userId: number, requestedStoreId?: number): Promise<DashboardSignals> {
  const storeId = await getCurrentStoreId(userId, requestedStoreId);
  const [searchTraffic, mobileSpeed, aiMentions, approvals] = await Promise.all([
    isolated('search traffic', () => searchTrafficSignal(storeId)),
    isolated('mobile speed', () => mobileSpeedFor(storeId)),
    isolated('ai mentions', () => aiMentionsFor(storeId)),
    isolated('approvals', () => approvalsFor(storeId)),
  ]);
  return { searchTraffic, mobileSpeed, aiMentions, approvals };
}
