/**
 * ─── When a scheduled analysis may run ───────────────────────────────
 *
 * Pure date arithmetic, with no database and no imports of its own, because two very different
 * callers need exactly the same answer: the sweep that starts runs
 * (services/auto-analysis.service.ts) and the setup/dashboard panels that tell the merchant when
 * the next one is. Two copies of this rule would be two schedules, and the one on screen would be
 * the one that was wrong.
 *
 * TWO INPUTS, BOTH THE MERCHANT'S OWN: how often (`stores.analysis_frequency`) and, optionally,
 * which hour of their own day (the preferred scan hour from guided setup). Nothing here invents a
 * schedule for a store that has not chosen one.
 */

/**
 * Settings offers exactly these four, and `updateStoreSchema` enum-validates writes to them. A
 * frequency the API accepts but this map does not know would silently never run, which is why a
 * test fails the build if the two lists drift.
 */
export const FREQUENCY_DAYS: Record<string, number> = {
  Daily: 1,
  Weekly: 7,
  Fortnightly: 14,
  Monthly: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * How long past its due time a run may wait for the preferred hour before going ahead anyway.
 *
 * Without this, a preferred hour would be a single chance per cycle: an API restart, a deploy or a
 * sweep that happened to miss the window would postpone a WEEKLY store by a whole week. A day's
 * grace means a missed window costs at most a day, and a merchant who asked for "around 03:00"
 * still gets 03:00 in every normal week.
 */
const MISSED_WINDOW_GRACE_MS = DAY_MS;

/** How far ahead to look for the next preferred hour. Two days is far more than any zone needs. */
const HOUR_SEARCH_LIMIT = 48;

export interface ScanWindow {
  /** The store's IANA timezone, or null when Shopify never reported one (then hours are UTC). */
  timeZone: string | null;
  /** Local hour 0–23 a run may start in, or null for "any hour", which is the default. */
  preferredHour: number | null;
}

/** No preference: the behaviour every store had before a scan hour could be chosen. */
export const ANY_HOUR: ScanWindow = { timeZone: null, preferredHour: null };

/**
 * The hour of the day at `date`, in `timeZone`.
 *
 * Falls back to UTC for a zone Intl will not accept, rather than throwing inside a sweep. `h23`
 * is explicit because some engines render midnight as "24" under `hour12: false`.
 */
export function localHour(date: Date, timeZone: string | null): number {
  if (!timeZone) return date.getUTCHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    return Number.isInteger(hour) ? hour : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/** When the interval alone says a store becomes due, ignoring the preferred hour. */
function dueFrom(lastRunAt: Date | null, intervalDays: number, now: Date): Date {
  // A connected store that has never been analysed is due now: that first analysis is the point of
  // connecting, and there is no previous run to count from.
  return lastRunAt ? new Date(lastRunAt.getTime() + intervalDays * DAY_MS) : now;
}

/**
 * Whether a store is due for another analysis.
 *
 * `lastRunAt` is the newest REAL audit of the store, whoever started it — so analysing by hand
 * postpones the scheduled run rather than running alongside it.
 *
 * The preferred hour narrows WHEN a due store starts; it never makes a store due that the interval
 * says is not. A store that has never been analysed ignores the hour, because waiting up to a day
 * for the first read of a store nobody has ever analysed serves no one.
 */
export function isAnalysisDue(
  lastRunAt: Date | null,
  frequency: string,
  now: Date,
  window: ScanWindow = ANY_HOUR,
): boolean {
  const intervalDays = FREQUENCY_DAYS[frequency];
  // An unrecognised frequency is not a reason to invent an interval and analyse on a guess.
  if (!intervalDays) return false;
  if (!lastRunAt) return true;

  const due = dueFrom(lastRunAt, intervalDays, now);
  if (now.getTime() < due.getTime()) return false;

  if (window.preferredHour === null) return true;
  if (localHour(now, window.timeZone) === window.preferredHour) return true;
  // The window was missed (or the process was down through it) — go ahead rather than lose a cycle.
  return now.getTime() - due.getTime() >= MISSED_WINDOW_GRACE_MS;
}

/**
 * When the next scheduled analysis would start, or null for a frequency nothing recognises.
 *
 * Never earlier than `now`: a store already past its interval is "next scan: as soon as the next
 * sweep runs", not a date in the past. With a preferred hour, this is the first instant from then
 * on that falls inside that hour in the store's own timezone — each candidate is judged in the
 * zone itself, so a daylight-saving change needs no special case.
 */
export function nextScheduledScanAt(
  lastRunAt: Date | null,
  frequency: string,
  window: ScanWindow = ANY_HOUR,
  now: Date = new Date(),
): Date | null {
  const intervalDays = FREQUENCY_DAYS[frequency];
  if (!intervalDays) return null;

  const due = dueFrom(lastRunAt, intervalDays, now);
  const earliest = due.getTime() < now.getTime() ? now : due;
  if (window.preferredHour === null) return earliest;
  if (localHour(earliest, window.timeZone) === window.preferredHour) return earliest;

  // From the next whole hour, because an instant mid-hour has already missed part of it.
  const start = Math.ceil(earliest.getTime() / HOUR_MS) * HOUR_MS;
  for (let step = 0; step < HOUR_SEARCH_LIMIT; step += 1) {
    const candidate = new Date(start + step * HOUR_MS);
    if (localHour(candidate, window.timeZone) === window.preferredHour) return candidate;
  }
  // Unreachable for any real timezone; reporting the interval's own answer beats reporting none.
  return earliest;
}
