import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Badge, { type BadgeTone } from '../../polaris/Badge';
import Banner from '../../polaris/Banner';
import Button from '../../polaris/Button';
import { SearchField, SelectField } from '../../polaris/fields';
import { ApiError } from '../../../lib/api';
import { useAuditCompletion } from '../../../data/useAuditRun';
import {
  cancelLinkScan,
  downloadLinkScanCsv,
  fetchLatestLinkScan,
  fetchLinkRows,
  fetchLinkSources,
  isActive,
  startLinkScan,
  type LinkOutcome,
  type LinkRow,
  type LinkRows,
  type LinkScan,
  type LinkScanSummary,
  type LinkScope,
  type LinkSources,
  type LinkTally,
  type LinkView,
} from '../../../data/linkScan.repository';
import { card, cardHeader, cardHeadingRow, cardTitle, eyebrow } from '../subpillar/tone';

/**
 * ─── The complete link scan, on the Internal Links page ──────────────
 *
 * Every page of the store is loaded and every link on it is requested — links to the store's own pages and to
 * other websites — and this is where the merchant sees what came back: the totals, every broken link, which
 * pages contain it, and a spreadsheet of it all. It shows what the scan REALLY found and nothing else: a store
 * that has not been scanned shows a button, not placeholder numbers, and a scan that is still running shows the
 * results of the last finished one under its own progress.
 *
 * It follows the scan by asking the server how it is going every few seconds while one is running; the scan itself
 * runs on the server, so leaving the page does not stop it.
 */

/** How often a running scan is asked about, and how often an idle page looks for one started elsewhere — after an analysis, or in another tab. */
const POLL_MS = 2500;
const IDLE_POLL_MS = 15000;
const PAGE_SIZE = 25;

const VIEWS: Array<{ view: LinkView; label: string; hint: string }> = [
  { view: 'broken', label: 'Broken', hint: 'Links that lead to an error page or nowhere' },
  { view: 'redirect', label: 'Redirected', hint: 'Links that work, but only after being sent somewhere else' },
  { view: 'unverified', label: 'Could not check', hint: 'Sites that refused or did not answer the check' },
  { view: 'ok', label: 'Working', hint: 'Links that answered normally' },
  { view: 'all', label: 'All links', hint: 'Every address that was checked' },
];

const OUTCOME: Record<LinkOutcome, { label: string; tone: BadgeTone }> = {
  broken: { label: 'Broken', tone: 'critical' },
  redirect: { label: 'Redirects', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'neutral' },
  unverified: { label: 'Not verified', tone: 'neutral' },
  skipped: { label: 'Not requested', tone: 'neutral' },
  ok: { label: 'Works', tone: 'success' },
};

const number = (value: number) => value.toLocaleString('en-US');

/** How many addresses a tab holds for the chosen scope — from the scan's own totals. */
function countFor(summary: LinkScanSummary, view: LinkView, scope: LinkScope): number {
  const of = (tally: LinkTally) => {
    switch (view) {
      case 'broken': return tally.broken;
      case 'redirect': return tally.redirect;
      case 'unverified': return tally.blocked + tally.unverified + tally.skipped;
      case 'ok': return tally.ok;
      default: return tally.ok + tally.redirect + tally.broken + tally.blocked + tally.unverified + tally.skipped;
    }
  };
  if (scope === 'internal') return of(summary.internal);
  if (scope === 'external') return of(summary.external);
  return of(summary.internal) + of(summary.external);
}

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Opens in a new tab and says where it goes; a long address is cut in the middle by CSS, never in the text. */
function Address({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="block max-w-[26rem] truncate text-[12px] font-medium text-brand-700 hover:underline">
      {url}
    </a>
  );
}

