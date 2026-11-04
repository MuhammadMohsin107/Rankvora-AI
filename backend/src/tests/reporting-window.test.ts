// ─── The reporting window both Google APIs are asked for (npm test) ──
//
// THE PROPERTY THESE TESTS PROTECT: the window a merchant is told about is the window Google was
// actually asked for. A card that says "28-day window" beside a figure covering 29 days is wrong in
// a way nobody can catch by looking — the number is real, the label is not, and the error always
// runs in the store's favour.
//
// Both Google date APIs are INCLUSIVE at both ends, which is the whole reason this is easy to get
// wrong: `start = end - days` reads correctly and is off by one. Search Console and GA4 each had
// their own copy of that line before this module existed.
//
// The clock is fixed rather than read from the machine, so a run in December asserts the same thing
// as a run in June. Nothing here touches a database, a network or Google.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isoDate, precedingRange, rangeEndingWithLag } from '../services/reporting-window.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midday UTC, so a lag of whole days cannot tip the result into the previous date. */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

/** How many dates the range covers, counting both ends — which is what Google returns. */
function inclusiveDays(range: { startDate: string; endDate: string }): number {
  const start = Date.parse(`${range.startDate}T00:00:00Z`);
  const end = Date.parse(`${range.endDate}T00:00:00Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

describe('reporting window', () => {
  it('covers exactly as many days as it was asked for', () => {
    // The regression this module exists for. Every one of these returned `days + 1` before.
    for (const days of [1, 7, 28, 30, 90, 365]) {
      for (const lag of [2, 3]) {
        assert.equal(
          inclusiveDays(rangeEndingWithLag(days, lag, NOW)),
          days,
          `a ${days}-day window at a ${lag}-day lag must cover ${days} dates`,
        );
      }
    }
  });

  it('ends the range before today, by the lag the caller passed', () => {
    // Google finalises on a delay. A range ending today returns rows that are still filling in,
    // which reads on screen as a collapse in traffic rather than as data that has not landed.
    assert.equal(rangeEndingWithLag(28, 2, NOW).endDate, '2026-09-21', 'GA4 lags two days');
    assert.equal(rangeEndingWithLag(28, 3, NOW).endDate, '2026-09-20', 'Search Console lags three days');
    assert.notEqual(rangeEndingWithLag(28, 2, NOW).endDate, isoDate(new Date(NOW)));
  });

  it('places the start date so the pair spells out the window', () => {
    // Aug 25 through Sep 21 inclusive is 28 dates. It used to start Aug 24, and the card printed
    // "28-day window" beside it either way.
    assert.deepEqual(rangeEndingWithLag(28, 2, NOW), { startDate: '2026-08-25', endDate: '2026-09-21' });
  });

  it('collapses a one-day window onto a single date', () => {
    const range = rangeEndingWithLag(1, 2, NOW);
    assert.equal(range.startDate, range.endDate);
  });

  it('formats dates in UTC, not in whatever zone the server runs in', () => {
    // Both APIs interpret these strings as calendar dates. A server west of UTC formatting locally
    // would ask for the previous day and report it as today's data.
    assert.equal(isoDate(new Date(Date.UTC(2026, 0, 1, 23, 30))), '2026-01-01');
    assert.equal(isoDate(new Date(Date.UTC(2026, 0, 1, 0, 30))), '2026-01-01');
  });
});

describe('the window before a window', () => {
  it('is as long as the window it is compared with', () => {
    // "+12% since last period" set a 28-day total against a 27- or 29-day one would be wrong by a
    // day's traffic, in a direction nobody could see.
    for (const days of [7, 28, 90]) {
      const current = rangeEndingWithLag(days, 3, NOW);
      assert.equal(inclusiveDays(precedingRange(current)), days);
    }
  });

  it('ends the day before the current window starts, so no day is counted twice', () => {
    // Aug 25 through Sep 21 is the current 28 days; the 28 before it are Jul 28 through Aug 24.
    assert.deepEqual(precedingRange({ startDate: '2026-08-25', endDate: '2026-09-21' }), { startDate: '2026-07-28', endDate: '2026-08-24' });
  });

  it('works across a year boundary and for a one-day window', () => {
    assert.deepEqual(precedingRange({ startDate: '2026-01-01', endDate: '2026-01-07' }), { startDate: '2025-12-25', endDate: '2025-12-31' });
    assert.deepEqual(precedingRange({ startDate: '2026-03-01', endDate: '2026-03-01' }), { startDate: '2026-02-28', endDate: '2026-02-28' });
  });
});
