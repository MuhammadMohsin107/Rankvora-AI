/**
 * ─── The reporting window both Google APIs are asked for ─────────────
 *
 * ONE implementation, because Search Console and GA4 each carried a copy and the copies were wrong
 * in the same way. Google's date ranges are INCLUSIVE at both ends, so a window of `days` days ends
 * `days - 1` days after it starts. Both copies computed `start = end - days`, which asked for 29
 * days of data under a label that said 28 — never visible on screen, always in the store's favour,
 * and enough to make a "28-day window" disagree with anything the merchant counted themselves.
 *
 * ─── The lag belongs to the caller, because it is not one number ─────
 * Search Console finalises roughly three days back, GA4 one to two. Ending a range at "today"
 * returns rows that are still filling in, which a merchant reads as a collapse in traffic rather
 * than as data that has not landed yet. Each service passes its own lag and returns the dates it
 * actually asked for, so no surface can imply a window Google did not answer for.
 *
 * Nothing here reaches a database or a network, which is the point: it is the one piece of this
 * layer that can be unit-tested directly. See tests/reporting-window.test.ts.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in UTC, which is the format both Google APIs require. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The last `days` days of finalised data, ending `lagDays` back from now.
 *
 * `now` is injectable so the behaviour can be asserted against a fixed clock rather than against
 * whatever today happens to be.
 */
export function rangeEndingWithLag(
  days: number,
  lagDays: number,
  now: number = Date.now(),
): { startDate: string; endDate: string } {
  const end = new Date(now - lagDays * MS_PER_DAY);
  // `days - 1`, not `days`: both ends are inclusive, so a 28-day window spans 27 days of distance.
  const start = new Date(end.getTime() - (days - 1) * MS_PER_DAY);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

/**
 * The window of the SAME length that ends the day before `range` starts — what "since last period"
 * is measured against. Adjacent and never overlapping, so no day is counted in both halves of a
 * comparison, and equally long, so a 28-day total is never set against a 27-day one.
 */
export function precedingRange(range: { startDate: string; endDate: string }): { startDate: string; endDate: string } {
  const start = Date.parse(`${range.startDate}T00:00:00Z`);
  const end = Date.parse(`${range.endDate}T00:00:00Z`);
  const previousEnd = start - MS_PER_DAY;
  return { startDate: isoDate(new Date(previousEnd - (end - start))), endDate: isoDate(new Date(previousEnd)) };
}
