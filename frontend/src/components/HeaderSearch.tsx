import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, CornerDownLeft, Loader2, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  clearRecentSearches,
  defaultDestinations,
  recentSearches,
  rememberSearch,
  searchDestinations,
  searchFindings,
  type SearchResult,
} from '../data/search';
import type { FindingRow } from '../data/api.types';

/**
 * ─── Header search ───────────────────────────────────────────────────
 *
 * Searches two things and says which is which: the app's own PAGES, matched in the browser, and
 * the store's open ISSUES, matched by the server against the latest audit.
 *
 * PAGES ANSWER ON THE KEYSTROKE. They are a static catalogue derived from the same source the
 * sidebar uses, so there is nothing to wait for. Issues are a request, debounced, and they arrive
 * into a panel that is already useful — which is why the two are not awaited together.
 *
 * A FAILED ISSUE SEARCH IS SAID, NOT SWALLOWED. If the request fails the pages still answer and
 * the panel reports that issues could not be searched. Showing pages alone in silence would imply
 * the store has no matching issues, which is a claim about their data made from a network error.
 *
 * NOTHING IS SHOWN FOR AN EMPTY QUERY. No "recent", no "suggested" — this app records neither, and
 * inventing a list to fill the panel is exactly the kind of decoration that reads as data.
 */

/** Long enough that a request is not fired per keystroke, short enough to feel immediate. */
const DEBOUNCE_MS = 220;

/** A one-letter query matches most of the catalogue and tells the server nothing useful. */
const MIN_QUERY = 2;

const SEVERITY_DOT: Record<FindingRow['severity'], string> = {
  critical: 'bg-critical-500',
  high: 'bg-warning-500',
  medium: 'bg-brand-500',
  low: 'bg-surface-400',
};

