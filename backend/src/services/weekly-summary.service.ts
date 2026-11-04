import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insertReturning } from '../db/returning.js';
import { audits, findings, notifications, stores, users } from '../db/schema.js';
import { env } from '../config/env.js';
import { hasStoreDataSource } from '../audit-engine/store-data/index.js';
import { pillarLabel } from '../lib/report-labels.js';
import { describeError } from '../lib/logger.js';
import { NOTIFICATION_LINKS, largestPillarMove, pillarScores, safeNotificationLink, type PillarMove } from './notification.service.js';

/**
 * ─── Weekly summary ──────────────────────────────────────────────────
 *
 * Every Monday, in the store's own timezone, one notice in the bell saying what the past seven days
 * of real audits showed: where the overall score went, which pillar moved most, and which open
 * issue to start on.
 *
 * THE SETTING ALREADY EXISTED. `users.notify_weekly_summary` was a column, Settings offered the
 * toggle — switched ON by default — and guided setup offered "Weekly summary" as an alert choice,
 * which also switched OFF the per-audit notices in its favour. Nothing anywhere wrote a summary, so
 * a merchant who picked it was told less, not differently. This is what makes that choice real.
 *
 * EVERY NUMBER IS READ, NONE IS ASSUMED. Scores come from `audits` and `audit_scores`, the issue
 * counts and the one to start with from `findings` — the same open/reviewed statuses and the same
 * severity-then-reach order the Fix Center's priority list uses. Only engine audits count: a seeded
 * development fixture is not a measurement of this store. A store that has never been analysed
 * gets no summary at all, because there is nothing true to summarise.
 *
 * ONCE PER WEEK, TRACKED ON THE STORE. `stores.weekly_summary_at` records when the last one was
 * written. It cannot be derived from the notifications table: a merchant can delete the notice,
 * and a summary whose only record is the row they removed would be written again on the next sweep.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Finding statuses that still need work — the set the Fix Center's priority list reads. */
const OPEN_STATUSES = ['open', 'reviewed'];

/** The same severity ladder the Fix Center orders by. A varchar sorted DESC would be alphabetical. */
const severityOrder = sql`CASE ${findings.severity} WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 0 END`;

// ─── When one is due ─────────────────────────────────────────────────

/**
 * A timezone Intl can use: the store's own IANA zone, or UTC when the stored value is not one.
 *
 * 'Unspecified' is the honest "Shopify did not say" state, and older rows can hold a label like
 * "(UTC+05:00) Karachi". Neither is a zone, and guessing one would move the summary to a day the
 * merchant never chose. UTC is the stated fallback, not a guess about where the store is.
 */
export function resolveTimeZone(value: string | null | undefined): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

function localDay(date: Date, timeZone: string): { key: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return { key: `${part('year')}-${part('month')}-${part('day')}`, weekday: part('weekday') };
}

/**
 * Whether a store's summary should be written now: it is Monday where the store is, and none has
 * been written yet on this Monday.
 *
 * Pure, and the whole scheduling decision, so it is tested directly rather than through a sweep.
 * A Monday the process spent entirely down is skipped rather than made up on Tuesday: Settings
 * promises a Monday summary, and the sweep runs every half hour, so only a day-long outage misses one.
 */
export function isWeeklySummaryDue(lastWrittenAt: Date | null, now: Date, timeZone: string): boolean {
  const today = localDay(now, timeZone);
  if (today.weekday !== 'Mon') return false;
  if (!lastWrittenAt) return true;
  return localDay(lastWrittenAt, timeZone).key !== today.key;
}

// ─── What it says ────────────────────────────────────────────────────

/** Everything a summary is written from. Every field is read from the database. */
export interface WeeklySummaryInput {
  /** Engine audits whose run falls in the seven days before now. */
  auditsThisWeek: number;
  /** The store's newest engine audit, whenever it ran. Null when it has never been analysed. */
  latest: { overallScore: number; runAt: Date } | null;
  /** The newest engine audit from BEFORE the week — what the week is measured against. */
  baseline: { overallScore: number } | null;
  /** The pillar that moved most between `baseline` and `latest`. Null when none moved. */
  pillarMove: PillarMove | null;
  /** Open and reviewed findings of the latest audit. */
  open: { total: number; critical: number; high: number };
  /** The one to start with: most severe first, then the one reaching the most items. */
  topFinding: { title: string; severity: string } | null;
  timeZone: string;
}

