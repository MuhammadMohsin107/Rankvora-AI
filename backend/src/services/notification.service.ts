import { and, count, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chunkForD1 } from '../db/limits.js';
import { insertReturning, updateReturning } from '../db/returning.js';
import { auditScores, audits, findings, notifications, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { PILLAR_ORDER, pillarLabel } from '../lib/report-labels.js';
import { describeError } from '../lib/logger.js';
import { getCurrentStoreId } from './store.service.js';

/**
 * ─── Writing notifications ───────────────────────────────────────────
 *
 * Two things belong in the bell.
 *
 * FIRST, anything that happened WHILE THE MERCHANT WAS NOT LOOKING — an uninstall, an expired
 * token, a failed background sync, a finished audit. None of them is visible until somebody
 * thinks to go looking, so without a notification they are simply not reported.
 *
 * SECOND, the milestones in a store's integration history, even ones the merchant watched happen.
 * A successful Shopify connection is the example: the Integrations banner announces it once and
 * is gone on the next navigation, which leaves the bell holding only the failures — an expired
 * token and an uninstall, with nothing saying when the connection they refer to began. Recording
 * the connect is what makes that history readable as one thread rather than a list of complaints.
 *
 * THIRD, the Monday summary a merchant can switch on in Settings — written by its own sweep in
 * services/weekly-summary.service.ts, from the same audit rows everything else here reads.
 *
 * What still does NOT belong: state that is permanently on screen anyway. The connection BADGE on
 * Integrations is not duplicated here; the moment it changed is.
 */

/** The per-user switches in Settings → Notifications. */
export type NotificationPreference =
  | 'notifyAnalysisComplete'
  | 'notifyCriticalIssues'
  | 'notifyScoreChanges'
  | 'notifyWeeklySummary'
  | 'notifyIntegrationAlerts'
  | 'notifyProductUpdates';

export type NotificationPreferences = Record<NotificationPreference, boolean>;

/**
 * Which user preferences gate which notification type. A type is written when ANY of its
 * preferences is on.
 *
 * These columns already existed on `users` and were already editable in Settings — and were read
 * by nothing at all, so every toggle was decorative. They gate real writes now, which is what
 * makes them settings rather than switches.
 *
 * `analysis_failed` is the one type with more than one switch, and deliberately so. A failed audit
 * is what stops every other audit notice from arriving: no finished analysis, no critical issues,
 * no score movement, nothing new for the weekly summary. It used to be written as an
 * `integration_alert`, gated by "Integration problems" — so a merchant who wanted audit news but
 * had switched connection alerts off heard about every success and never about a failure. Anyone
 * who asked to hear about audits is now told when one could not finish.
 */
const PREFERENCES_BY_TYPE = {
  analysis_complete: ['notifyAnalysisComplete'],
  analysis_failed: ['notifyAnalysisComplete', 'notifyCriticalIssues', 'notifyScoreChanges', 'notifyWeeklySummary'],
  critical_issue: ['notifyCriticalIssues'],
  score_change: ['notifyScoreChanges'],
  weekly_summary: ['notifyWeeklySummary'],
  integration_alert: ['notifyIntegrationAlerts'],
  product_update: ['notifyProductUpdates'],
} as const satisfies Record<string, readonly NotificationPreference[]>;

export type NotificationType = keyof typeof PREFERENCES_BY_TYPE;
export type NotificationTone = 'neutral' | 'success' | 'warning' | 'critical' | 'info';

/**
 * Whether these preferences let this type through. Pure, so the gating rule is tested directly.
 *
 * No preferences at all — a store whose owner row is gone — is a no. Not an error: a store row
 * can outlive its user during a deletion cascade.
 */
export function wantsNotification(preferences: NotificationPreferences | undefined, type: NotificationType): boolean {
  if (!preferences) return false;
  return PREFERENCES_BY_TYPE[type].some((column) => preferences[column]);
}

// ─── Where a notification points ─────────────────────────────────────
//
// A notification is a piece of work reported out of context, so the one thing it owes the merchant
// is the way back to that work. Every one of them used to open /notifications — the list they had
// just clicked out of — which is the one page that cannot do anything about any of them.
//
// The target is decided HERE, where the notification is written, because that is the only moment
// the specifics exist: which pillar moved, which audit finished. Derived later from the type alone,
// "SEO dropped by 8 points" could only ever land on a list of everything.

/** `notifications.link` is a varchar(512). A longer path is refused, never stored truncated. */
const MAX_LINK_LENGTH = 512;

/** The in-app destinations notifications use. One list, so the routes stay checkable at a glance. */
export const NOTIFICATION_LINKS = {
  /** Connection state, reconnecting, and running a sync. */
  integrations: '/integrations',
  /**
   * The dashboard, whose Priority issues list leads with the critical ones. The issue-queue page this
   * used to open (/fix-center) was removed from the app.
   */
  criticalIssues: '/',
  /** One finished audit, opened on arrival rather than left to be found in the history list. */
  report: (auditId: number) => `/reports?audit=${auditId}`,
  reports: '/reports',
  /**
   * The open issue a notice names: the dashboard's Priority issues list, which shows every open issue
   * of the latest audit, most severe first. (The issue-queue page this used to search was removed.)
   */
  issues: '/',
  /**
   * A pillar dashboard. The stored slug IS the route — /seo, /ai-discovery — but it is checked
   * against the real list rather than interpolated on trust: an unknown slug would build a link to
   * a page that does not exist, and the audit engine can add a pillar before this file hears of it.
   */
  pillar: (pillar: string) => (PILLAR_ORDER.includes(pillar) ? `/${pillar}` : '/reports'),
} as const;

/**
 * Accepts an in-app path and nothing else.
 *
 * This value is handed to the browser's router, so it is the one field on a notification that can
 * move somebody somewhere. "//evil.example/x" is a protocol-relative URL that looks like a path,
 * and "https://…" is not one at all; both are dropped rather than stored. The client checks again
 * before navigating — a stored link is data, and data does not get to redirect a merchant off-site
 * because it was trusted once.
 *
 * "/\evil.example" is refused for the same reason as "//": browsers read a backslash as a slash
 * in a URL, so it is a protocol-relative URL too. Control characters and whitespace inside the
 * path are refused because a URL parser strips some of them, which is how "/\t/evil.example"
 * turns into "//evil.example" after the check has already passed it.
 *
 * Exported so the rule is tested directly rather than through a database.
 */
export function safeNotificationLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed.startsWith('/')) return null;
  if (trimmed[1] === '/' || trimmed[1] === '\\') return null;
  if (/[\u0000- \u007f]/.test(trimmed)) return null;
  return trimmed.length > MAX_LINK_LENGTH ? null : trimmed;
}

