import { useSyncExternalStore } from 'react';

/**
 * ─── The reporting period every Google-backed card reads ─────────────
 *
 * AI referral traffic, Google Analytics and Google Search Console each used to declare their own
 * `const REPORT_DAYS = 28`. Three identical constants agreeing by coincidence, none of them
 * reachable by the merchant: changing the period meant editing the source and redeploying.
 *
 * ONE value, shared, and the merchant owns it. The cards subscribe to it rather than importing a
 * number, so the Integrations page cannot end up showing Analytics over 90 days beside Search
 * Console over 28 — a comparison that looks valid and is not.
 *
 * ─── Nothing here is data ────────────────────────────────────────────
 * This module holds a VIEW PREFERENCE — which question to ask Google — and never an answer. No
 * metric, no session count and no date is stored, defaulted or remembered here. Every figure on
 * every card is still read from Google in the request that renders it, and the dates shown are the
 * dates Google answered for, which the API returns. Change the period and the card re-reads; it
 * never re-labels numbers it already had.
 *
 * ─── Why localStorage ────────────────────────────────────────────────
 * A per-browser convenience, exactly like the collapsed sidebar and the recent-search list. It is
 * not state the product depends on: every read is wrapped, a browser that refuses storage simply
 * starts at the default each visit, and the server is never told. Persisting it per store would
 * need a schema change — worth doing only if merchants ask to have it follow them between devices.
 */

const STORAGE_KEY = 'scorelo-report-days';

export interface ReportWindow {
  days: number;
  /** What the merchant picks. Short, because three of these sit in a card header. */
  label: string;
}

/**
 * The windows offered.
 *
 * Every value is inside BOTH server-side caps — 1-365 on /ai-discovery/referrals, 1-480 on the two
 * /google performance routes — so no choice here can produce a request the API rejects. Adding one
 * means adding a row: the cards read this list rather than hard-coding buttons.
 */
export const REPORT_WINDOWS: readonly ReportWindow[] = [
  { days: 7, label: '7d' },
  { days: 28, label: '28d' },
  { days: 90, label: '90d' },
];

/** What every card asked for before the period was selectable, so nothing shifts on first load. */
export const DEFAULT_REPORT_DAYS = 28;

function isOffered(days: number): boolean {
  return REPORT_WINDOWS.some((option) => option.days === days);
}

/**
 * Reads the stored preference, or the default.
 *
 * A stored value that is no longer offered — because this list changed between deploys — falls back
 * rather than being sent to the API. The cards would otherwise request a window the picker cannot
 * show as selected, leaving the merchant unable to tell what they are looking at.
 */
function readStored(): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return isOffered(stored) ? stored : DEFAULT_REPORT_DAYS;
  } catch {
    // Private mode, or storage disabled entirely. Not worth a word to the merchant.
    return DEFAULT_REPORT_DAYS;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

/** Another tab changed it. Rare, but two tabs disagreeing about the period is exactly the bug. */
function handleStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  current = readStored();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', handleStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', handleStorage);
  };
}

function getSnapshot(): number {
  return current;
}

/** Changes the period for every subscribed card at once, and remembers it for next time. */
export function setReportDays(days: number): void {
  if (!isOffered(days) || days === current) return;
  current = days;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(days));
  } catch {
    // The choice still applies for this session; it just will not survive a reload.
  }
  for (const listener of listeners) listener();
}

/** The period this card should ask Google for. Re-renders when any card changes it. */
export function useReportDays(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_REPORT_DAYS);
}
