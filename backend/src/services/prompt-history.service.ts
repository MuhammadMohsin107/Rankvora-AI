import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { promptChecks, promptQueries } from '../db/schema.js';
import { CRITICAL_RATE, HEALTHY_RATE, MIN_SAMPLES } from '../audit-engine/checks/ai-discovery/prompt-tracking.js';
import { aiConfigured } from '../config/env.js';

/**
 * ─── Prompt tracking · the trend, not the snapshot ───────────────────
 *
 * The prompt-tracking CHECK answers "how visible is this store in assistant answers right now".
 * This answers "is that getting better or worse", which is the question a merchant asks the moment
 * after they act on the first one.
 *
 * Every row aggregated here is a real recorded API call — one row of prompt_checks, written at the
 * moment the model answered. Nothing is interpolated between buckets, nothing is back-filled, and
 * no bucket is invented for a day on which nothing was asked.
 *
 * ─── THE THREE RULES THIS INHERITS FROM THE CHECK ────────────────────
 * They are not optional here just because this is a chart rather than a score:
 *
 *   1. A RATE, NEVER A RANK. Each bucket reports mentions ÷ samples. There is no position anywhere
 *      in this file, because no position was ever observed.
 *   2. A MINIMUM SAMPLE. A bucket below MIN_SAMPLES is returned with `provisional: true` and the
 *      UI must render it as unsettled. An LLM is non-deterministic; two samples swinging between
 *      0% and 50% is noise, and a chart that plots it as a trend manufactures a story.
 *   3. NO SAMPLES IS NOT ZERO. A day with no checks produces NO BUCKET. It is absent from the
 *      series rather than plotted at 0%, because a line dropping to the floor on a day nobody ran
 *      a sweep is a fabricated collapse.
 *
 * A store that has never run a sweep gets an empty series and `totalSamples: 0`. That is the
 * honest empty state the UI renders from, not a flat line at zero.
 */

/** Longest window offered. Beyond this the daily buckets stop being readable anyway. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

/** Above this many days, buckets are weekly — a year of daily points is unreadable and mostly gaps. */
const WEEKLY_THRESHOLD_DAYS = 120;

export interface PromptHistoryBucket {
  /** ISO date (YYYY-MM-DD). For weekly buckets, the Monday the week starts on. */
  date: string;
  samples: number;
  mentions: number;
  /** mentions ÷ samples. Always a real fraction of real observations. */
  rate: number;
  /** True when this bucket holds fewer than MIN_SAMPLES — render it as unsettled, not as a value. */
  provisional: boolean;
}

export interface PromptQueryTrend {
  queryId: number;
  query: string;
  brandTerm: string;
  active: boolean;
  samples: number;
  mentions: number;
  /** Null when there are no samples at all — never checked is not a zero rate. */
  rate: number | null;
  provisional: boolean;
  /** The most recent observation's timestamp, or null when never checked. */
  lastCheckedAt: string | null;
}

export interface PromptHistory {
  /** Days actually covered by the query, so the UI never labels a window it did not read. */
  days: number;
  granularity: 'day' | 'week';
  startDate: string;
  endDate: string;
  /** Buckets with at least one real observation, oldest first. Gaps are gaps. */
  series: PromptHistoryBucket[];
  totalSamples: number;
  totalMentions: number;
  /** Overall rate across the window, or null when nothing was sampled. */
  overallRate: number | null;
  /** Per-question breakdown for the same window. */
  queries: PromptQueryTrend[];
  /** The sample floor the check uses, so the UI can explain why a bucket is unsettled. */
  minSamples: number;
  /** The check's own grading bands, so the UI colours a rate by them rather than by a copy. */
  healthyRate: number;
  criticalRate: number;
  /**
   * Whether this Rankvora AI deployment can ask a model at all.
   *
   * Carried so an empty trend can say WHICH of three things is missing. Without it the panel had
   * one sentence for all of them — "add the questions your shoppers ask, then run a sweep" — which
   * is advice for a merchant who has added none, an instruction to repeat work for one who already
   * has, and actively misleading for a store whose server has no AI key: it blames them for an
   * operator's configuration and points them at a button that is disabled.
   */
  aiConfigured: boolean;
  /** Placement against the merchant's own competitor list. See RankingStanding. */
  ranking: RankingStanding;
}

/** One competitor's presence across the window, measured against the store's own. */
export interface CompetitorStanding {
  /** The exact term that matched — derived from a domain the merchant entered, never invented. */
  term: string;
  /** Answers in which this competitor was named. */
  named: number;
  /** Answers naming them but NOT the store. The actionable number. */
  namedWithoutUs: number;
  /** Answers in which they appeared AHEAD of the store. */
  aheadOfUs: number;
  /** Mean position across the answers naming them, 0 (start) to 1 (end). */
  averagePosition: number;
}