export interface CreateNotificationInput {
  storeId: number;
  type: NotificationType;
  title: string;
  message: string;
  tone?: NotificationTone;
  /** Where clicking it goes — an in-app path, ideally from NOTIFICATION_LINKS. */
  link?: string | null;
  /**
   * Suppresses a repeat of THE SAME EVENT — same type AND same title — for this store within the
   * given minutes.
   *
   * A revoked token is discovered by every audit, every sync and every page load that touches
   * Shopify — without this, one expired token would bury the bell under identical rows saying the
   * same thing. The merchant needs to be told once.
   *
   * WHY THE TITLE IS PART OF THE KEY. This used to match on type alone, and `integration_alert` is
   * shared by five different events: connected, reconnected, sync failed, authorization expired,
   * uninstalled. So a transient sync failure at 10:00 suppressed "Shopify authorization expired —
   * reconnect" at 15:00, because the expiry check looks back a day; and a store that had just
   * connected never heard that its first sync failed. Each of those is a fact the merchant had not
   * been told. Titles are fixed per event (the variable part is in the message), so type + title
   * is exactly "the same event again".
   */
  dedupeMinutes?: number;
}

/** A store owner's notification switches. Undefined when the store has no owner row. */
async function ownerPreferences(storeId: number): Promise<NotificationPreferences | undefined> {
  const [owner] = await db
    .select({
      notifyAnalysisComplete: users.notifyAnalysisComplete,
      notifyCriticalIssues: users.notifyCriticalIssues,
      notifyScoreChanges: users.notifyScoreChanges,
      notifyWeeklySummary: users.notifyWeeklySummary,
      notifyIntegrationAlerts: users.notifyIntegrationAlerts,
      notifyProductUpdates: users.notifyProductUpdates,
    })
    .from(stores)
    .innerJoin(users, eq(stores.ownerId, users.id))
    .where(eq(stores.id, storeId))
    .limit(1);
  return owner;
}

