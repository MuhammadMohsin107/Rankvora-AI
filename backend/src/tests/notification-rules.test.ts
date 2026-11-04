// ─── Who is told what, and where clicking it goes (npm test) ─────────
// Covers the notification rules that decide whether a notice is written at all, what an audit
// failure says and opens, which pillar a comparison reports, and the links a notice may carry.
// Pure functions — no database. Scores and titles below are test inputs, not product data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_LINKS,
  analysisFailedNotice,
  largestPillarMove,
  safeNotificationLink,
  wantsNotification,
  type NotificationPreferences,
} from '../services/notification.service.js';

const allOff: NotificationPreferences = {
  notifyAnalysisComplete: false,
  notifyCriticalIssues: false,
  notifyScoreChanges: false,
  notifyWeeklySummary: false,
  notifyIntegrationAlerts: false,
  notifyProductUpdates: false,
};

describe('wantsNotification', () => {
  it('follows the one switch a type belongs to', () => {
    assert.equal(wantsNotification({ ...allOff, notifyCriticalIssues: true }, 'critical_issue'), true);
    assert.equal(wantsNotification({ ...allOff, notifyCriticalIssues: true }, 'score_change'), false);
  });

  /**
   * THE ONE THAT CHANGED. A failed audit used to be gated by "Integration problems", so a merchant
   * who wanted audit news but not connection alerts heard every success and never a failure.
   */
  it('reports a failed audit to anyone who asked for any audit news', () => {
    for (const column of ['notifyAnalysisComplete', 'notifyCriticalIssues', 'notifyScoreChanges', 'notifyWeeklySummary'] as const) {
      assert.equal(wantsNotification({ ...allOff, [column]: true }, 'analysis_failed'), true, column);
    }
  });

  it('does not report a failed audit to someone who switched every audit alert off', () => {
    assert.equal(wantsNotification({ ...allOff, notifyIntegrationAlerts: true }, 'analysis_failed'), false);
  });

  it('writes nothing for a store with no owner row', () => {
    assert.equal(wantsNotification(undefined, 'integration_alert'), false);
  });
});

describe('analysisFailedNotice', () => {
  it('sends a store-data failure to Integrations, where reconnecting happens', () => {
    const notice = analysisFailedNotice('store-data');
    assert.equal(notice.type, 'integration_alert');
    assert.equal(notice.link, '/integrations');
    assert.match(notice.message, /Shopify connection on Integrations/);
  });

  it('sends any other failure to Reports, and names the button that runs it again', () => {
    const notice = analysisFailedNotice('other');
    assert.equal(notice.type, 'analysis_failed');
    assert.equal(notice.link, '/reports');
    assert.match(notice.message, /Press Create report on Reports to run it again/);
  });

  it('uses one fixed title for both, so a repeat is recognised as the same event', () => {
    assert.equal(analysisFailedNotice('store-data').title, analysisFailedNotice('other').title);
  });
});

describe('largestPillarMove', () => {
  const row = (pillar: string, score: number, status = 'ok') => ({ pillar, score, details: { status } });

  it('reports the biggest move past the threshold, in either direction', () => {
    const move = largestPillarMove([row('seo', 70), row('cro', 40)], [row('seo', 62), row('cro', 55)], 5);
    assert.deepEqual(move, { pillar: 'cro', from: 55, to: 40, delta: -15 });
  });

  it('ignores moves at or under the threshold', () => {
    assert.equal(largestPillarMove([row('seo', 65)], [row('seo', 60)], 5), null);
  });

  /** "Not measured" becoming 62 is not an improvement of 62 points. */
  it('skips a pillar that was not measured on either side', () => {
    assert.equal(largestPillarMove([row('speed', 62)], [row('speed', 0, 'unavailable')], 0), null);
    assert.equal(largestPillarMove([row('speed', 0, 'unavailable')], [row('speed', 62)], 0), null);
    assert.equal(largestPillarMove([row('speed', 62)], [], 0), null);
  });
});

describe('NOTIFICATION_LINKS.issues', () => {
  it('opens the dashboard, where every open issue of the latest audit is listed', () => {
    assert.equal(NOTIFICATION_LINKS.issues, '/');
  });

  it('is a link the safety check keeps', () => {
    assert.equal(safeNotificationLink(NOTIFICATION_LINKS.issues), NOTIFICATION_LINKS.issues);
  });
});

describe('safeNotificationLink — hardened', () => {
  /** Browsers read "\" as "/" in a URL, so "/\host" is "//host" — off Rankvora AI. */
  it('refuses a backslash after the leading slash', () => {
    assert.equal(safeNotificationLink('/\\evil.example'), null);
  });

  it('refuses control characters and whitespace inside the path', () => {
    assert.equal(safeNotificationLink('/\t/evil.example'), null);
    assert.equal(safeNotificationLink('/fix center'), null);
    assert.equal(safeNotificationLink('/reports\n'), '/reports', 'surrounding whitespace is trimmed, not refused');
  });
});
