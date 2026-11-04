import { useState } from 'react';
import { BellOff, ChevronRight, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AppPage from '../components/polaris/AppPage';
import Banner from '../components/polaris/Banner';
import {
  NOTIFICATION_LIST_MAX,
  clearReadNotifications,
  dismissNotification,
  formatNotificationTime,
  iconForNotification,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationTarget,
  readNotificationCount,
  showOlderNotifications,
  useNotifications,
  type NotificationRecord,
} from '../data/notifications';
import Button from '../components/polaris/Button';

export default function Notifications() {
  const navigate = useNavigate();
  // The same store the header bell reads. Marking something read here updates the badge in the
  // same tick — the two used to hold separate arrays and drift apart until a full reload.
  const notificationState = useNotifications();
  const { items, unreadCount, total, status, error, limit } = notificationState;
  // Every read notification the store has, which is what "Clear read" deletes — not only the
  // ones loaded on this page.
  const readCount = readNotificationCount(notificationState);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRemaining = total - items.length;
  const canShowOlder = olderRemaining > 0 && limit < NOTIFICATION_LIST_MAX;

  const showOlder = () => {
    setLoadingOlder(true);
    void showOlderNotifications().finally(() => setLoadingOlder(false));
  };

  /**
   * Opens the page the notification is about, exactly as the bell does.
   *
   * This row used to only mark itself read, and was DISABLED once it had been — so the archive
   * was a list of things that had happened with no way to reach any of them. Opening one still
   * marks it read, because that is what reading it is; an already-read row stays clickable,
   * because its subject has not gone anywhere.
   */
  const openNotification = (notification: NotificationRecord) => {
    if (!notification.isRead) void markNotificationRead(notification.id);
    navigate(notificationTarget(notification));
  };

  return (
    // The title, the way back to the dashboard and the two list actions are in the page frame (AppPage),
    // drawn by the Shopify admin's title bar. A list this narrow reads best at Polaris's reading width.
    <AppPage
      heading="Notifications"
      inlineSize="base"
      back={{ label: 'Dashboard', to: '/' }}
      secondaryActions={[
        { label: 'Mark all as read', onClick: () => void markAllNotificationsRead(), disabled: unreadCount === 0 },
        // Read notifications leave the bell on their own; this page keeps them so a merchant can look
        // back at what happened. "Clear read" is how they go for good — an explicit act, never a side
        // effect of glancing at one.
        { label: `Clear read (${readCount})`, onClick: () => void clearReadNotifications(), disabled: readCount === 0 },
      ]}
    >
      <div>
        <p className="page-subtitle">
          {unreadCount} unread{total > items.length && ` · showing the latest ${items.length} of ${total}`}
        </p>

        {/* A rolled-back write says so. Previously both handlers applied the change optimistically
            and console.error'd the failure, so a rejected request left a row looking read while
            the database still had it unread. */}
        {error && (
          <div className="mt-2">
            <Banner tone="critical"><s-text>{error}</s-text></Banner>
          </div>
        )}

        <section className="mt-2 overflow-hidden rounded-lg border border-surface-200 bg-surface-0" aria-label="All notifications">
          {/* 'idle' too: the first paint happens before the first request starts, and it used to
              show "No notifications yet" for that frame. */}
          {(status === 'idle' || status === 'loading') && items.length === 0 && (
            <p className="flex items-center justify-center gap-2 px-3 py-8 text-[12px] text-surface-500">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading notifications…
            </p>
          )}

          {/* Could not load, and nothing loaded before. NOT "No notifications yet" — that would
              tell the merchant there is nothing, when the truth is that nobody could look. */}
          {status === 'error' && items.length === 0 && (
            <div className="px-3 py-8 text-center">
              <p className="text-[12.5px] font-medium text-surface-700">Your notifications could not be loaded.</p>
              <Button variant="secondary" onClick={() => void loadNotifications()} className="mt-2">Try again</Button>
            </div>
          )}

          {/* Notifications are written only by events that happened — a finished or failed audit,
              a failed sync, an expired token, an uninstall. An empty list is therefore a real
              state, not a loading gap, and it says what would put something here. Shown only
              after a load that succeeded. */}
          {status === 'ready' && items.length === 0 && (
            <div className="px-3 py-8 text-center">
              <BellOff size={18} className="mx-auto text-surface-300" aria-hidden="true" />
              <p className="mt-2 text-[12.5px] font-medium text-surface-700">No notifications yet</p>
              <p className="mt-1 text-[11.5px] leading-[1.45] text-surface-500">
                Rankvora AI will tell you here when an audit finishes or could not finish, when a pillar score moves, when your store connection changes — connected, expired or removed — and, if you have it switched on, with a summary every Monday.
              </p>
            </div>
          )}

          {/* A row, not a button, so the per-row remove control is not nested inside a clickable
              element — a button inside a button is invalid HTML and the inner one stops working. */}
          {items.map((notification) => {
            const Icon = iconForNotification(notification.type, notification.tone);
            return (
              <div
                key={notification.id}
                className={`flex items-start gap-2.5 border-b border-surface-100 px-3 py-2 transition-colors last:border-b-0 ${notification.isRead ? 'bg-surface-0' : 'bg-brand-50/40'}`}
              >
                <Icon size={16} className={`mt-0.5 flex-shrink-0 ${notification.isRead ? 'text-surface-400' : 'text-brand-600'}`} />
                <button
                  type="button"
                  onClick={() => openNotification(notification)}
                  className="group min-w-0 flex-1 text-left"
                  aria-label={`Open "${notification.title}"`}
                >
                  <span className={`block text-[12.5px] group-hover:underline ${notification.isRead ? 'font-medium text-surface-700' : 'font-bold text-surface-900'}`}>{notification.title}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-[1.4] text-surface-500">{notification.message}</span>
                  <span className="mt-1 block text-[11px] text-surface-400">{formatNotificationTime(notification.createdAt)}</span>
                </button>
                {!notification.isRead && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                {/* Says the row leads somewhere. Decorative — the whole title is the control. */}
                <ChevronRight size={13} className="mt-1.5 flex-shrink-0 text-surface-300" aria-hidden="true" />
                <Button variant="ghost" onClick={() => void dismissNotification(notification.id)} accessibilityLabel={`Remove "${notification.title}"`} icon="x" />
              </div>
            );
          })}

          {/* The rest of the history, a page at a time. Up to the server's ceiling; past it the
              page says so and how to reach older ones, rather than implying this is everything. */}
          {items.length > 0 && olderRemaining > 0 && (
            <div className="border-t border-surface-100 px-3 py-2 text-center">
              {canShowOlder ? (
                <Button variant="ghost" onClick={showOlder} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading…' : `Show older (${olderRemaining} more)`}
                </Button>
              ) : (
                <p className="text-[11px] text-surface-500">
                  Showing the latest {items.length}. Clear read notifications to see older ones.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </AppPage>
  );
}