/**
 * Whether the store's owner has this notification type switched on.
 *
 * False when the store has no owner. Not an error — a store row can outlive its user during a
 * deletion cascade, and the webhook that triggered the notification still has to return 200.
 */
export async function ownerWants(storeId: number, type: NotificationType): Promise<boolean> {
  return wantsNotification(await ownerPreferences(storeId), type);
}

/**
 * Records one notification, or returns null when it was suppressed.
 *
 * NEVER THROWS. This is called from webhook handlers and from the audit worker, where the event
 * being recorded is not the caller's actual job: a notification that could not be written must not
 * fail an uninstall webhook or roll back a completed audit. Failures are logged and swallowed.
 */
export async function createNotification(input: CreateNotificationInput): Promise<typeof notifications.$inferSelect | null> {
  try {
    if (!(await ownerWants(input.storeId, input.type))) return null;

    if (input.dedupeMinutes && input.dedupeMinutes > 0) {
      const since = new Date(Date.now() - input.dedupeMinutes * 60_000);
      const [recent] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(
          eq(notifications.storeId, input.storeId),
          eq(notifications.type, input.type),
          eq(notifications.title, input.title),
          gt(notifications.createdAt, since),
        ))
        .limit(1);
      if (recent) return null;
    }

    return await insertReturning(notifications, {
      storeId: input.storeId,
      type: input.type,
      title: input.title,
      message: input.message,
      tone: input.tone ?? 'info',
      link: safeNotificationLink(input.link),
    });
  } catch (error) {
    console.warn(`[scorelo-api] notification not recorded (${input.type}): ${describeError(error)}`);
    return null;
  }
}

/**
 * The movement a pillar has to make before it is worth interrupting someone about.
 *
 * 5 points is not an arbitrary threshold: Settings promises "when any pillar score moves by more
 * than 5 points between audits", so the rule and the sentence describing it are the same number.
 */
const SCORE_CHANGE_THRESHOLD = 5;

/** A pillar-level score row, reduced to what a comparison needs. */
export interface PillarScoreRow {
  pillar: string;
  score: number;
  details: unknown;
}

export interface PillarMove {
  pillar: string;
  from: number;
  to: number;
  delta: number;
}

/**
 * The single largest pillar move between two audits that is bigger than `threshold` points, or
 * null when nothing moved that far.
 *
 * A pillar that was not measured in either audit is skipped rather than treated as a move from
 * zero: "not measured" becoming "62" is not an improvement of 62 points.
 *
 * Pure, and shared by the score-change notice and the weekly summary, so "which pillar moved" has
 * one answer wherever it is asked.
 */
export function largestPillarMove(current: PillarScoreRow[], before: PillarScoreRow[], threshold: number): PillarMove | null {
  const measured = (row: PillarScoreRow | undefined): row is PillarScoreRow =>
    Boolean(row) && (row!.details as { status?: string } | null)?.status !== 'unavailable';

  let biggest: PillarMove | null = null;
  for (const row of current) {
    const match = before.find((other) => other.pillar === row.pillar);
    if (!measured(row) || !measured(match)) continue;
    const delta = row.score - match.score;
    if (Math.abs(delta) <= threshold) continue;
    if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) {
      biggest = { pillar: row.pillar, from: match.score, to: row.score, delta };
    }
  }
  return biggest;
}

/** The pillar-level score rows of one audit. */
export async function pillarScores(auditId: number): Promise<PillarScoreRow[]> {
  return db
    .select({ pillar: auditScores.pillar, score: auditScores.score, details: auditScores.details })
    .from(auditScores)
    .where(and(eq(auditScores.auditId, auditId), isNull(auditScores.subPillar)));
}

