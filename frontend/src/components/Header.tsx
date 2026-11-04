import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, Menu, Moon, Search, Sun } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Breadcrumbs from './Breadcrumbs';
import HeaderSearch from './HeaderSearch';
import {
  formatNotificationTime,
  iconForNotification,
  markAllNotificationsRead,
  markNotificationRead,
  notificationTarget,
  useNotifications,
  type NotificationRecord,
} from '../data/notifications';
import { fetchCurrentUser, initialsFor, subscribeCurrentUser } from '../data/user.repository';
import { useTheme } from '../context/ThemeContext';
import type { UserRow } from '../data/api.types';

interface HeaderProps {
  onMenuClick: () => void;
}

/**
 * `onSearch` is gone, and so is the query state behind it.
 *
 * It was the seam kept here while search was unbuilt: the field submitted to a handler nobody
 * passed, so typing and pressing Enter did nothing at all. Search is real now and lives in
 * HeaderSearch, which owns its own query, its results and its keyboard handling — routing a
 * submission back up through this component would only give two places to hold one string.
 */
export default function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const headerRef = useRef<HTMLElement>(null);
  const [user, setUser] = useState<UserRow | null>(null);
  const [openMenu, setOpenMenu] = useState<'notifications' | 'profile' | null>(null);
  /** Phone only: whether the icon has expanded into the field. Irrelevant from `sm` up, where the
   * field is always present. */
  const [searchOpen, setSearchOpen] = useState(false);
  // Shared with the /notifications page. The bell used to keep its own array and its own count,
  // so marking everything read on that page left this badge showing the old number.
  const { items, unreadCount, status: notificationStatus, error: notificationError } = useNotifications();
  /**
   * THE BELL SHOWS UNREAD ONLY.
   *
   * It listed read ones too, which is why the panel could say "0 unread" above four notifications
   * — nothing ever left it, so a merchant who had dealt with everything still saw a full list and
   * no way to clear it. Reading one now removes it from here; the archive lives on
   * /notifications, where it can also be deleted for good.
   */
  const notifications = items.filter((notification) => !notification.isRead);

  useEffect(() => {
    let mounted = true;
    fetchCurrentUser()
      .then((current) => { if (mounted) setUser(current); })
      .catch((error) => console.error('Failed to load current user', error));
    const unsubscribe = subscribeCurrentUser((current) => { if (mounted) setUser(current); });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) setOpenMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const toggleMenu = (menu: 'notifications' | 'profile') => {
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  /**
   * Opens the page the notification is about — the dashboard's priority issues, the pillar that moved, the
   * audit that finished.
   *
   * It used to go to /notifications for every one of them: the full list of the same notices,
   * reached by clicking out of a panel already showing them, and the one page in the app that can
   * do nothing about any of them. Reading it still goes through the shared store, which rolls the
   * optimistic change back and surfaces the reason if the request fails.
   */
  const openNotification = (notification: NotificationRecord) => {
    setOpenMenu(null);
    void markNotificationRead(notification.id);
    navigate(notificationTarget(notification));
  };

  return (
    <header ref={headerRef} className="sticky top-0 z-30 border-b border-chrome-border bg-chrome">
      {/* 48px, down from 64. The bar carries a breadcrumb, a search field and three icon buttons —
          none of which is taller than 32px — so the other 16px were pure inset. */}
      <div className="flex h-12 items-center justify-between gap-3 px-3 lg:px-5">
        {/* Left: Mobile Menu + Page Context */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onMenuClick}
            className="lg:hidden p-1.5 -ml-1.5 text-surface-500 hover:text-surface-900 hover:bg-surface-100 rounded-lg transition-colors active:scale-[0.98]"
            aria-label="Open navigation menu"
          >
            <Menu size={18} />
          </button>

          <div className="min-w-0">
            <Breadcrumbs compact />
          </div>

        </div>

        {/* Right: Search + Actions */}
        <div className="relative flex items-center gap-1.5">
          {/*
            Search.
            Two presentations of ONE control, not two controls: a field from `sm` up, and an icon
            below it that expands into the same field. A 300px input cannot share a 16px-tall bar
            with the breadcrumb, the bell and the avatar on a phone, and shrinking it to fit would
            leave something too small to type into.

            The field, its results and its keyboard handling all live in HeaderSearch. This bar
            owns placement and nothing else, so the two presentations can differ in width without
            ever holding different state.
          */}
          <div className={`${searchOpen ? 'block' : 'hidden'} sm:block`}>
            <HeaderSearch className="w-[190px] md:w-[260px] lg:w-[330px]" />
          </div>

          {/* Phone: the same search, collapsed to its icon. */}
          <button
            type="button"
            onClick={() => { setSearchOpen(true); window.requestAnimationFrame(() => document.getElementById('header-search')?.focus()); }}
            aria-label="Search"
            aria-expanded={searchOpen}
            className={`cursor-pointer rounded-md p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 active:scale-[0.98] sm:hidden ${searchOpen ? 'hidden' : ''}`}
          >
            <Search size={17} />
          </button>

          {/* Theme. One button cycling light → dark, reading its label from what is on screen so
              it says what it will DO, not what it currently is. */}
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="cursor-pointer rounded-md p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 active:scale-[0.98]"
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          {/* Notifications */}
          <button
            onClick={() => toggleMenu('notifications')}
            aria-expanded={openMenu === 'notifications'}
            className="relative p-1.5 text-surface-400 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors active:scale-[0.98]"
            aria-label="Notifications"
          >
            <Bell size={17} />
            {/* Capped, because a three-digit count does not fit the badge. The exact number is in
                the panel header and on /notifications. */}
            {unreadCount > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-critical-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>

          {openMenu === 'notifications' && (
            <div className="absolute right-0 top-10 z-50 w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-surface-200 bg-surface-0 shadow-xl" role="dialog" aria-label="Notifications">
              <div className="flex items-center justify-between border-b border-surface-200 px-3 py-2">
                <div><h2 className="text-[13px] font-semibold text-surface-900">Notifications</h2><p className="text-[11px] text-surface-500">{unreadCount} unread</p></div>
                <button type="button" onClick={() => void markAllNotificationsRead()} disabled={unreadCount === 0} className="text-[11px] font-semibold text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:text-surface-300">Mark all as read</button>
              </div>
              {/* A failed write is said out loud instead of only reaching the console — the row
                  has already been rolled back, so silence would leave the customer believing a
                  change stuck that did not. */}
              {notificationError && (
                <p role="alert" className="border-b border-critical-100 bg-critical-50 px-3 py-1.5 text-[11px] text-critical-700">{notificationError}</p>
              )}
              <div className="max-h-[min(400px,calc(100vh-7rem))] overflow-y-auto">
                {/* Before the first load answers — or when it failed — nothing is known, so no empty
                    state is claimed. The failure itself is the alert above. */}
                {notifications.length === 0 && items.length === 0 && notificationStatus !== 'ready' && notificationStatus !== 'error' && (
                  <p className="px-3 py-6 text-center text-[11.5px] text-surface-500">Loading notifications…</p>
                )}
                {/* Two different empty states, because they mean different things: nothing has
                    happened yet, versus everything that happened has been dealt with. Only after a
                    load that succeeded — or with rows already loaded — is either one true. */}
                {notifications.length === 0 && (items.length > 0 || notificationStatus === 'ready') && (
                  <p className="px-3 py-6 text-center text-[11.5px] leading-[1.45] text-surface-500">
                    {items.length > 0 ? (
                      <>
                        You're all caught up.<br />
                        <span className="text-surface-400">Read notifications stay on the notifications page.</span>
                      </>
                    ) : (
                      <>
                        Nothing to report yet.<br />
                        <span className="text-surface-400">You'll hear about finished and failed audits, score changes, connection problems and your Monday summary here.</span>
                      </>
                    )}
                  </p>
                )}
                {notifications.map((notification) => {
                  const Icon = iconForNotification(notification.type, notification.tone);
                  return <button type="button" key={notification.id} onClick={() => openNotification(notification)} className={`flex w-full gap-2.5 border-b border-surface-100 px-3 py-2 text-left transition-colors hover:bg-surface-50 ${notification.isRead ? 'bg-surface-0' : 'bg-brand-50/40'}`}>
                    <Icon size={15} className={`mt-0.5 flex-shrink-0 ${notification.isRead ? 'text-surface-400' : 'text-brand-600'}`} />
                    <span className="min-w-0 flex-1"><span className={`block text-[12px] ${notification.isRead ? 'font-medium text-surface-700' : 'font-semibold text-surface-900'}`}>{notification.title}</span><span className="mt-0.5 block text-[11px] leading-[1.35] text-surface-500">{notification.message}</span><span className="mt-1 block text-[10px] text-surface-400">{formatNotificationTime(notification.createdAt)}</span></span>
                    {!notification.isRead && <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                  </button>;
                })}
              </div>
              {/* This used to only close the panel — the one thing its label promised not to do. */}
              <div className="px-3 py-2 text-center"><button type="button" onClick={() => { setOpenMenu(null); navigate('/notifications'); }} className="text-[11px] font-semibold text-brand-600 hover:text-brand-700">View all notifications</button></div>
            </div>
          )}

          {/* Divider */}
          <div className="h-5 w-px bg-surface-200 mx-1.5 hidden sm:block" />

          {/* Profile Dropdown Trigger */}
          <button
            type="button"
            onClick={() => toggleMenu('profile')}
            aria-expanded={openMenu === 'profile'}
            className="flex items-center gap-1.5 p-1 pr-1.5 rounded-md hover:bg-surface-100 transition-colors active:scale-[0.98]"
            aria-label="Account menu"
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-brand-100 to-brand-50 border border-brand-200 flex items-center justify-center shadow-sm">
              <span className="text-brand-700 text-[10.5px] font-bold tracking-wide">{user ? initialsFor(user.fullName) : '··'}</span>
            </div>
            <ChevronDown size={13} className="text-surface-400 hidden sm:block" />
          </button>

          {openMenu === 'profile' && (
            <div className="absolute right-0 top-10 z-50 w-60 overflow-hidden rounded-xl border border-surface-200 bg-surface-0 shadow-xl" role="menu" aria-label="Account menu">
              <div className="border-b border-surface-200 px-3 py-2.5"><p className="text-[13px] font-semibold text-surface-900">{user?.fullName ?? 'Loading…'}</p><p className="mt-0.5 truncate text-[11px] text-surface-500">{user?.email ?? ''}</p><p className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-surface-400">{user?.role ?? ''}</p></div>
              <div className="p-1">
                <button type="button" onClick={() => { navigate('/settings/profile'); setOpenMenu(null); }} className="w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium text-surface-700 hover:bg-surface-100" role="menuitem">Profile</button>
                <button type="button" onClick={() => { navigate('/settings/workspace'); setOpenMenu(null); }} className="w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium text-surface-700 hover:bg-surface-100" role="menuitem">Workspace</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