export default function LinkScanPanel() {
  const [latest, setLatest] = useState<LinkScan | null>(null);
  const [lastCompleted, setLastCompleted] = useState<LinkScan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [view, setView] = useState<LinkView>('broken');
  const [scope, setScope] = useState<LinkScope>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LinkRows | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [sources, setSources] = useState<Record<number, LinkSources | 'loading' | 'error'>>({});
  const resultsRef = useRef<HTMLDivElement>(null);

  // The results on screen are the newest scan that finished — never the one still running.
  const shown = lastCompleted;
  const running = isActive(latest);
  const summary = shown?.summary ?? null;

  const refresh = useCallback(async () => {
    try {
      const result = await fetchLatestLinkScan();
      setLatest(result.latest);
      setLastCompleted(result.lastCompleted);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'The link scan could not be loaded.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // While a scan runs, ask how it is going — and when none is, look now and then for one started elsewhere: the
  // scan an analysis starts by itself, or one begun in another tab. A hidden tab does not ask.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, running ? POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  // An analysis that has just finished starts a scan of its own, a moment later: look for it.
  useAuditCompletion(() => {
    void refresh();
    window.setTimeout(() => void refresh(), 4000);
  });

  // The search box waits for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const shownId = shown?.id ?? null;
  useEffect(() => {
    if (shownId === null) { setRows(null); return undefined; }
    let active = true;
    setRowsLoading(true);
    fetchLinkRows(shownId, { view, scope, q: query, page, limit: PAGE_SIZE })
      .then((result) => { if (active) { setRows(result); setRowsError(null); } })
      .catch((error) => { if (active) setRowsError(error instanceof ApiError ? error.message : 'The links could not be loaded.'); })
      .finally(() => { if (active) setRowsLoading(false); });
    return () => { active = false; };
  }, [shownId, view, scope, query, page]);

  // A different scan, view or page shows different rows: what was open belongs to the old ones.
  useEffect(() => { setOpen(null); }, [shownId, view, scope, query, page]);
  useEffect(() => { setSources({}); }, [shownId]);

  const start = async () => {
    setStarting(true);
    setProblem(null);
    try {
      setLatest(await startLinkScan());
    } catch (error) {
      // A scan that is already running (started from another tab, or after an audit) is followed, not an error.
      if (error instanceof ApiError && error.code === 'LINK_SCAN_IN_PROGRESS') await refresh();
      else setProblem(error instanceof ApiError ? error.message : 'The scan could not be started. Try again.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!latest) return;
    setCancelling(true);
    try {
      setLatest(await cancelLinkScan(latest.id));
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'The link scan could not be cancelled.');
    } finally {
      setCancelling(false);
    }
  };

  const exportCsv = async () => {
    if (!shown) return;
    setExporting(true);
    try {
      await downloadLinkScanCsv(shown.id);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'The spreadsheet could not be downloaded.');
    } finally {
      setExporting(false);
    }
  };

  const toggleSources = (row: LinkRow) => {
    if (open === row.id) { setOpen(null); return; }
    setOpen(row.id);
    if (!shown || sources[row.id] !== undefined) return;
    setSources((current) => ({ ...current, [row.id]: 'loading' }));
    fetchLinkSources(shown.id, row.id)
      .then((result) => setSources((current) => ({ ...current, [row.id]: result })))
      .catch(() => setSources((current) => ({ ...current, [row.id]: 'error' })));
  };

  const choose = (nextView: LinkView, nextScope: LinkScope = scope) => {
    setView(nextView);
    setScope(nextScope);
    setPage(1);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const brokenInternal = summary?.internal.broken ?? 0;
  const brokenExternal = summary?.external.broken ?? 0;
  const tiles = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'Pages loaded', value: summary.pagesCrawled, onClick: undefined },
      { label: 'Links found', value: summary.linksFound, note: `${number(summary.urlsChecked)} addresses checked`, onClick: undefined },
      { label: 'Broken — your store', value: brokenInternal, tone: brokenInternal > 0 ? 'critical' : 'good', onClick: () => choose('broken', 'internal') },
      { label: 'Broken — other sites', value: brokenExternal, tone: brokenExternal > 0 ? 'critical' : 'good', onClick: () => choose('broken', 'external') },
      { label: 'Redirected', value: summary.internal.redirect + summary.external.redirect, onClick: () => choose('redirect', 'all') },
      { label: 'Could not check', value: summary.internal.blocked + summary.internal.unverified + summary.internal.skipped + summary.external.blocked + summary.external.unverified + summary.external.skipped, onClick: () => choose('unverified', 'all') },
    ] as Array<{ label: string; value: number; note?: string; tone?: 'critical' | 'good'; onClick: (() => void) | undefined }>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, brokenInternal, brokenExternal]);

  // ─── Header ────────────────────────────────────────────────────────

  const scanButton = (
    <Button variant={shown ? 'secondary' : 'primary'} onClick={() => void start()} loading={starting} disabled={running || starting}>
      {shown ? 'Scan again' : 'Scan every link'}
    </Button>
  );

  return (
    <section aria-label="Complete link scan" className={card}>
      <div className={`${cardHeader} flex flex-wrap items-center justify-between gap-2`}>
        <div className={cardHeadingRow}>
          <h2 className={cardTitle}>Link scan</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {shown && !running && <Button variant="ghost" onClick={() => void exportCsv()} loading={exporting} disabled={exporting}>Download spreadsheet</Button>}
          {running && <Button variant="ghost" onClick={() => void cancel()} loading={cancelling} disabled={cancelling}>Cancel scan</Button>}
          {scanButton}
        </div>
      </div>

      <div className="space-y-3 p-3.5">
        {problem && <Banner key={problem} tone="critical" onDismiss={() => setProblem(null)}>{problem}</Banner>}

        {!loaded && <p className="text-[12.5px] text-surface-500">Loading…</p>}

        {loaded && !latest && (
          <div className="rounded-lg border border-dashed border-surface-300 px-4 py-6 text-center">
            <p className="text-[13px] font-semibold text-surface-900">Not scanned yet</p>
          </div>
        )}

        {running && latest && (
          <div className="rounded-lg border border-surface-200 bg-surface-50/60 p-3" role="status" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[12.5px] font-semibold text-surface-900">{latest.status === 'queued' ? 'Starting the scan…' : 'Scanning your store'}</p>
              <p className="text-[11.5px] tabular-nums text-surface-500">{latest.progress}%</p>
            </div>
            <div className="mt-2"><s-progress value={latest.progress} max={100} accessibilityLabel="Link scan progress" /></div>
            <p className="mt-2 text-[12px] text-surface-600">{latest.stage ?? 'Starting'}</p>
            {latest.summary && (
              <p className="mt-1 text-[11.5px] text-surface-500">
                {number(latest.summary.linksFound)} links found so far
                {latest.summary.internal.broken + latest.summary.external.broken > 0 && ` · ${number(latest.summary.internal.broken + latest.summary.external.broken)} broken`}
              </p>
            )}
            {shown && <p className="mt-1 text-[11.5px] text-surface-500">Showing the scan of {when(shown.finishedAt)}.</p>}
          </div>
        )}

        {latest && latest.status === 'failed' && (
          <Banner key={`failed-${latest.id}`} tone="critical" heading="Scan did not finish">
            {latest.error}
          </Banner>
        )}
        {latest && latest.status === 'cancelled' && <Banner key={`cancelled-${latest.id}`} tone="info">Last scan cancelled.</Banner>}

        {shown && summary && (
          <>
            <p className="text-[11.5px] text-surface-500">
              Scanned {when(shown.finishedAt)}{shown.origin ? ` · ${shown.origin}` : ''}
              {shown.trigger === 'audit' ? ' · started after an analysis' : ''}
            </p>

            {shown.limitReached === 'urls' && (
              <Banner key={`limit-${shown.id}`} tone="warning" heading="Part of your store was not checked">
                Only the first {number(summary.urlsFound)} addresses were checked.
              </Banner>
            )}

            <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="Link scan totals">
              {tiles.map((tile) => {
                const body = (
                  <>
                    <span className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-surface-500">{tile.label}</span>
                    <span className={`mt-0.5 block text-[22px] font-bold leading-tight tabular-nums ${tile.tone === 'critical' ? 'text-critical-700' : tile.tone === 'good' ? 'text-success-700' : 'text-surface-950'}`}>{number(tile.value)}</span>
                    {tile.note && <span className="block text-[11px] text-surface-500">{tile.note}</span>}
                  </>
                );
                return (
                  <li key={tile.label}>
                    {tile.onClick ? (
                      <button type="button" onClick={tile.onClick} className="block w-full rounded-lg border border-surface-200 bg-surface-0 px-3 py-2 text-left transition-colors hover:border-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{body}</button>
                    ) : (
                      <div className="rounded-lg border border-surface-200 bg-surface-0 px-3 py-2">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>

            {brokenInternal + brokenExternal === 0 && (
              <Banner key={`clean-${shown.id}`} tone="success" heading="No broken links">
                All {number(summary.urlsChecked)} addresses answered.
              </Banner>
            )}

            <div ref={resultsRef} className="scroll-mt-3">
              <div role="tablist" aria-label="Kind of link" className="flex flex-wrap gap-1 border-b border-surface-200">
                {VIEWS.map((entry) => {
                  const selected = view === entry.view;
                  return (
                    <button
                      key={entry.view}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      title={entry.hint}
                      onClick={() => choose(entry.view)}
                      className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${selected ? 'border-brand-600 text-brand-700' : 'border-transparent text-surface-600 hover:text-surface-900'}`}
                    >
                      {entry.label} <span className="tabular-nums text-surface-500">{number(countFor(summary, entry.view, scope))}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_14rem]">
                <SearchField label="Search the links" value={search} onChange={setSearch} placeholder="Search by address…" />
                <SelectField
                  label="Links to"
                  labelHidden
                  value={scope}
                  options={['all', 'internal', 'external'] as const}
                  optionLabel={(option) => (option === 'all' ? 'Your store and other sites' : option === 'internal' ? 'Your store only' : 'Other websites only')}
                  onChange={(next) => { setScope(next); setPage(1); }}
                />
              </div>

              {rowsError && <div className="mt-2"><Banner key={rowsError} tone="critical">{rowsError}</Banner></div>}

              <div className="mt-2 overflow-x-auto rounded-lg border border-surface-200" aria-busy={rowsLoading}>
                {rows && rows.items.length > 0 ? (
                  <table className="table-compact w-full">
                    <caption className="sr-only">Links found by the scan</caption>
                    <thead className="border-b border-surface-200 bg-surface-0">
                      <tr>
                        <th scope="col" className="text-left">Link</th>
                        <th scope="col" className="text-left">Result</th>
                        <th scope="col" className="text-left">What happened</th>
                        <th scope="col" className="text-right">Found on</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-200">
                      {rows.items.map((row) => (
                        <LinkRowView key={row.id} row={row} expanded={open === row.id} sources={sources[row.id]} onToggle={() => toggleSources(row)} />
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="px-4 py-8 text-center">
                    <p className="text-[13px] font-semibold text-surface-900">{rowsLoading ? 'Loading links…' : 'Nothing here'}</p>
                    {!rowsLoading && (
                      <p className="mt-0.5 text-[11.5px] text-surface-500">
                        {query ? 'No link matches that search.' : view === 'broken' ? 'No broken links for this selection.' : 'No links for this selection.'}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {rows && rows.pagination.total > 0 && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-surface-500">
                  <span>
                    Showing {number((rows.pagination.page - 1) * rows.pagination.limit + 1)}–{number(Math.min(rows.pagination.page * rows.pagination.limit, rows.pagination.total))} of {number(rows.pagination.total)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Button variant="ghost" disabled={page <= 1 || rowsLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
                    <span className="tabular-nums">Page {rows.pagination.page} of {rows.pagination.totalPages}</span>
                    <Button variant="ghost" disabled={page >= rows.pagination.totalPages || rowsLoading} onClick={() => setPage((current) => current + 1)}>Next</Button>
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ─── One row, and the pages that contain its link ────────────────────

interface RowProps {
  row: LinkRow;
  expanded: boolean;
  sources: LinkSources | 'loading' | 'error' | undefined;
  onToggle: () => void;
}

function LinkRowView({ row, expanded, sources, onToggle }: RowProps) {
  const outcome = row.outcome ? OUTCOME[row.outcome] : null;
  const count = row.sourceCount ?? 0;
  return (
    <>
      <tr className="align-top transition-colors hover:bg-surface-50">
        <td>
          <Address url={row.url} />
          <span className="mt-0.5 block text-[10.5px] text-surface-500">
            {row.internal ? 'Your store' : 'Another website'}
            {row.inSitemap && ' · listed in your sitemap'}
          </span>
        </td>
        <td className="whitespace-nowrap">
          {outcome && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
          {row.status !== null && <span className="ml-1.5 text-[11px] tabular-nums text-surface-500">HTTP {row.status}</span>}
        </td>
        <td className="max-w-[24rem] text-[12px] leading-[1.45] text-surface-700">
          {row.detail ?? '—'}
          {row.finalUrl && row.outcome === 'redirect' && (
            <span className="mt-0.5 block max-w-[22rem] truncate text-[11px] text-surface-500" title={row.finalUrl}>Ends at {row.finalUrl}</span>
          )}
        </td>
        <td className="whitespace-nowrap text-right">
          {count > 0 ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="text-[12px] font-medium text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {number(count)} {count === 1 ? 'page' : 'pages'}{expanded ? ' ▴' : ' ▾'}
            </button>
          ) : (
            <span className="text-[11.5px] text-surface-400">{row.inSitemap ? 'Sitemap only' : 'No page links here'}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-50/70">
          <td colSpan={4} className="px-3.5 py-2">
            {sources === 'loading' || sources === undefined ? (
              <p className="text-[12px] text-surface-500">Finding the pages…</p>
            ) : sources === 'error' ? (
              <p className="text-[12px] text-critical-700">The pages could not be loaded.</p>
            ) : (
              <>
                <p className={eyebrow}>Found on</p>
                <ul className="mt-1 space-y-0.5">
                  {sources.sources.map((source) => (
                    <li key={source.page} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                      <a href={source.page} target="_blank" rel="noreferrer noopener" className="max-w-[28rem] truncate font-medium text-brand-700 hover:underline" title={source.page}>{source.page}</a>
                      {source.anchor && <span className="text-surface-500">link text: “{source.anchor}”</span>}
                    </li>
                  ))}
                </ul>
                {sources.total > sources.sources.length && (
                  <p className="mt-1 text-[11.5px] text-surface-500">
                    Showing {sources.sources.length} of {number(sources.total)} pages.
                  </p>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