/**
 * Compares the audit just written against the one before it and reports the largest pillar move.
 *
 * This is the write that made `notifyScoreChanges` a real preference. The column existed, Settings
 * offered the toggle and described exactly this behaviour — and nothing anywhere created a
 * `score_change` notification, so the switch had no effect in either position.
 *
 * Never throws — it runs at the end of a completed audit and must not fail one.
 */
export async function notifyScoreMovement(storeId: number, auditId: number): Promise<void> {
  try {
    // 'engine' only, as for critical issues below: a seeded development fixture is not a previous
    // analysis of this store, and "SEO dropped by 30 points" measured against one would be a
    // movement that never happened.
    const [previous] = await db
      .select({ id: audits.id })
      .from(audits)
      .where(and(eq(audits.storeId, storeId), eq(audits.source, 'engine'), lt(audits.id, auditId)))
      .orderBy(desc(audits.id))
      .limit(1);
    // A store's first audit has nothing to compare against. Silence is the correct output.
    if (!previous) return;

    const [current, before] = await Promise.all([pillarScores(auditId), pillarScores(previous.id)]);
    const biggest = largestPillarMove(current, before, SCORE_CHANGE_THRESHOLD);
    if (!biggest) return;

    const label = pillarLabel(biggest.pillar);
    const improved = biggest.delta > 0;
    await createNotification({
      storeId,
      type: 'score_change',
      title: `${label} ${improved ? 'improved' : 'dropped'} by ${Math.abs(biggest.delta)} points`,
      // Both numbers, not just the delta: "dropped 8 points" reads very differently at 91→83
      // than at 30→22, and the merchant should not have to open the app to find out which.
      message: `${label} moved from ${biggest.from} to ${biggest.to} since the previous audit. Open the pillar to see which checks changed.`,
      tone: improved ? 'success' : 'warning',
      // The pillar that actually moved — the message says "open the pillar", and this is it.
      link: NOTIFICATION_LINKS.pillar(biggest.pillar),
    });
  } catch (error) {
    console.warn(`[scorelo-api] score-change notification not evaluated: ${describeError(error)}`);
  }
}

// ─── What an audit tells the bell ────────────────────────────────────
//
// THE BUG THIS REPLACES. Every finished audit inserted "Store analysis finished", plus "N critical
// issues found" whenever any critical finding existed — unconditionally. Nothing asked whether an
// unread notice saying the same thing was already in the bell, or whether those critical issues
// were the very ones already reported. So every press of Refresh, every "Run an audit" and every
// scheduled run stacked another identical unread pair, and a merchant re-analysing a store they
// had not changed was told the same two things again each time.
//
// THE RULE NOW: one live (unread) notice per kind.
//   • Analysis finished — a newer completion updates the unread notice already there, rather than
//     adding a second one beside it. Once read, the next completion is genuinely new and is added.
//   • Critical issues — announced when an audit finds critical issues the previous audit did not
//     have. Issues that were already reported are not re-announced; an unread notice about them is
//     kept current instead. When an audit finds no critical issues at all, any unread notice
//     claiming otherwise is marked read — it is no longer true.
//
// Superseded notices are MARKED READ, never deleted: they stay in the history on /notifications.

/** A critical finding, reduced to what identifies it from one audit to the next. */
export interface CriticalFindingRef {
  pillar: string;
  subPillar: string;
  title: string;
}

/**
 * Identifies the same critical finding across audits: same pillar, same sub-pillar, same title.
 *
 * Finding titles are templates that name the problem rather than a count ("Products with no
 * description"), so the title stays stable while the number of affected items changes — which is
 * exactly the case that must not be re-announced as a new issue.
 */
export function criticalFindingKey(finding: CriticalFindingRef): string {
  return `${finding.pillar}|${finding.subPillar}|${finding.title.trim().toLowerCase()}`;
}

