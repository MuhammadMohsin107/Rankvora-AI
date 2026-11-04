// ─── The Monday summary (npm test) ───────────────────────────────────
// Covers when a store's weekly summary is due, in its own timezone, and the exact sentences it is
// written in for each kind of week. Pure functions — no database. The scores, counts and titles
// below are test inputs describing hypothetical weeks, not product data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isWeeklySummaryDue, resolveTimeZone, weeklySummaryCopy, type WeeklySummaryInput } from '../services/weekly-summary.service.js';

describe('resolveTimeZone', () => {
  it('keeps a real IANA zone', () => {
    assert.equal(resolveTimeZone('Asia/Karachi'), 'Asia/Karachi');
  });

  it('falls back to UTC for anything that is not a zone', () => {
    assert.equal(resolveTimeZone('Unspecified'), 'UTC');
    assert.equal(resolveTimeZone('(UTC+05:00) Karachi'), 'UTC');
    assert.equal(resolveTimeZone(''), 'UTC');
    assert.equal(resolveTimeZone(null), 'UTC');
  });
});

describe('isWeeklySummaryDue', () => {
  // 2026-09-28 is a Monday.
  const mondayNoonUtc = new Date('2026-09-28T12:00:00Z');

  it('is due on Monday when none has been written', () => {
    assert.equal(isWeeklySummaryDue(null, mondayNoonUtc, 'UTC'), true);
  });

  it('is not due on any other day', () => {
    assert.equal(isWeeklySummaryDue(null, new Date('2026-09-29T12:00:00Z'), 'UTC'), false);
    assert.equal(isWeeklySummaryDue(null, new Date('2026-09-27T12:00:00Z'), 'UTC'), false);
  });

  it('is written once per Monday', () => {
    assert.equal(isWeeklySummaryDue(new Date('2026-09-28T00:30:00Z'), mondayNoonUtc, 'UTC'), false);
    assert.equal(isWeeklySummaryDue(new Date('2026-09-21T09:00:00Z'), mondayNoonUtc, 'UTC'), true, 'last week’s does not count');
  });

  /** Monday is the store's Monday: 20:00 UTC on Sunday is already 01:00 Monday in Karachi. */
  it('uses the store’s own timezone', () => {
    const sundayEveningUtc = new Date('2026-09-27T20:00:00Z');
    assert.equal(isWeeklySummaryDue(null, sundayEveningUtc, 'Asia/Karachi'), true);
    assert.equal(isWeeklySummaryDue(null, sundayEveningUtc, 'UTC'), false);
  });
});

describe('weeklySummaryCopy', () => {
  const base: WeeklySummaryInput = {
    auditsThisWeek: 2,
    latest: { overallScore: 72, runAt: new Date('2026-09-27T09:00:00Z') },
    baseline: { overallScore: 68 },
    pillarMove: { pillar: 'seo', from: 60, to: 71, delta: 11 },
    open: { total: 12, critical: 2, high: 3 },
    topFinding: { title: 'Products with no description', severity: 'critical' },
    timeZone: 'UTC',
  };

  it('writes nothing for a store that has never been analysed', () => {
    assert.equal(weeklySummaryCopy({ ...base, latest: null }), null);
  });

  it('states the week’s movement, the pillar that moved most, and where to start', () => {
    assert.deepEqual(weeklySummaryCopy(base), {
      title: 'Weekly summary: score up 4 to 72',
      message: '2 audits ran this week. Your overall score moved from 68 to 72. SEO moved the most, from 60 to 71. 12 issues are open — 2 critical and 3 high. Start with "Products with no description".',
      link: '/',
    });
  });

  it('says so when the score went down or held', () => {
    assert.equal(weeklySummaryCopy({ ...base, baseline: { overallScore: 80 } })?.title, 'Weekly summary: score down 8 to 72');
    const steady = weeklySummaryCopy({ ...base, baseline: { overallScore: 72 }, pillarMove: null });
    assert.equal(steady?.title, 'Weekly summary: score steady at 72');
    assert.match(steady?.message ?? '', /Your overall score held at 72\./);
  });

  it('describes a store’s first week without inventing a "before"', () => {
    const first = weeklySummaryCopy({ ...base, baseline: null, pillarMove: null, auditsThisWeek: 1 });
    assert.equal(first?.title, 'Weekly summary: overall score 72');
    assert.match(first?.message ?? '', /^Rankvora AI analysed your store for the first time this week\. It scored 72 overall\./);
  });

  it('says plainly when no audit ran, with the date of the last one', () => {
    const quiet = weeklySummaryCopy({ ...base, auditsThisWeek: 0, baseline: null, pillarMove: null });
    assert.equal(quiet?.title, 'Weekly summary: no audit ran this week');
    assert.match(quiet?.message ?? '', /^Your latest overall score is 72, from the audit on Sep 27, 2026\./);
  });

  it('opens Reports when nothing is open, and says nothing is', () => {
    const clean = weeklySummaryCopy({ ...base, open: { total: 0, critical: 0, high: 0 }, topFinding: null });
    assert.equal(clean?.link, '/reports');
    assert.match(clean?.message ?? '', /No issues are open from the latest audit\.$/);
  });

  it('leaves out the severity breakdown when nothing open is critical or high', () => {
    const mild = weeklySummaryCopy({ ...base, open: { total: 1, critical: 0, high: 0 }, topFinding: { title: 'Thin alt text', severity: 'low' } });
    assert.match(mild?.message ?? '', /1 issue is open\. Start with "Thin alt text"\.$/);
  });
});