export interface WeeklySummaryCopy {
  title: string;
  message: string;
  link: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The wording of a summary, from real counts. Null when there is nothing true to say — a store
 * that has never been analysed.
 *
 * Pure, so each variant is tested against the exact sentence a merchant reads.
 */
export function weeklySummaryCopy(input: WeeklySummaryInput): WeeklySummaryCopy | null {
  const { latest } = input;
  if (!latest) return null;

  const sentences: string[] = [];
  let title: string;

  if (input.auditsThisWeek === 0) {
    // Said plainly rather than skipped: a week with no audit is itself worth knowing — the
    // schedule may be off, or the connection may have stopped them.
    const measuredOn = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(latest.runAt);
    title = 'Weekly summary: no audit ran this week';
    sentences.push(`Your latest overall score is ${latest.overallScore}, from the audit on ${measuredOn}.`);
  } else if (!input.baseline) {
    // Every audit this store has is from this week, so there is no "before" to compare with.
    title = `Weekly summary: overall score ${latest.overallScore}`;
    sentences.push(
      input.auditsThisWeek === 1
        ? `Rankvora AI analysed your store for the first time this week. It scored ${latest.overallScore} overall.`
        : `Rankvora AI analysed your store for the first time this week, ${plural(input.auditsThisWeek, 'time', 'times')} in all. The latest audit scored ${latest.overallScore} overall.`,
    );
  } else {
    const from = input.baseline.overallScore;
    const to = latest.overallScore;
    const delta = to - from;
    title = delta > 0
      ? `Weekly summary: score up ${delta} to ${to}`
      : delta < 0
        ? `Weekly summary: score down ${Math.abs(delta)} to ${to}`
        : `Weekly summary: score steady at ${to}`;
    const ran = `${plural(input.auditsThisWeek, 'audit', 'audits')} ran this week.`;
    sentences.push(delta === 0 ? `${ran} Your overall score held at ${to}.` : `${ran} Your overall score moved from ${from} to ${to}.`);

    if (input.pillarMove) {
      const move = input.pillarMove;
      sentences.push(`${pillarLabel(move.pillar)} moved the most, from ${move.from} to ${move.to}.`);
    }
  }

  if (input.open.total === 0) {
    sentences.push('No issues are open from the latest audit.');
  } else {
    const severe = [
      input.open.critical > 0 ? `${input.open.critical} critical` : null,
      input.open.high > 0 ? `${input.open.high} high` : null,
    ].filter(Boolean);
    sentences.push(`${plural(input.open.total, 'issue is', 'issues are')} open${severe.length > 0 ? ` — ${severe.join(' and ')}` : ''}.`);
    if (input.topFinding) sentences.push(`Start with "${input.topFinding.title}".`);
  }

  return {
    title,
    message: sentences.join(' '),
    // The issue it says to start with, or — with nothing open — the reports the scores came from.
    link: input.topFinding ? NOTIFICATION_LINKS.issues : NOTIFICATION_LINKS.reports,
  };
}

// ─── Reading it ──────────────────────────────────────────────────────

/** Reads everything a store's summary is written from, for the seven days before `now`. */
export async function collectWeeklySummaryInput(storeId: number, timeZone: string, now: Date): Promise<WeeklySummaryInput> {
  const weekStart = new Date(now.getTime() - WEEK_MS);
  const engineAudits = and(eq(audits.storeId, storeId), eq(audits.source, 'engine'));
  const auditColumns = { id: audits.id, overallScore: audits.overallScore, runAt: audits.runAt };

  const [[latest], [baseline], [week]] = await Promise.all([
    db.select(auditColumns).from(audits).where(engineAudits).orderBy(desc(audits.runAt), desc(audits.id)).limit(1),
    db.select(auditColumns).from(audits).where(and(engineAudits, lt(audits.runAt, weekStart))).orderBy(desc(audits.runAt), desc(audits.id)).limit(1),
    db.select({ value: count() }).from(audits).where(and(engineAudits, gte(audits.runAt, weekStart))),
  ]);

  const empty: WeeklySummaryInput = {
    auditsThisWeek: 0,
    latest: null,
    baseline: null,
    pillarMove: null,
    open: { total: 0, critical: 0, high: 0 },
    topFinding: null,
    timeZone,
  };
  if (!latest) return empty;

  const auditsThisWeek = week?.value ?? 0;
  const openFindings = and(eq(findings.auditId, latest.id), inArray(findings.status, OPEN_STATUSES));

  const [bySeverity, [topFinding], pillarMove] = await Promise.all([
    db.select({ severity: findings.severity, value: count() }).from(findings).where(openFindings).groupBy(findings.severity),
    db.select({ title: findings.title, severity: findings.severity }).from(findings).where(openFindings)
      .orderBy(severityOrder, desc(findings.affectedCount), desc(findings.id)).limit(1),
    // Only when the week has something to compare: its own audit, and one from before it.
    auditsThisWeek > 0 && baseline
      ? Promise.all([pillarScores(latest.id), pillarScores(baseline.id)]).then(([current, before]) => largestPillarMove(current, before, 0))
      : Promise.resolve(null),
  ]);

  const severityCount = (severity: string) => bySeverity.find((row) => row.severity === severity)?.value ?? 0;

  return {
    auditsThisWeek,
    latest: { overallScore: latest.overallScore, runAt: latest.runAt },
    baseline: auditsThisWeek > 0 && baseline ? { overallScore: baseline.overallScore } : null,
    pillarMove,
    open: {
      total: bySeverity.reduce((sum, row) => sum + row.value, 0),
      critical: severityCount('critical'),
      high: severityCount('high'),
    },
    topFinding: topFinding ?? null,
    timeZone,
  };
}

// ─── Writing it ──────────────────────────────────────────────────────

/**
 * The stamp is kept at whole seconds, as it always has been: stamps copied from the MySQL database
 * (whose DATETIME kept whole seconds) and new ones then compare the same way. The claim below matches
 * the stored stamp exactly, so what is written must be what is read back.
 */
function wholeSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Writes one store's summary. True when a notice was written.
 *
 * THE WEEK IS CLAIMED BEFORE THE NOTICE IS WRITTEN. The stamp is set only if it still holds the
 * value this sweep read, so two sweeps — two processes, or one that overran into the next tick —
 * cannot both write this Monday's summary. If the notice then fails to insert, the claim is handed
 * back so a later sweep the same day can try again.
 */
export async function writeWeeklySummary(storeId: number, previousStamp: Date | null, timeZone: string, now: Date): Promise<boolean> {
  const copy = weeklySummaryCopy(await collectWeeklySummaryInput(storeId, timeZone, now));
  if (!copy) return false;

  const stamp = wholeSeconds(now);
  const claimed = await db
    .update(stores)
    .set({ weeklySummaryAt: stamp })
    .where(and(eq(stores.id, storeId), previousStamp ? eq(stores.weeklySummaryAt, previousStamp) : isNull(stores.weeklySummaryAt)))
    .returning({ id: stores.id });
  if (claimed.length !== 1) return false;

  try {
    await insertReturning(notifications, {
      storeId,
      type: 'weekly_summary',
      title: copy.title,
      message: copy.message,
      tone: 'info',
      link: safeNotificationLink(copy.link),
    });
    return true;
  } catch (error) {
    await db
      .update(stores)
      .set({ weeklySummaryAt: previousStamp })
      .where(and(eq(stores.id, storeId), eq(stores.weeklySummaryAt, stamp)));
    throw error;
  }
}

export interface WeeklySummarySweep {
  /** Stores whose owner has the weekly summary switched on. */
  considered: number;
  /** Summaries actually written this sweep. */
  written: number;
  /** Due, but not written — no live connection, never analysed, claimed elsewhere, or an error. */
  skipped: number;
}

/**
 * Writes the summary for every store where it is Monday and none has been written today.
 *
 * NEVER THROWS. It is called from a timer with no caller to return an error to, and one store's
 * problem must not stop the rest of the sweep or kill the interval.
 */
export async function runWeeklySummaries(now: Date = new Date()): Promise<WeeklySummarySweep> {
  const sweep: WeeklySummarySweep = { considered: 0, written: 0, skipped: 0 };

  let candidates: Array<{ id: number; timezone: string; weeklySummaryAt: Date | null }>;
  try {
    candidates = await db
      .select({ id: stores.id, timezone: stores.timezone, weeklySummaryAt: stores.weeklySummaryAt })
      .from(stores)
      .innerJoin(users, eq(stores.ownerId, users.id))
      .where(eq(users.notifyWeeklySummary, true));
  } catch (error) {
    console.warn(`[scorelo-weekly] could not read stores: ${describeError(error)}`);
    return sweep;
  }

  sweep.considered = candidates.length;

  for (const store of candidates) {
    try {
      const timeZone = resolveTimeZone(store.timezone);
      if (!isWeeklySummaryDue(store.weeklySummaryAt, now, timeZone)) continue;

      // A store that is no longer connected is not being analysed; a weekly notice saying so
      // forever would be noise. The uninstall or expiry already has its own notice.
      if (!(await hasStoreDataSource(store.id))) {
        sweep.skipped += 1;
        continue;
      }

      if (await writeWeeklySummary(store.id, store.weeklySummaryAt, timeZone, now)) {
        sweep.written += 1;
      } else {
        sweep.skipped += 1;
      }
    } catch (error) {
      sweep.skipped += 1;
      console.warn(`[scorelo-weekly] store ${store.id} skipped: ${describeError(error)}`);
    }
  }

  return sweep;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the sweep timer. Safe to call once at boot; calling it twice is a no-op.
 *
 * The first sweep runs a minute after boot rather than one interval later. Unlike the audit
 * scheduler there is nothing to protect from a restart: the stamp means a store gets at most one
 * summary per Monday however many times the process comes up.
 */
export function startWeeklySummaryScheduler(): void {
  if (!env.weeklySummaryEnabled) {
    console.log('[scorelo-weekly] weekly summaries are disabled (WEEKLY_SUMMARY_ENABLED=false)');
    return;
  }
  if (timer) return;

  const sweep = () => {
    void runWeeklySummaries()
      .then((result) => {
        if (result.written > 0) {
          console.log(`[scorelo-weekly] sweep wrote ${result.written} summary(ies) across ${result.considered} store(s)`);
        }
      })
      .catch((error) => console.warn(`[scorelo-weekly] sweep failed: ${describeError(error)}`));
  };

  setTimeout(sweep, 60_000).unref();
  timer = setInterval(sweep, env.weeklySummaryIntervalMs);
  // Never hold the process open for a timer.
  timer.unref();

  console.log(`[scorelo-weekly] weekly summaries active — sweeping every ${Math.round(env.weeklySummaryIntervalMs / 60_000)} min`);
}