/** Critical findings in `current` that were not critical in `previous`, each counted once. */
export function newCriticalFindings(current: CriticalFindingRef[], previous: CriticalFindingRef[]): CriticalFindingRef[] {
  const before = new Set(previous.map(criticalFindingKey));
  const seen = new Set<string>();
  return current.filter((finding) => {
    const key = criticalFindingKey(finding);
    if (before.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type CriticalNoticeAction = 'none' | 'resolve' | 'refresh' | 'create';

/**
 * What an audit does to the critical-issue notice. Pure, so the whole rule is tested directly.
 *
 *   resolve  no critical issues now, and an unread notice still says there are
 *   refresh  critical issues now, and an unread notice exists — keep that one current
 *   create   critical issues the merchant has not been told about, and nothing unread to update
 *   none     nothing new to say, or nothing to correct
 */
export function planCriticalNotice(input: { currentCount: number; newCount: number; hasUnreadNotice: boolean }): CriticalNoticeAction {
  if (input.currentCount === 0) return input.hasUnreadNotice ? 'resolve' : 'none';
  if (input.hasUnreadNotice) return 'refresh';
  return input.newCount > 0 ? 'create' : 'none';
}

/** The wording for a critical-issue notice, from the real counts. */
export function criticalNoticeCopy(currentCount: number, newCount: number): { title: string; message: string } {
  const issues = (n: number) => `${n} critical ${n === 1 ? 'issue' : 'issues'}`;

  if (newCount === 0) {
    return {
      title: `${issues(currentCount)} still open`,
      message: 'The latest audit still finds these critical issues. Open the dashboard to review them.',
    };
  }
  if (newCount >= currentCount) {
    return {
      title: `${issues(currentCount)} found`,
      message: 'The latest audit found issues marked critical. Open the dashboard to review them.',
    };
  }
  return {
    title: `${newCount} new critical ${newCount === 1 ? 'issue' : 'issues'} found`,
    message: `The latest audit found ${issues(newCount)} that ${newCount === 1 ? 'was' : 'were'} not in the previous audit — ${currentCount} critical in total. Open the dashboard to review them.`,
  };
}

export interface AuditOutcomeSummary {
  auditId: number;
  pillarCount: number;
  findingCount: number;
  critical: CriticalFindingRef[];
}

/**
 * The types that carry ONE LIVE NOTICE PER KIND, as the rules above describe.
 *
 * Deliberately just these two. `integration_alert` is NOT here: a connect, a reconnect, a failed
 * sync and an uninstall are four different facts that happen to share a type, and folding them
 * together would hide events the merchant has never been told about.
 */
const LIVE_NOTICE_TYPES: NotificationType[] = ['analysis_complete', 'critical_issue'];

/**
 * Which live-notice types have more than one unread row in a page of notifications.
 *
 * Pure, and computed from rows already fetched, so the common case — nothing to repair — costs no
 * query at all. Exported so the rule is tested directly rather than through a database.
 */
export function supersededNoticeTypes(items: Array<{ type: string; isRead: boolean }>): NotificationType[] {
  const unread = new Map<string, number>();
  for (const item of items) {
    if (item.isRead) continue;
    unread.set(item.type, (unread.get(item.type) ?? 0) + 1);
  }
  return LIVE_NOTICE_TYPES.filter((type) => (unread.get(type) ?? 0) > 1);
}

/** Unread notices of one type for a store, newest first. */
async function unreadOfType(storeId: number, type: NotificationType) {
  return db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.storeId, storeId), eq(notifications.type, type), eq(notifications.isRead, false)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id));
}

async function markIdsRead(ids: number[]): Promise<void> {
  // In pieces: D1 takes at most 100 bound values in a statement, and a store that went a while
  // without an audit can hold more unread duplicates than that.
  for (const piece of chunkForD1(ids)) {
    await db.update(notifications).set({ isRead: true }).where(inArray(notifications.id, piece));
  }
}

/** The critical findings of the store's previous real audit. A seeded fixture is not a previous
 * analysis of this store, so only engine audits count. */
async function previousAuditCriticalFindings(storeId: number, auditId: number): Promise<CriticalFindingRef[]> {
  const [previous] = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.storeId, storeId), eq(audits.source, 'engine'), lt(audits.id, auditId)))
    .orderBy(desc(audits.id))
    .limit(1);
  if (!previous) return [];

  return db
    .select({ pillar: findings.pillar, subPillar: findings.subPillar, title: findings.title })
    .from(findings)
    .where(and(eq(findings.auditId, previous.id), eq(findings.severity, 'critical')));
}