/**
 * ─── Where the store stands against its named competitors ────────────
 *
 * THIS IS NOT "YOUR CHATGPT RANKING" AND NEVER CLAIMS TO BE. It is the store's placement among
 * tracked brands in real recorded answers to the merchant's own questions. An assistant's answer
 * is non-deterministic, so a single observation means nothing and only the distribution across
 * samples does — which is why every figure travels with the count it was computed from.
 *
 * `configured: false` means the merchant listed no competitors during onboarding. Every derived
 * field is then null, because without a comparison set there is no standing to report: "first of
 * one" is the absence of a comparison, not a win, and presenting it as one would show every store
 * leading every answer it appears in.
 */
export interface RankingStanding {
  configured: boolean;
  /** Answers in the window that carried a comparison set, so a rank could be observed at all. */
  rankedAnswers: number;
  /** Mean 1-based ordinal across answers where the store WAS named. Null when it never was. */
  averageRank: number | null;
  /**
   * Mean tracked brands named, over the SAME answers `averageRank` is taken from — the ones that
   * named the store. Null when it never was. It is the denominator the rank is read against, so it
   * must describe the same answers: averaged over every answer instead, it mixed in answers the
   * store was absent from and could print "3.0 of 1.0", a rank above its own denominator.
   */
  averageBrandsNamed: number | null;
  /** Answers where the store was named first. */
  timesFirst: number;
  /**
   * Mean position of the store's own mention, 0 (start of answer) to 1 (end). Null when never
   * named. Assistants lead with their strongest recommendation, so lower is better.
   */
  averagePosition: number | null;
  /** Answers naming at least one competitor but not the store. The clearest gap to act on. */
  answersLostEntirely: number;
  /** Per-competitor standings, most-often-named first. */
  competitors: CompetitorStanding[];
}

/** One competitor placement as stored on a prompt_checks row. */
interface StoredCompetitor {
  term: string;
  position: number;
}

/** Narrows the json column, which the driver returns as `unknown`. A malformed row yields none. */
function storedCompetitors(raw: unknown): StoredCompetitor[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is StoredCompetitor =>
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as StoredCompetitor).term === 'string'
      && typeof (entry as StoredCompetitor).position === 'number',
  );
}

/** drizzle returns `numeric` columns as strings; null stays null rather than collapsing to 0. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mean of a list, or null when empty — never 0, which would read as a measurement. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** YYYY-MM-DD in UTC. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The Monday of the ISO week a date falls in, in UTC. */
function weekStart(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay(): 0 = Sunday. Shift so Monday is 0.
  const offset = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - offset);
  return isoDate(copy);
}

/** The columns of one prompt_checks row that placement is computed from. */
export interface RankingObservation {
  mentioned: boolean;
  mentionPosition: unknown;
  brandRank: number | null;
  brandsNamed: number | null;
  competitorsNamed: unknown;
}

/**
 * Where the store stands against its competitors across a set of recorded answers.
 *
 * A pure function of the rows, kept out of getPromptHistory so it can be tested without a
 * database — it is where "3.0 of 1.0" came from, and a figure like that needs a test to stay gone.
 */
export function rankingStanding(checks: RankingObservation[]): RankingStanding {
  // Only rows that actually carried a comparison set can contribute a rank. Rows written before
  // competitors were configured — or before this column existed — hold null and are excluded
  // rather than counted as a win or a loss.
  const ranked = checks.filter((check) => check.brandsNamed !== null);
  // The answers that named the store, where both a rank and its denominator were observed.
  const placed = ranked.filter((check) => check.brandRank !== null);
  const ownRanks = placed.map((check) => check.brandRank as number);
  const ownPositions = checks
    .map((check) => toNumber(check.mentionPosition))
    .filter((position): position is number => position !== null);

  // Accumulated per competitor term across every answer that named them.
  const byCompetitor = new Map<string, { named: number; namedWithoutUs: number; aheadOfUs: number; positions: number[] }>();
  let answersLostEntirely = 0;

  for (const check of ranked) {
    const competitors = storedCompetitors(check.competitorsNamed);
    const ownPosition = toNumber(check.mentionPosition);
    if (competitors.length > 0 && !check.mentioned) answersLostEntirely += 1;

    for (const competitor of competitors) {
      const entry = byCompetitor.get(competitor.term)
        ?? { named: 0, namedWithoutUs: 0, aheadOfUs: 0, positions: [] };
      entry.named += 1;
      entry.positions.push(competitor.position);
      if (!check.mentioned) entry.namedWithoutUs += 1;
      // "Ahead" is only meaningful when both appeared in the same answer.
      else if (ownPosition !== null && competitor.position < ownPosition) entry.aheadOfUs += 1;
      byCompetitor.set(competitor.term, entry);
    }
  }

  return {
    // Configured is a property of the DATA, not of the settings: a window whose answers all carried
    // a comparison set is one where competitors were configured when they were recorded.
    configured: ranked.length > 0,
    rankedAnswers: ranked.length,
    averageRank: mean(ownRanks),
    // Over the SAME answers as averageRank — see RankingStanding.averageBrandsNamed.
    averageBrandsNamed: mean(placed.map((check) => check.brandsNamed as number)),
    timesFirst: ownRanks.filter((rank) => rank === 1).length,
    averagePosition: mean(ownPositions),
    answersLostEntirely,
    competitors: [...byCompetitor.entries()]
      .map(([term, entry]) => ({
        term,
        named: entry.named,
        namedWithoutUs: entry.namedWithoutUs,
        aheadOfUs: entry.aheadOfUs,
        // Safe: an entry only exists once at least one position was pushed.
        averagePosition: entry.positions.reduce((sum, value) => sum + value, 0) / entry.positions.length,
      }))
      .sort((a, b) => b.named - a.named || a.term.localeCompare(b.term)),
  };
}

