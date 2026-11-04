// ─── Audit notifications do not repeat (npm test) ────────────────────
// Covers the decisions that stop every re-run audit from stacking identical notices in the bell:
// which critical findings count as new, what an audit does to an existing critical notice, and the
// wording built from the real counts. Pure functions — no database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  criticalFindingKey,
  criticalNoticeCopy,
  newCriticalFindings,
  planCriticalNotice,
  supersededNoticeTypes,
} from '../services/notification.service.js';

const missingDescriptions = { pillar: 'content', subPillar: 'descriptions', title: 'Products with no description' };
const brokenSitemap = { pillar: 'seo', subPillar: 'sitemap-indexability', title: 'Sitemap is unreachable' };
const noReturns = { pillar: 'cro', subPillar: 'returns', title: 'No returns policy found' };

describe('criticalFindingKey', () => {
  it('treats the same finding as the same regardless of title case and spacing', () => {
    assert.equal(
      criticalFindingKey(missingDescriptions),
      criticalFindingKey({ ...missingDescriptions, title: '  products with NO description ' }),
    );
  });

  it('keeps findings in different sub-pillars apart even with the same title', () => {
    assert.notEqual(criticalFindingKey(missingDescriptions), criticalFindingKey({ ...missingDescriptions, subPillar: 'media-richness' }));
  });
});

describe('newCriticalFindings', () => {
  it('reports nothing new when the audit found the same critical issues again', () => {
    assert.deepEqual(newCriticalFindings([missingDescriptions, brokenSitemap], [brokenSitemap, missingDescriptions]), []);
  });

  it('reports only the critical issues the previous audit did not have', () => {
    assert.deepEqual(newCriticalFindings([missingDescriptions, noReturns], [missingDescriptions]), [noReturns]);
  });

  it('treats every critical issue as new on a store with no previous audit', () => {
    assert.deepEqual(newCriticalFindings([missingDescriptions, brokenSitemap], []), [missingDescriptions, brokenSitemap]);
  });

  it('counts a finding repeated within one audit once', () => {
    assert.equal(newCriticalFindings([noReturns, { ...noReturns }], []).length, 1);
  });
});

describe('planCriticalNotice', () => {
  it('adds nothing when an unchanged store is re-analysed and the notice was already read', () => {
    assert.equal(planCriticalNotice({ currentCount: 2, newCount: 0, hasUnreadNotice: false }), 'none');
  });

  it('updates the unread notice instead of adding a second one', () => {
    assert.equal(planCriticalNotice({ currentCount: 2, newCount: 0, hasUnreadNotice: true }), 'refresh');
    assert.equal(planCriticalNotice({ currentCount: 3, newCount: 1, hasUnreadNotice: true }), 'refresh');
  });

  it('announces critical issues the merchant has not been told about', () => {
    assert.equal(planCriticalNotice({ currentCount: 3, newCount: 1, hasUnreadNotice: false }), 'create');
  });

  it('clears an unread notice once no critical issues remain', () => {
    assert.equal(planCriticalNotice({ currentCount: 0, newCount: 0, hasUnreadNotice: true }), 'resolve');
  });

  it('does nothing for a store with no critical issues and nothing to correct', () => {
    assert.equal(planCriticalNotice({ currentCount: 0, newCount: 0, hasUnreadNotice: false }), 'none');
  });
});

describe('criticalNoticeCopy', () => {
  it('announces a first finding of critical issues with the total', () => {
    assert.equal(criticalNoticeCopy(2, 2).title, '2 critical issues found');
  });

  it('names how many are new when some were already known', () => {
    const copy = criticalNoticeCopy(3, 1);
    assert.equal(copy.title, '1 new critical issue found');
    assert.match(copy.message, /1 critical issue that was not in the previous audit — 3 critical in total/);
  });

  it('says the issues are still open when nothing is new', () => {
    assert.equal(criticalNoticeCopy(1, 0).title, '1 critical issue still open');
  });
});

// ─── Repairing a bell that is already wrong ──────────────────────────
// The rules above stop duplicates being WRITTEN. This is what finds the ones already sitting in a
// merchant's bell — written by the previous behaviour, or by a deploy still serving it — so the
// product can correct itself instead of waiting for the next audit, which on a weekly store is a
// week away.

describe('supersededNoticeTypes', () => {
  const unread = (type: string) => ({ type, isRead: false });
  const read = (type: string) => ({ type, isRead: true });

  it('finds nothing in a healthy bell', () => {
    assert.deepEqual(
      supersededNoticeTypes([unread('analysis_complete'), unread('critical_issue')]),
      [],
    );
  });

  it('finds nothing in an empty bell', () => {
    assert.deepEqual(supersededNoticeTypes([]), []);
  });

  // The exact shape of the reported screenshot: two audits under the old behaviour, each having
  // inserted its own pair.
  it('reports both types when two audits each stacked a pair', () => {
    assert.deepEqual(
      supersededNoticeTypes([
        unread('critical_issue'),
        unread('analysis_complete'),
        unread('critical_issue'),
        unread('analysis_complete'),
      ]),
      ['analysis_complete', 'critical_issue'],
    );
  });

  it('ignores duplicates that have already been read', () => {
    assert.deepEqual(
      supersededNoticeTypes([unread('analysis_complete'), read('analysis_complete'), read('analysis_complete')]),
      [],
    );
  });

  /**
   * THE ONE THAT MUST NOT COLLAPSE. A connect, a reconnect, a failed sync and an uninstall are four
   * different facts that share the `integration_alert` type. Folding them would hide events the
   * merchant has never been told about — which is a worse bug than the one being fixed.
   */
  it('never collapses integration alerts, however many are unread', () => {
    assert.deepEqual(
      supersededNoticeTypes([
        unread('integration_alert'),
        unread('integration_alert'),
        unread('integration_alert'),
      ]),
      [],
    );
  });

  it('leaves score-change notices alone too', () => {
    assert.deepEqual(
      supersededNoticeTypes([unread('score_change'), unread('score_change')]),
      [],
    );
  });
});