async function recordAnalysisComplete(storeId: number, outcome: AuditOutcomeSummary): Promise<void> {
  // Duplicates are folded away WHATEVER the preference, for the same reason recordCriticalIssues
  // resolves a stale notice regardless: tidying notices the merchant already has is not sending
  // them anything new. Returning early here left a merchant who had switched this off holding
  // every duplicate the old behaviour ever wrote, with nothing able to clear them.
  if (!(await ownerWants(storeId, 'analysis_complete'))) {
    await collapseLiveNotices(storeId, ['analysis_complete']);
    return;
  }

  const title = 'Store analysis finished';
  const message = `Rankvora AI checked ${outcome.pillarCount} ${outcome.pillarCount === 1 ? 'pillar' : 'pillars'} and recorded ${outcome.findingCount} ${outcome.findingCount === 1 ? 'finding' : 'findings'}. Open the report to see the results.`;
  // The audit this notice is about, not the report list. It is also re-pointed on the update path
  // below: a refreshed notice describes the run that just finished, so it must open that one.
  const link = NOTIFICATION_LINKS.report(outcome.auditId);

  const [latest, ...older] = await unreadOfType(storeId, 'analysis_complete');
  if (!latest) {
    await insertReturning(notifications, { storeId, type: 'analysis_complete', title, message, tone: 'success', link });
    return;
  }

  // The unread notice now describes this run — moved to the top, because this run is what just
  // finished. Any older unread duplicates, left by the previous behaviour, are folded into it.
  await db
    .update(notifications)
    .set({ title, message, tone: 'success', link, createdAt: new Date() })
    .where(eq(notifications.id, latest.id));
  await markIdsRead(older.map((row) => row.id));
}

async function recordCriticalIssues(storeId: number, outcome: AuditOutcomeSummary): Promise<void> {
  const currentCount = new Set(outcome.critical.map(criticalFindingKey)).size;
  const fresh = newCriticalFindings(outcome.critical, await previousAuditCriticalFindings(storeId, outcome.auditId));
  const unread = await unreadOfType(storeId, 'critical_issue');
  const action = planCriticalNotice({ currentCount, newCount: fresh.length, hasUnreadNotice: unread.length > 0 });

  if (action === 'none') return;

  // Applied whatever the preference: a notice claiming critical issues that no longer exist is
  // wrong, and correcting it is not sending anything new.
  if (action === 'resolve') {
    await markIdsRead(unread.map((row) => row.id));
    return;
  }

  if (!(await ownerWants(storeId, 'critical_issue'))) return;

  const { title, message } = criticalNoticeCopy(currentCount, fresh.length);
  // Every copy variant ends in "Open the dashboard to review them", so that is where it goes.
  const link = NOTIFICATION_LINKS.criticalIssues;

  if (action === 'create') {
    await insertReturning(notifications, { storeId, type: 'critical_issue', title, message, tone: 'critical', link });
    return;
  }

  // refresh: the unread notice is brought up to date. It moves to the top only when there is
  // something genuinely new in it — the same open issues are not news.
  const [latest, ...older] = unread;
  await db
    .update(notifications)
    .set({ title, message, tone: 'critical', link, ...(fresh.length > 0 ? { createdAt: new Date() } : {}) })
    .where(eq(notifications.id, latest.id));
  await markIdsRead(older.map((row) => row.id));
}

/**
 * Marks unread "could not finish" notices read once an audit HAS finished.
 *
 * "Store analysis could not finish" describes the store's current state until the next audit
 * succeeds; after that it is no longer true. Marked read rather than deleted — the history on
 * /notifications still shows the failure happened — and applied whatever the preferences, because
 * correcting a stale notice is not sending anything new.
 *
 * The integration_alert half is for store-data failures, which are connection problems and keep
 * that type, and for rows the previous behaviour wrote for every failure.
 */
