import { useEffect, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, FileText, TrendingUp, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { hiddenPillarKeys } from '../config/modules';
import { pillarMeta } from './pillarMeta';

/**
 * ─── Notification store ──────────────────────────────────────────────
 *
 * ONE state, shared by the header bell and the /notifications page.
 *
 * They used to hold separate copies: each fetched on mount and each mutated only its own array.
 * So marking everything read on the page left the bell still showing "5", and a notification
 * opened from the bell stayed bold on the page — two views of the same data disagreeing until a
 * full reload. Anything that changes notifications now goes through here, and every subscriber is
 * told at once.
 *
 * Three other things this fixes:
 *
 *   · A FAILED WRITE IS ROLLED BACK. Both views applied the change optimistically and then
 *     console.error'd the failure, so a rejected PATCH left the row looking read while the
 *     database still had it unread — the badge "fixed itself" back to the old number on the next
 *     reload with no explanation. The optimistic update now reverts and the error is surfaced.
 *   · THE BADGE COUNTS THE STORE, NOT THE PAGE. `unreadCount` comes from the server, so capping
 *     the list at 30 rows cannot make the bell under-report.
 *   · IT REFRESHES. Notifications are written by background work — an audit finishing, a sync
 *     failing — so a tab left open used to show a stale bell indefinitely.
 */

export interface NotificationRecord {
  id: number;
  type: string;
  title: string;
  message: string;
  tone: 'neutral' | 'success' | 'warning' | 'critical' | 'info';
  /** The in-app page this notification is about. Null on rows written before links existed. */
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

interface NotificationListResponse {
  items: NotificationRecord[];
  unreadCount: number;
  total: number;
}

export interface NotificationState {
  items: NotificationRecord[];
  /** Unread across the whole store — not a count of `items`. */
  unreadCount: number;
  total: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Set when a load or a write failed. Shown to the customer rather than only logged. */
  error: string | null;
  /** How many of the newest rows are loaded. Grows when "Show older" is pressed. */
  limit: number;
}

/** How many rows are loaded at first, and how many more "Show older" adds. */
const PAGE_SIZE = 30;
/** The server's ceiling (backend notification.schema.ts, NOTIFICATION_LIST_MAX). */
export const NOTIFICATION_LIST_MAX = 200;

const EMPTY: NotificationState = { items: [], unreadCount: 0, total: 0, status: 'idle', error: null, limit: PAGE_SIZE };
/** Background work lands between page loads; a minute is frequent enough to feel live and rare
 * enough that an idle tab is not a load source. */
const POLL_MS = 60_000;

let state: NotificationState = EMPTY;
const listeners = new Set<(next: NotificationState) => void>();
let timer: number | null = null;

function set(patch: Partial<NotificationState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

export function getNotificationState(): NotificationState {
  return state;
}

/**
 * Normalises whatever the API returned into the shape this store guarantees.
 *
 * THIS IS NOT DEFENSIVENESS FOR ITS OWN SAKE. GET /notifications used to return a bare array and
 * now returns `{ items, unreadCount, total }`. During a deploy where the backend ships before the
 * browser bundle — or the other way round — one side sees the other's shape, and the old code did
 * `notifications.filter(...)` straight onto it. `.filter is not a function` unmounted the entire
 * React tree and left a blank page on first sign-in.
 *
 * Reading both shapes means a version skew degrades to a slightly wrong count for a few seconds
 * instead of taking the application down.
 */
function normalizeList(payload: unknown): NotificationListResponse {
  if (Array.isArray(payload)) {
    return withoutHiddenPillars({ items: payload as NotificationRecord[], unreadCount: null, total: null });
  }

  const data = (payload ?? {}) as Partial<NotificationListResponse>;
  return withoutHiddenPillars({
    items: Array.isArray(data.items) ? data.items : [],
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : null,
    total: typeof data.total === 'number' ? data.total : null,
  });
}

/** Whether a notification is about a pillar the customer cannot see (config/modules.ts). */
function isAboutHiddenPillar(record: NotificationRecord): boolean {
  const hidden = hiddenPillarKeys();
  if (hidden.length === 0) return false;
  // Its page: the first segment of the in-app link is the pillar ("/cro", "/cro/cod").
  const page = (record.link ?? '').split(/[?#]/)[0].split('/').filter(Boolean)[0];
  if (hidden.some((key) => key === page)) return true;
  // Or it names the pillar in what it says ("CRO score moved…").
  const text = `${record.title} ${record.message}`;
  return hidden.some((key) => new RegExp(`\\b${pillarMeta[key].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

/**
 * The list as the customer may see it: notifications about a hidden pillar are left out, and the
 * counts the server sent are brought down by the ones left out of the rows loaded here, so the
 * bell never counts something that is not in the list. A null count is derived from the rows.
 */
function withoutHiddenPillars(list: { items: NotificationRecord[]; unreadCount: number | null; total: number | null }): NotificationListResponse {
  const items = list.items.filter((item) => !isAboutHiddenPillar(item));
  const leftOut = list.items.filter(isAboutHiddenPillar);
  const unreadLeftOut = leftOut.filter((item) => !item.isRead).length;
  return {
    items,
    unreadCount: list.unreadCount === null ? items.filter((item) => !item.isRead).length : Math.max(0, list.unreadCount - unreadLeftOut),
    total: list.total === null ? items.length : Math.max(0, list.total - leftOut.length),
  };
}

export async function loadNotifications(): Promise<void> {
  if (state.status === 'idle') set({ status: 'loading' });
  try {
    // The whole window the merchant has opened, every time — so a poll after "Show older" keeps the
    // older rows current instead of cutting the list back to the first page.
    const data = normalizeList(await api.get<unknown>(`/notifications?limit=${state.limit}`));
    set({ items: data.items, unreadCount: data.unreadCount, total: data.total, status: 'ready', error: null });
  } catch (error) {
    console.error('Failed to load notifications', error);
    // A failed refresh keeps whatever is already on screen: replacing real notifications with an
    // empty list because one poll failed would be worse than showing slightly stale ones.
    set({ status: state.items.length > 0 ? 'ready' : 'error', error: 'Notifications could not be loaded.' });
  }
}

export async function markNotificationRead(id: number): Promise<void> {
  const target = state.items.find((item) => item.id === id);
  if (!target || target.isRead) return;

  const previous = state;
  set({
    items: state.items.map((item) => (item.id === id ? { ...item, isRead: true } : item)),
    unreadCount: Math.max(0, state.unreadCount - 1),
    error: null,
  });

  try {
    await api.patch<NotificationRecord>(`/notifications/${id}/read`);
  } catch (error) {
    console.error('Failed to mark notification read', error);
    set({ ...previous, error: 'That notification could not be marked as read.' });
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  if (state.unreadCount === 0) return;

  const previous = state;
  set({ items: state.items.map((item) => ({ ...item, isRead: true })), unreadCount: 0, error: null });

  try {
    await api.patch<NotificationRecord[]>('/notifications/read-all');
    // Re-read rather than trusting the local guess: rows beyond this page were also marked, and
    // the server's count is the one the badge should show.
    await loadNotifications();
  } catch (error) {
    console.error('Failed to mark all notifications read', error);
    set({ ...previous, error: 'Those notifications could not be marked as read.' });
  }
}

/**
 * Removes one notification permanently.
 *
 * Separate from marking it read: reading is about attention, deleting is about the record. The
 * bell already stops showing a notification once it is read, so this exists for the archive on
 * /notifications, where a merchant clearing old rows means it.
 */
export async function dismissNotification(id: number): Promise<void> {
  const target = state.items.find((item) => item.id === id);
  if (!target) return;

  const previous = state;
  set({
    items: state.items.filter((item) => item.id !== id),
    unreadCount: target.isRead ? state.unreadCount : Math.max(0, state.unreadCount - 1),
    total: Math.max(0, state.total - 1),
    error: null,
  });

  try {
    await api.delete(`/notifications/${id}`);
  } catch (error) {
    console.error('Failed to dismiss notification', error);
    set({ ...previous, error: 'That notification could not be removed.' });
  }
}

/**
 * Read notifications across the whole store — what "Clear read" deletes.
 *
 * Not a count of the loaded rows: the server deletes EVERY read row, and the button used to show
 * only the ones on this page ("Clear read (25)" while it removed 95).
 */
export function readNotificationCount(current: Pick<NotificationState, 'total' | 'unreadCount'>): number {
  return Math.max(0, current.total - current.unreadCount);
}

/**
 * Loads the next page of older notifications. Returns without a request when everything is
 * already loaded or the server's ceiling is reached.
 */
export async function showOlderNotifications(): Promise<void> {
  if (state.items.length >= state.total || state.limit >= NOTIFICATION_LIST_MAX) return;
  set({ limit: Math.min(NOTIFICATION_LIST_MAX, state.limit + PAGE_SIZE) });
  await loadNotifications();
}

/** Deletes every notification already read. Unread ones are left alone — they have not been seen. */
export async function clearReadNotifications(): Promise<void> {
  if (readNotificationCount(state) === 0) return;

  const previous = state;
  set({ items: state.items.filter((item) => !item.isRead), error: null });

  try {
    await api.delete('/notifications/read');
    // Re-read: rows beyond this page were deleted too, so the totals here are a guess until the
    // server says otherwise.
    await loadNotifications();
  } catch (error) {
    console.error('Failed to clear read notifications', error);
    set({ ...previous, error: 'Those notifications could not be removed.' });
  }
}

function startPolling() {
  if (timer !== null) return;
  timer = window.setInterval(() => {
    // A hidden tab is not being read; polling it spends the customer's battery and our capacity
    // to keep a badge current that nobody is looking at.
    if (document.visibilityState === 'visible') void loadNotifications();
  }, POLL_MS);
}

function stopPolling() {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/** Refreshes the moment a tab is looked at again, so returning to it never shows a stale bell. */
function onVisible() {
  if (document.visibilityState === 'visible' && listeners.size > 0) void loadNotifications();
}

export function subscribeNotifications(listener: (next: NotificationState) => void): () => void {
  listeners.add(listener);
  listener(state);

  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisible);
    startPolling();
    void loadNotifications();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener('visibilitychange', onVisible);
      stopPolling();
    }
  };
}

/** The one way a component reads notifications. Subscribing is what starts the polling. */
export function useNotifications(): NotificationState {
  const [current, setCurrent] = useState<NotificationState>(state);
  useEffect(() => subscribeNotifications(setCurrent), []);
  return current;
}

// ─── Where a notification goes ───────────────────────────────────────

/**
 * The best page for a type, used when the row itself names none.
 *
 * Rows written before notifications carried a link have no specifics left to recover — which
 * pillar moved, which audit finished — so they land on the page that type is always about. A
 * merchant is not told to go and find it themselves, and nothing here invents a precision the row
 * does not have: score_change goes to Reports, where every pillar's movement is listed, rather
 * than guessing at a pillar.
 */
const FALLBACK_TARGET: Record<string, string> = {
  analysis_complete: '/reports',
  // Reports is where "Create report" runs the audit again.
  analysis_failed: '/reports',
  // The dashboard's Priority issues list, where the critical ones are at the top.
  critical_issue: '/',
  score_change: '/reports',
  integration_alert: '/integrations',
  weekly_summary: '/reports',
};

/**
 * Where clicking this notification should go.
 *
 * THE SECOND HALF OF A SAFETY CHECK. The server stores only in-app paths, and this refuses
 * anything else again before the value reaches the router: a stored string that starts "//" or
 * "https:" is a redirect off Rankvora AI wearing a path's clothes, and a link is data — it does not
 * get to move a merchant off-site because it was trusted once on the way in.
 *
 * Falls back to /notifications for a type with nowhere better to be, which is where every one of
 * these used to go.
 */
export function notificationTarget(notification: Pick<NotificationRecord, 'type' | 'link'>): string {
  const stored = notification.link;
  // The same rule the server applies on write (safeNotificationLink): "/\host" is read by browsers
  // as "//host", and a control character inside the path can be stripped into one.
  if (
    typeof stored === 'string'
    && stored.startsWith('/')
    && stored[1] !== '/'
    && stored[1] !== '\\'
    && !/[\u0000- \u007f]/.test(stored)
  ) {
    // Notices written while the issue queue page existed still point at it; it was removed, and
    // the dashboard's Priority issues list is where those issues are now.
    if (stored === '/fix-center' || stored.startsWith('/fix-center?') || stored.startsWith('/fix-center/')) return '/';
    return stored;
  }
  return FALLBACK_TARGET[notification.type] ?? '/notifications';
}

// ─── Presentation helpers ────────────────────────────────────────────

const iconByType: Record<string, LucideIcon> = {
  analysis_complete: CheckCircle2,
  analysis_failed: AlertCircle,
  critical_issue: AlertCircle,
  score_change: TrendingUp,
  integration_alert: AlertCircle,
  weekly_summary: FileText,
  product_update: Bell,
};

/**
 * The mark shown beside a notification.
 *
 * `type` alone is not always enough. `integration_alert` is written BOTH for a store that just
 * connected and for one whose authorization expired, so its AlertCircle put a warning mark on
 * good news. `tone` is the field that tells those apart, and it was stored, returned by the API
 * and then read by nothing — this is the first thing to use it.
 *
 * Deliberately narrow: only the ambiguous type consults tone. `score_change` keeps its trend
 * arrow whichever direction the score moved, because an arrow says more there than a tick would.
 */
export function iconForNotification(type: string, tone?: NotificationRecord['tone']): LucideIcon {
  if (type === 'integration_alert' && tone === 'success') return CheckCircle2;
  return iconByType[type] ?? Bell;
}

/**
 * Relative for the first week, then an actual date.
 *
 * "412 days ago" is arithmetic, not information — past about a week nobody counts days, and the
 * date is both shorter and more useful.
 */
export function formatNotificationTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';

  const diffMins = Math.floor((Date.now() - date.getTime()) / 60_000);
  // A clock that is a little behind the server must not produce "in 3 minutes".
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
