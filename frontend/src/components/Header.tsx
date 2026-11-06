import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu, Moon, Search, Sun } from 'lucide-react';
import Breadcrumbs from './Breadcrumbs';
import HeaderSearch from './HeaderSearch';
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
  const { theme, toggle } = useTheme();
  const headerRef = useRef<HTMLElement>(null);
  const [user, setUser] = useState<UserRow | null>(null);
  const [openMenu, setOpenMenu] = useState<'profile' | null>(null);
  /** Phone only: whether the icon has expanded into the field. Irrelevant from `sm` up, where the
   * field is always present. */
  const [searchOpen, setSearchOpen] = useState(false);
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

  const toggleMenu = (menu: 'profile') => {
    setOpenMenu((current) => (current === menu ? null : menu));
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
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