async function resolveFailureNotices(storeId: number): Promise<void> {
  const stale = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(
      eq(notifications.storeId, storeId),
      eq(notifications.isRead, false),
      or(
        eq(notifications.type, 'analysis_failed'),
        and(eq(notifications.type, 'integration_alert'), eq(notifications.title, ANALYSIS_FAILED_TITLE)),
      ),
    ));
  await markIdsRead(stale.map((row) => row.id));
}

/**
 * Records what a completed audit means for the bell. See the section header for the rules.
 *
 * Never throws — it runs at the end of a completed audit and must not fail one. The notices are
 * independent, so a failure in one does not stop the others.
 */
export async function notifyAuditOutcome(storeId: number, outcome: AuditOutcomeSummary): Promise<void> {
  try {
    await resolveFailureNotices(storeId);
  } catch (error) {
    console.warn(`[scorelo-api] stale failure notices not cleared: ${describeError(error)}`);
  }

  try {
    await recordAnalysisComplete(storeId, outcome);
  } catch (error) {
    console.warn(`[scorelo-api] analysis-complete notification not recorded: ${describeError(error)}`);
  }

  try {
    await recordCriticalIssues(storeId, outcome);
  } catch (error) {
    console.warn(`[scorelo-api] critical-issue notification not recorded: ${describeError(error)}`);
  }
}

// ─── What a failed audit tells the bell ──────────────────────────────

/** The title of every "audit could not finish" notice. Fixed, so a repeat is recognised as one. */
export const ANALYSIS_FAILED_TITLE = 'Store analysis could not finish';

/**
 * The notice for an audit that stopped before it completed.
 *
 * Two causes, two different notices, because they are two different things to act on:
 *
 *   store-data  Rankvora AI could not read the shop. That is a connection problem, so it stays an
 *               `integration_alert` and opens Integrations, where reconnecting happens.
 *   other       The engine stopped for its own reasons. The previous results still stand, so it
 *               opens Reports. It is an `analysis_failed`, which anyone who asked for audit news
 *               receives — see PREFERENCES_BY_TYPE.
 *
 * Pure, so which type, wording and destination a failure gets is tested directly.
 */
export function analysisFailedNotice(cause: 'store-data' | 'other'): Pick<CreateNotificationInput, 'type' | 'title' | 'message' | 'tone' | 'link'> {
  if (cause === 'store-data') {
    return {
      type: 'integration_alert',
      title: ANALYSIS_FAILED_TITLE,
      message: 'Rankvora AI could not read your store data. Check the Shopify connection on Integrations.',
      tone: 'warning',
      link: NOTIFICATION_LINKS.integrations,
    };
  }
  return {
    type: 'analysis_failed',
    title: ANALYSIS_FAILED_TITLE,
    // Names the button on the page the link opens: Reports' "Create report" runs a new audit.
    message: 'The analysis stopped before it completed. Your previous results are unchanged. Press Create report on Reports to run it again.',
    tone: 'warning',
    link: NOTIFICATION_LINKS.reports,
  };
}

/**
 * Records that an audit could not finish. A failed audit is silent otherwise: the job row records
 * it, and nothing surfaces that until somebody wonders why their scores never updated.
 *
 * Deduped over an hour — a store whose audit fails keeps failing on every retry, and the merchant
 * needs to be told once. Never throws, like createNotification.
 */
export async function notifyAnalysisFailed(storeId: number, cause: 'store-data' | 'other'): Promise<void> {
  await createNotification({ storeId, ...analysisFailedNotice(cause), dedupeMinutes: 60 });
}

export interface NotificationList {
  items: Array<typeof notifications.$inferSelect>;
  /** Unread across the WHOLE store, not just the page returned — this drives the bell badge. */
  unreadCount: number;
  total: number;
}

/**
 * The recent notifications plus the store's real unread and total counts.
 *
 * The counts are separate queries on purpose. This used to return every row the store had ever
 * received and let the browser count the unread ones, which meant the list grew without limit and
 * — the moment a limit was added — the badge would have counted only what fitted on the page.
 */
