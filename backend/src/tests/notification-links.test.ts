// ─── Notifications point at the work (npm test) ──────────────────────
// A notification is a piece of work reported out of context, so the route it carries is the whole
// of its usefulness: every one of them used to open /notifications, the list the merchant had just
// clicked out of. Covers what the destinations are built from and what is refused as a link. Pure
// functions — no database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFICATION_LINKS, safeNotificationLink } from '../services/notification.service.js';
import { PILLAR_ORDER } from '../lib/report-labels.js';

describe('NOTIFICATION_LINKS', () => {
  it('points a score change at the pillar that moved', () => {
    assert.equal(NOTIFICATION_LINKS.pillar('seo'), '/seo');
    assert.equal(NOTIFICATION_LINKS.pillar('ai-discovery'), '/ai-discovery');
  });

  it('builds a real route for every pillar the engine scores', () => {
    for (const pillar of PILLAR_ORDER) {
      assert.equal(NOTIFICATION_LINKS.pillar(pillar), `/${pillar}`);
    }
  });

  /**
   * The engine can gain a pillar before this file hears about it. Interpolating the slug on trust
   * would build a link to a page that does not exist, so an unknown one falls back to a page that
   * does — and one that still shows the score in question.
   */
  it('falls back to reports rather than linking to a pillar page that may not exist', () => {
    assert.equal(NOTIFICATION_LINKS.pillar('quantum-seo'), '/reports');
    assert.equal(NOTIFICATION_LINKS.pillar(''), '/reports');
  });

  it('names the audit a finished analysis is about', () => {
    assert.equal(NOTIFICATION_LINKS.report(214), '/reports?audit=214');
  });

  /**
   * Severity, and deliberately not status. The count in the notice is every critical finding the
   * audit recorded, so filtering by workflow status too would open a queue holding fewer issues
   * than the notice that led there claims.
   */
  it('opens the dashboard, whose priority issues lead with the critical ones', () => {
    assert.equal(NOTIFICATION_LINKS.criticalIssues, '/');
  });

  it('only ever produces in-app paths', () => {
    const everyLink = [
      NOTIFICATION_LINKS.integrations,
      NOTIFICATION_LINKS.criticalIssues,
      NOTIFICATION_LINKS.reports,
      NOTIFICATION_LINKS.report(1),
      NOTIFICATION_LINKS.pillar('cro'),
    ];
    for (const link of everyLink) {
      assert.equal(safeNotificationLink(link), link, `${link} should survive the link check`);
    }
  });
});

describe('safeNotificationLink', () => {
  it('accepts an in-app path, query string and all', () => {
    assert.equal(safeNotificationLink('/reports?audit=12&tab=pillars'), '/reports?audit=12&tab=pillars');
  });

  it('trims surrounding whitespace rather than storing an unusable path', () => {
    assert.equal(safeNotificationLink('  /integrations  '), '/integrations');
  });

  /**
   * THE ONE THIS EXISTS FOR. The link is handed to the router, so it is the single field on a
   * notification that can move somebody somewhere. A protocol-relative URL looks like a path and is
   * not one — "//evil.example/x" leaves Rankvora AI entirely.
   */
  it('refuses anything that would navigate off Rankvora AI', () => {
    assert.equal(safeNotificationLink('//evil.example/x'), null);
    assert.equal(safeNotificationLink('https://evil.example'), null);
    assert.equal(safeNotificationLink('javascript:alert(1)'), null);
    assert.equal(safeNotificationLink('reports'), null);
  });

  it('treats a missing link as no link at all', () => {
    assert.equal(safeNotificationLink(null), null);
    assert.equal(safeNotificationLink(undefined), null);
    assert.equal(safeNotificationLink(''), null);
    assert.equal(safeNotificationLink('   '), null);
  });

  it('refuses a path too long for the column instead of storing a truncated route', () => {
    assert.equal(safeNotificationLink(`/${'x'.repeat(512)}`), null);
  });
});