export default function HeaderSearch({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<SearchResult[]>([]);
  const [issueTotal, setIssueTotal] = useState(0);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState(false);
  const [active, setActive] = useState(0);
  /** The merchant's own last few searches, read from this browser. Empty until they search. */
  const [recent, setRecent] = useState<string[]>([]);

  const trimmed = query.trim();
  const ready = trimmed.length >= MIN_QUERY;

  // Read when the panel opens rather than on mount: a search run in another tab should show up
  // here without a reload, and this is the only moment it is about to be looked at.
  useEffect(() => {
    if (open && !ready) setRecent(recentSearches());
  }, [open, ready]);

  /** Real routes this app serves — offered as places to go, never as "popular" or "trending",
   * which would be a claim about other merchants that Rankvora AI measures nothing to support. */
  const jumpTo = useMemo(() => defaultDestinations(), []);

  // Synchronous, so the panel is never empty while the request is in flight.
  const pages = useMemo(() => (ready ? searchDestinations(trimmed) : []), [ready, trimmed]);

  const results = useMemo(() => [...pages, ...issues], [pages, issues]);

  // ── Issues, debounced ──────────────────────────────────────────────
  useEffect(() => {
    if (!ready) {
      setIssues([]);
      setIssueTotal(0);
      setIssuesError(false);
      setIssuesLoading(false);
      return;
    }

    let cancelled = false;
    setIssuesLoading(true);
    const timer = setTimeout(() => {
      searchFindings(trimmed)
        .then((outcome) => {
          if (cancelled) return;
          setIssues(outcome.results);
          setIssueTotal(outcome.total);
          setIssuesError(false);
        })
        .catch(() => {
          if (cancelled) return;
          // Not an empty result: nothing was learned about the store's issues, so nothing is
          // claimed about them. The panel says so.
          setIssues([]);
          setIssueTotal(0);
          setIssuesError(true);
        })
        .finally(() => {
          if (!cancelled) setIssuesLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready, trimmed]);

  // A changed result set invalidates the highlight — keeping index 3 while the list shrank to two
  // is how Enter opens something the merchant was not looking at.
  useEffect(() => {
    setActive(0);
  }, [results.length, trimmed]);

  // ── Dismissal ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Cmd/Ctrl-K from anywhere. The browser's own find-in-page keeps Cmd-F; this is the shortcut
  // every tool with a palette uses, so it is the one merchants will try.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * Opens a result.
   *
   * `remember` is the query that led here, recorded only when the merchant actually acted on a
   * search. A keystroke is not a search — storing every prefix would fill the history with "me",
   * "met", "meta" and leave the one thing they meant buried at the bottom.
   */
  const go = useCallback((to: string, remember?: string) => {
    if (remember) {
      rememberSearch(remember);
      setRecent(recentSearches());
    }
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    navigate(to);
  }, [navigate]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    // With nothing listed there is nowhere to go: Enter does nothing rather than open an empty page.
    if (!open || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results[active];
      if (chosen) go(chosen.to, trimmed);
    }
  };

  // Keeps the highlighted row in view when the list is longer than the panel.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const showPanel = open;
  const nothingFound = showPanel && ready && !issuesLoading && !issuesError && results.length === 0;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
        <label htmlFor="header-search" className="sr-only">Search pages and issues</label>
        <input
          ref={inputRef}
          id="header-search"
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="header-search-results"
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder="Search pages and issues…"
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-8 w-full rounded-md border border-surface-200 bg-surface-50 pl-8 pr-8 text-[12px] text-surface-900 outline-none transition placeholder:text-surface-400 focus:border-brand-400 focus:bg-surface-0 focus:ring-2 focus:ring-brand-100 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded text-surface-400 transition-colors hover:text-surface-700"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      {showPanel && (
        <div
          ref={panelRef}
          id="header-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[min(70vh,26rem)] overflow-y-auto rounded-lg border border-surface-200 bg-surface-0 py-1 shadow-[0_18px_44px_-24px_var(--c-shadow-lg)]"
        >
          {/* ── Before anything is typed ──────────────────────────── */}
          {!ready && (
            <>
              {recent.length > 0 && (
                <Group
                  label="Recent searches"
                  action={{
                    label: 'Clear',
                    onClick: () => { clearRecentSearches(); setRecent([]); },
                  }}
                >
                  {recent.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => { setQuery(term); inputRef.current?.focus(); }}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-50"
                    >
                      <Clock3 size={12} className="flex-shrink-0 text-surface-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-surface-800">{term}</span>
                    </button>
                  ))}
                </Group>
              )}

              <Group label="Jump to">
                {jumpTo.map((result) => (
                  <Row
                    key={result.id}
                    result={result}
                    active={false}
                    onChoose={() => go(result.to)}
                    onHover={() => undefined}
                  />
                ))}
              </Group>

              <p className="px-3 py-1 text-[10.5px] leading-[1.4] text-surface-400">
                Type to search every page and every open issue from your latest audit.
              </p>
            </>
          )}

          {ready && pages.length > 0 && (
            <Group label="Pages">
              {pages.map((result) => (
                <Row
                  key={result.id}
                  result={result}
                  active={results[active]?.id === result.id}
                  onChoose={() => go(result.to, trimmed)}
                  onHover={() => setActive(results.findIndex((entry) => entry.id === result.id))}
                />
              ))}
            </Group>
          )}

          {ready && (
          <Group label="Issues">
            {issuesLoading ? (
              <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] text-surface-500">
                <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Searching your latest audit…
              </p>
            ) : issuesError ? (
              // A statement about the request, never about the store.
              <p className="flex items-start gap-1.5 px-3 py-1.5 text-[11.5px] leading-[1.4] text-critical-700">
                <AlertCircle size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
                Issues could not be searched just now. The pages above still work.
              </p>
            ) : issues.length === 0 ? (
              <p className="px-3 py-1.5 text-[11.5px] text-surface-500">
                No open issue matches “{trimmed}”.
              </p>
            ) : (
              <>
                {issues.map((result) => (
                  <Row
                    key={result.id}
                    result={result}
                    active={results[active]?.id === result.id}
                    onChoose={() => go(result.to, trimmed)}
                    onHover={() => setActive(results.findIndex((entry) => entry.id === result.id))}
                  />
                ))}
                {/* Only when there genuinely are more than were shown. */}
                {/* Only when there genuinely are more than were shown — said, so a merchant knows to
                    narrow the search rather than assume these are all. */}
                {issueTotal > issues.length && (
                  <p className="px-3 py-1.5 text-[11.5px] text-surface-500">
                    Showing {issues.length} of {issueTotal} matching issues — type more of a title to narrow it down.
                  </p>
                )}
              </>
            )}
          </Group>
          )}

          {nothingFound && (
            <p className="px-3 py-2 text-[11.5px] leading-[1.4] text-surface-500">
              Nothing matches “{trimmed}”.
            </p>
          )}

          <div className="mt-1 flex items-center gap-2 border-t border-surface-100 px-3 pt-1.5 pb-0.5 text-[10.5px] text-surface-400">
            <span className="inline-flex items-center gap-1"><CornerDownLeft size={10} aria-hidden="true" />open</span>
            <span>↑↓ move</span>
            <span>esc close</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  action,
  children,
}: {
  label: string;
  /** A control that belongs to the group rather than to a row — "Clear" on recent searches. */
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between gap-2 px-3 py-1">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-surface-400">{label}</p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="cursor-pointer text-[10px] font-semibold text-surface-400 underline-offset-2 transition-colors hover:text-surface-700 hover:underline"
          >
            {action.label}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({
  result,
  active,
  onChoose,
  onHover,
}: {
  result: SearchResult;
  active: boolean;
  onChoose: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseEnter={onHover}
      onClick={onChoose}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        active ? 'bg-brand-50' : 'hover:bg-surface-50'
      }`}
    >
      {result.severity ? (
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${SEVERITY_DOT[result.severity]}`} aria-hidden="true" />
      ) : (
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-surface-300" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-surface-900">{result.title}</span>
        <span className="block truncate text-[10.5px] text-surface-500">{result.detail}</span>
      </span>
    </button>
  );
}