/**
 * Folds stale unread duplicates of a live-notice type into the newest one, marking the rest read.
 *
 * WHY THIS EXISTS ON THE READ PATH. "One live notice per kind" was only ever enforced where
 * notifications are WRITTEN, which repairs a store the next time an audit finishes — and a weekly
 * store is a week away from that. Rows left by the previous behaviour, or by a deploy still
 * serving it, therefore sat unread in the bell indefinitely with no way for the product to correct
 * itself. Enforcing the rule where the bell is read closes that gap.
 *
 * Marked read, never deleted, exactly as the write path does it: the history stays on the
 * notifications page.
 */
async function collapseLiveNotices(storeId: number, types: NotificationType[]): Promise<void> {
  for (const type of types) {
    const [, ...superseded] = await unreadOfType(storeId, type);
    await markIdsRead(superseded.map((row) => row.id));
  }
}

export async function listNotifications(
  userId: number,
  query: { limit: number },
  storeId?: number,
): Promise<NotificationList> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const forStore = eq(notifications.storeId, resolvedStoreId);

  const readPage = async (): Promise<NotificationList> => {
    const [items, [unread], [all]] = await Promise.all([
      // id breaks ties: created_at has one-second resolution, and an audit writes its notices in
      // the same second — without it their order could swap between two polls.
      db.select().from(notifications).where(forStore).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(query.limit),
      db.select({ value: count() }).from(notifications).where(and(forStore, eq(notifications.isRead, false))),
      db.select({ value: count() }).from(notifications).where(forStore),
    ]);
    return { items, unreadCount: unread?.value ?? 0, total: all?.value ?? 0 };
  };

  const page = await readPage();

  // Detected from the rows just fetched, so a healthy store adds no query here. When duplicates
  // ARE found the repair runs over every unread row of that type, not only the ones on this page,
  // and the page is re-read so the badge and the list agree with what was just written.
  const superseded = supersededNoticeTypes(page.items);
  if (superseded.length === 0) return page;

  try {
    await collapseLiveNotices(resolvedStoreId, superseded);
  } catch (error) {
    // A repair that fails must not take the bell down with it — showing a duplicate is far better
    // than showing nothing.
    console.warn(`[scorelo-api] notification repair skipped: ${describeError(error)}`);
    return page;
  }

  return readPage();
}

export async function markNotificationRead(userId: number, id: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  const [notification] = await updateReturning(
    notifications,
    { isRead: true },
    and(eq(notifications.id, id), eq(notifications.storeId, resolvedStoreId)),
  );

  if (!notification) {
    throw new ApiError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  }

  return notification;
}

/**
 * Removes one notification for good.
 *
 * Deliberately separate from "read". Reading something is a statement about attention; deleting
 * it is a statement about the record. Collapsing the two would mean a merchant who glanced at
 * "Store analysis could not finish" could never look at it again.
 */
export async function deleteNotification(userId: number, id: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  const [notification] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.storeId, resolvedStoreId)))
    .limit(1);
  // Checked before deleting so a caller aiming at another store's row gets 404 rather than a
  // silent success that deleted nothing.
  if (!notification) throw new ApiError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');

  await db.delete(notifications).where(and(eq(notifications.id, id), eq(notifications.storeId, resolvedStoreId)));
  return { id };
}

/** Clears everything already read. Unread rows are never touched — the merchant has not seen them. */
export async function clearReadNotifications(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const where = and(eq(notifications.storeId, resolvedStoreId), eq(notifications.isRead, true));

  const rows = await db.select({ id: notifications.id }).from(notifications).where(where);
  if (rows.length > 0) await db.delete(notifications).where(where);
  return { deleted: rows.length };
}

export async function markAllNotificationsRead(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  // updateReturning captures the matching ids before writing — essential here, where the
  // update flips the very column the predicate tests.
  return updateReturning(
    notifications,
    { isRead: true },
    and(eq(notifications.storeId, resolvedStoreId), eq(notifications.isRead, false)),
  );
}