/**
 * The store's recorded assistant observations, bucketed over time.
 *
 * One read of prompt_checks and one of prompt_queries, then grouped in memory: a per-query round
 * trip would be N+1 queries for a page that renders them together, and the aggregate has to be
 * computed across queries anyway.
 */
export async function getPromptHistory(storeId: number, days = DEFAULT_DAYS): Promise<PromptHistory> {
  const window = Math.max(7, Math.min(MAX_DAYS, Math.trunc(days) || DEFAULT_DAYS));
  const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);
  const granularity: 'day' | 'week' = window > WEEKLY_THRESHOLD_DAYS ? 'week' : 'day';

  const [checks, queries] = await Promise.all([
    db
      .select()
      .from(promptChecks)
      .where(and(eq(promptChecks.storeId, storeId), gte(promptChecks.checkedAt, since)))
      .orderBy(desc(promptChecks.checkedAt)),
    db.select().from(promptQueries).where(eq(promptQueries.storeId, storeId)).orderBy(promptQueries.id),
  ]);

  // ── Time buckets ──
  // Keyed by the bucket's own date. A day with no checks never creates a key, which is what makes
  // a gap a gap rather than a zero.
  const buckets = new Map<string, { samples: number; mentions: number }>();
  // ── Per-query rollup ──
  const perQuery = new Map<number, { samples: number; mentions: number; lastCheckedAt: Date | null }>();

  for (const check of checks) {
    const key = granularity === 'week' ? weekStart(check.checkedAt) : isoDate(check.checkedAt);
    const bucket = buckets.get(key) ?? { samples: 0, mentions: 0 };
    bucket.samples += 1;
    if (check.mentioned) bucket.mentions += 1;
    buckets.set(key, bucket);

    const query = perQuery.get(check.queryId) ?? { samples: 0, mentions: 0, lastCheckedAt: null };
    query.samples += 1;
    if (check.mentioned) query.mentions += 1;
    // Rows arrive newest-first, so the first one seen for a query is its latest.
    query.lastCheckedAt ??= check.checkedAt;
    perQuery.set(check.queryId, query);
  }

  const series: PromptHistoryBucket[] = [...buckets.entries()]
    .map(([date, bucket]) => ({
      date,
      samples: bucket.samples,
      mentions: bucket.mentions,
      rate: bucket.mentions / bucket.samples,
      provisional: bucket.samples < MIN_SAMPLES,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalSamples = checks.length;
  const totalMentions = checks.filter((check) => check.mentioned).length;

  const ranking = rankingStanding(checks);

  return {
    days: window,
    granularity,
    startDate: isoDate(since),
    endDate: isoDate(new Date()),
    series,
    totalSamples,
    totalMentions,
    // Null rather than 0 when nothing was sampled: "never asked" and "asked and never mentioned"
    // are different facts and the UI renders them differently.
    overallRate: totalSamples > 0 ? totalMentions / totalSamples : null,
    queries: queries.map((query) => {
      const rollup = perQuery.get(query.id);
      const samples = rollup?.samples ?? 0;
      return {
        queryId: query.id,
        query: query.query,
        brandTerm: query.brandTerm,
        active: query.active,
        samples,
        mentions: rollup?.mentions ?? 0,
        rate: samples > 0 ? (rollup?.mentions ?? 0) / samples : null,
        provisional: samples < MIN_SAMPLES,
        lastCheckedAt: rollup?.lastCheckedAt ? rollup.lastCheckedAt.toISOString() : null,
      };
    }),
    minSamples: MIN_SAMPLES,
    healthyRate: HEALTHY_RATE,
    criticalRate: CRITICAL_RATE,
    aiConfigured: aiConfigured(),
    ranking,
  };
}
