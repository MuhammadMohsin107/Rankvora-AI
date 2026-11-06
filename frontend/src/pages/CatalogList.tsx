import { useCallback, useEffect, useMemo, useState } from 'react';
import { scrollChaining } from '../lib/scrollChaining';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ChevronDown, ChevronRight, ChevronUp, Clock3, Info, Radar } from 'lucide-react';
import { fetchCatalog, itemsForMove, type Catalog, type CatalogItem } from '../data/catalog.repository';
import { CATALOG_KINDS, type CatalogKind } from '../data/catalogKinds';
import { fetchOnboardingShared } from '../data/onboarding.repository';
import { isNotAuditedYet } from '../data/seo/subpillar.repository';
import { fetchDashboardData, formatLastUpdated } from '../data/dashboard/dashboard.repository';
import type { DashboardData, PriorityIssue } from '../data/dashboard/dashboard.types';
import AppPage from '../components/polaris/AppPage';
import WinningMovesPanel from '../components/dashboard/WinningMovesPanel';
import MovesPanel from '../components/catalog/MovesPanel';
import { IssueBadges, Thumbnail, formatCatalogDate } from '../components/catalog/CatalogBits';
import RunAuditButton from '../components/audit/RunAuditButton';
import { cardClass } from '../components/dashboard/scoreTone';
import Button from '../components/polaris/Button';
import { SearchField, SelectField } from '../components/polaris/fields';

type Tab = 'all' | 'critical' | 'warnings' | 'passing';
type Sort = 'worst' | 'name' | 'best' | 'updated';
const SORTS: readonly Sort[] = ['worst', 'best', 'updated', 'name'];
const SORT_LABELS: Record<Sort, string> = { worst: 'Needs most work first', best: 'Healthiest first', updated: 'Recently updated', name: 'Name A–Z' };

/** Rows per page — a long, scannable list, as in a store's own product table. */
const PAGE_SIZE = 50;

/** Which tab an item belongs to: its worst verdict decides. */
function tabOf(item: CatalogItem): Exclude<Tab, 'all'> {
  if (item.critical > 0) return 'critical';
  if (item.warnings > 0) return 'warnings';
  return 'passing';
}


const scrollbar = '[scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]';

/** The line under an item's name, from facts a check recorded — nothing when none was. */
/**
 * The storefront handle of a product or collection, read from the URL the checks recorded for it
 * (/products/{handle}, /collections/{handle}). Null when the item has no URL or the path is not that
 * shape — and then it simply is not matched, rather than guessed at.
 */
function handleOf(kind: CatalogKind, url: string | null): string | null {
  if (!url || (kind !== 'product' && kind !== 'collection')) return null;
  try {
    const segments = new URL(url, 'https://placeholder.invalid').pathname.split('/').filter(Boolean);
    const at = segments.indexOf(kind === 'product' ? 'products' : 'collections');
    return at >= 0 && segments[at + 1] ? decodeURIComponent(segments[at + 1]) : null;
  } catch {
    return null;
  }
}

function secondaryLine(kind: CatalogKind, item: CatalogItem): string | null {
  if (kind === 'collection' && item.productCount !== null) return `${item.productCount.toLocaleString()} ${item.productCount === 1 ? 'product' : 'products'}`;
  if (kind === 'article') {
    const published = formatCatalogDate(item.publishedAt);
    return published ? `Published ${published}` : null;
  }
  return null;
}

/**
 * The list of one kind of catalog item — /products, /collections or /blog-articles: the latest
 * audit, one row per item. ONE page for all three; data/catalogKinds.ts says what differs.
 *
 * Laid out like the list page of a store-health app, in one view:
 *   · the table on the left — tabs that carry the counts, search and sort, then a row per item with
 *     its photo, name, issue pills, the share of its checks it passed and when Shopify last recorded
 *     a change to it. A row opens the item's own page (`<list>/:id`);
 *   · Winning moves on the right — the dashboard's own ranked fixes. A move about this kind of item
 *     filters the table to the items it names ("Filtered view"), and the filter lives in the
 *     address, so the dashboard can link straight to it.
 * Both lists scroll inside their own column; on a narrower screen Winning moves opens as a panel.
 *
 * It measures nothing itself. See data/catalog.repository.ts for how rows are regrouped.
 */
export default function CatalogList({ kind }: { kind: CatalogKind }) {
  const config = CATALOG_KINDS[kind];
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [movesState, setMovesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('worst');
  /**
   * The handles of the pages the merchant marked as priorities in guided setup, for this kind of
   * item. Empty for articles (setup offers products and collections) and for a store that chose
   * none — and then nothing on this list is marked or reordered.
   */
  const [priorityHandles, setPriorityHandles] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [movesOpen, setMovesOpen] = useState(false);
  const closeMoves = useCallback(() => setMovesOpen(false), []);

  // The move the table is filtered to, read from the address: ?area=content/product-descriptions&issue=…
  const area = searchParams.get('area');
  const issue = searchParams.get('issue');
  const move = area && issue ? { route: `/${area}`, title: issue } : null;

  const load = useCallback(async (fresh = false) => {
    setState('loading');
    try {
      setCatalog(await fetchCatalog(kind, { fresh }));
      setState('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : null);
      setState(isNotAuditedYet(error) ? 'empty' : 'error');
    }
  }, [kind]);

  const loadMoves = useCallback(async () => {
    setMovesState('loading');
    try {
      setDashboard(await fetchDashboardData());
      setMovesState('ready');
    } catch {
      setMovesState('error');
    }
  }, []);

  useEffect(() => { void load(); void loadMoves(); }, [load, loadMoves]);

  // A move picked in the narrow-screen panel filters the table; the panel steps out of the way.
  useEffect(() => { setMovesOpen(false); setPage(0); }, [area, issue]);

  const selectMove = (next: PriorityIssue) => {
    const same = move && move.route === next.route && move.title === next.title;
    setSearchParams(same ? {} : { area: next.route.replace(/^\//, ''), issue: next.title });
  };
  const clearMove = () => setSearchParams({});

  // The items the table works on: every item, or only those the chosen move names.
  const base = useMemo(() => {
    const all = catalog?.items ?? [];
    return move ? itemsForMove(all, move) : all;
  }, [catalog, move?.route, move?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const result = { all: 0, critical: 0, warnings: 0, passing: 0 };
    for (const item of base) {
      result.all += 1;
      result[tabOf(item)] += 1;
    }
    return result;
  }, [base]);

  useEffect(() => {
    if (kind !== 'product' && kind !== 'collection') return;
    let cancelled = false;
    fetchOnboardingShared()
      .then((state) => {
        if (cancelled) return;
        setPriorityHandles(
          new Set(state.preferences.priorityResources.filter((entry) => entry.kind === kind).map((entry) => entry.handle)),
        );
      })
      // An aid: failing to read it leaves the list exactly as it was.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const isPriority = useCallback(
    (item: CatalogItem) => {
      const handle = handleOf(kind, item.url);
      return handle !== null && priorityHandles.has(handle);
    },
    [kind, priorityHandles],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = base.filter((item) =>
      (tab === 'all' || tabOf(item) === tab)
      && (!needle || (item.name ?? '').toLowerCase().includes(needle) || (item.url ?? '').toLowerCase().includes(needle)));
    const byName = (a: CatalogItem, b: CatalogItem) => (a.name ?? '').localeCompare(b.name ?? '');
    const byUpdated = (a: CatalogItem, b: CatalogItem) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0);
    return [...list].sort((a, b) =>
      sort === 'name' ? byName(a, b)
        : sort === 'best' ? b.passRate - a.passRate || byName(a, b)
          : sort === 'updated' ? byUpdated(a, b) || byName(a, b)
            : Number(isPriority(b)) - Number(isPriority(a)) || a.passRate - b.passRate || b.critical - a.critical || byName(a, b));
  }, [base, query, sort, tab, isPriority]);

  if (state === 'loading') {
    return (
      <AppPage heading={config.navLabel}>
      <div className="page-shell space-y-2.5 pt-3" aria-busy="true" aria-label={`Loading ${config.nouns}`}>
        {/* The page's chips; the title is in the page frame (AppPage). */}
        <div className="flex items-center justify-end gap-2">
          <div className="skeleton h-7 w-64 rounded-lg" />
        </div>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className={`${cardClass} overflow-hidden`}>
            <div className="border-b border-surface-200/70 px-3 py-2"><div className="skeleton h-7 w-96 max-w-full rounded-lg" /></div>
            <div className="divide-y divide-surface-200/60">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <div className="skeleton h-12 w-12 rounded-lg" />
                  <div className="skeleton h-3.5 w-56" />
                  <div className="skeleton ml-auto h-5 w-64 rounded-full" />
                </div>
              ))}
            </div>
          </div>
          <div className={`${cardClass} hidden space-y-2 p-3 xl:block`}>
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-14 w-full rounded-lg" />)}
          </div>
        </div>
      </div>
      </AppPage>
    );
  }

  if (state === 'empty') {
    return (
      <AppPage heading={config.navLabel}>
      <div className="mx-auto max-w-2xl py-10">
        <div className={`${cardClass} flex flex-col items-center p-6 text-center`}>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Radar size={18} /></span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">{config.emptyTitle}</h2>
          <RunAuditButton onComplete={() => { void load(true); void loadMoves(); }} />
        </div>
      </div>
      </AppPage>
    );
  }

  if (state === 'error' || !catalog) {
    return (
      <AppPage heading={config.navLabel}>
      <div className="mx-auto max-w-2xl py-10">
        <div className={`${cardClass} flex flex-col items-center p-6 text-center`}>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-critical-50 text-critical-600"><AlertCircle size={18} /></span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">{config.errorTitle}</h2>
          {errorMessage && <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-surface-500">{errorMessage}</p>}
          <Button variant="primary" onClick={() => void load(true)} className="mt-3">Retry</Button>
        </div>
      </div>
      </AppPage>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: config.allTab },
    { key: 'critical', label: 'Critical issues' },
    { key: 'warnings', label: 'Warnings' },
    { key: 'passing', label: 'Passing' },
  ];

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const from = currentPage * PAGE_SIZE;
  const pageRows = visible.slice(from, from + PAGE_SIZE);
  const unavailable = catalog.checksUnavailable.length;
  const issues = dashboard?.priorityIssues ?? [];
  const activeIssue = move ? issues.find((candidate) => candidate.route === move.route && candidate.title === move.title) ?? null : null;

  return (
    // The list's title and its Reload action are in the page frame (AppPage), drawn by the Shopify admin's
    // title bar. What is left is the content, on the admin's own background.
    <AppPage
      heading={config.navLabel}
      secondaryActions={[{ label: 'Reload', onClick: () => { void load(true); void loadMoves(); }, accessibilityLabel: `Reload ${config.nouns} from the latest audit` }]}
    >
    <div className="page-shell space-y-2.5 pt-3">
      <div className="flex lg:justify-end">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {catalog.lastAnalyzed && (
            <span className="meta-chip">
              <Clock3 size={12} className="text-surface-400" aria-hidden="true" />
              Analyzed <span className="font-medium text-surface-800">{formatLastUpdated(catalog.lastAnalyzed)}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => setAboutOpen((value) => !value)}
            aria-expanded={aboutOpen}
            className="meta-chip transition-colors hover:border-surface-300 hover:text-surface-900"
          >
            <Info size={12} className="text-info-600" aria-hidden="true" />
            {catalog.checksRead.length} checks
            {unavailable > 0 && <span className="font-semibold text-warning-700">· {unavailable} not included</span>}
            {aboutOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
          <Button variant="primary" onClick={() => setMovesOpen(true)} className="xl:hidden">
            
            Winning moves
          </Button>
        </div>
      </div>

      {aboutOpen && (
        <div className={`${cardClass} space-y-1 px-3 py-2 text-[11px] leading-[1.5] text-surface-600`}>
          <p><span className="font-semibold text-surface-900">Checks read:</span> {catalog.checksRead.map((check) => check.label).join(', ') || 'none'}.</p>
          {unavailable > 0 && (
            <p><span className="font-semibold text-warning-700">Not included this time:</span> {catalog.checksUnavailable.map((check) => `${check.label} (${check.reason.replace(/\.$/, '')})`).join('; ')}.</p>
          )}
        </div>
      )}

      {/* One view: the table and Winning moves share the height of the window and scroll inside it. */}
      <div className="grid gap-3 xl:h-[calc(100vh_-_9rem)] xl:min-h-[30rem] xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className={`${cardClass} flex min-h-0 flex-col overflow-hidden`} aria-label={config.navLabel}>
          <div className="flex flex-col gap-1.5 border-b border-surface-200/70 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="inline-flex max-w-full flex-wrap gap-0.5 self-start rounded-lg border border-surface-200/70 bg-surface-50 p-0.5" role="tablist" aria-label={`Filter ${config.nouns}`}>
              {tabs.map((option) => {
                const active = tab === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => { setTab(option.key); setPage(0); }}
                    // The same chip as the Winning moves filter beside it, so the two controls read as one family.
                    className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      active ? 'bg-surface-0 font-semibold text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)] ring-1 ring-surface-200' : 'text-surface-600 hover:text-surface-900'
                    }`}
                  >
                    {option.label}
                    <span className="ml-1 tabular-nums text-surface-400">({counts[option.key].toLocaleString()})</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1 lg:w-52 lg:flex-none">
                <SearchField
                  label={config.searchPlaceholder}
                  placeholder={config.searchPlaceholder}
                  value={query}
                  onChange={(value) => { setQuery(value); setPage(0); }}
                />
              </div>
              <SelectField
                label={`Sort ${config.nouns}`}
                labelHidden
                value={sort}
                options={SORTS}
                optionLabel={(option) => SORT_LABELS[option]}
                onChange={(value) => { setSort(value); setPage(0); }}
              />
            </div>
          </div>

          {move && (
            <div className="flex items-center gap-2 border-b border-info-100 bg-info-50 px-3 py-1.5 text-[12px] text-info-700">
              <Info size={14} className="flex-shrink-0 text-info-600" aria-hidden="true" />
              <p className="min-w-0 flex-1">
                <span className="font-semibold">Filtered</span> — {base.length.toLocaleString()} {base.length === 1 ? config.noun : config.nouns} · “{move.title}”
                {activeIssue && activeIssue.affectedCount > base.length && (
                  <span className="text-info-700"> ({activeIssue.affectedCount.toLocaleString()} store-wide)</span>
                )}
              </p>
              <Button variant="ghost" onClick={clearMove} accessibilityLabel="Clear the filter" icon="x" />
            </div>
          )}

          <div ref={scrollChaining} className={`min-h-0 flex-1 overflow-auto max-xl:max-h-[70vh] ${scrollbar}`}>
            <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1.25fr)_88px_96px_16px] gap-3 border-b border-surface-200/70 bg-surface-50 px-3 py-1.5 text-[11px] font-semibold text-surface-500 md:grid">
              <span>{config.column}</span>
              <span>Issues</span>
              <span className="text-right">Checks passed</span>
              <span className="text-right">Last updated</span>
              <span />
            </div>

            {visible.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12px] text-surface-500">
                {catalog.items.length === 0
                  ? `No ${config.nouns} in the latest audit.`
                  : move && base.length === 0
                    ? `No ${config.nouns} with this issue.`
                    : `No ${config.nouns} match this filter.`}
              </p>
            ) : (
              <ul className="divide-y divide-surface-200/60">
                {pageRows.map((item) => {
                  const name = item.name ?? `${config.column} ${item.id}`;
                  const updated = formatCatalogDate(item.updatedAt);
                  const detailLine = secondaryLine(kind, item);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`${config.listPath}/${item.id}`)}
                        title={item.url ? item.url.replace(/^https?:\/\/[^/]+/, '') : undefined}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1.25fr)_88px_96px_16px]"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Thumbnail src={item.imageSrc} name={name} size="md" kind={kind} />
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] font-semibold text-surface-900">{name}</span>
                              {isPriority(item) && (
                                <span
                                  title="You marked this as a priority in guided setup"
                                  className="flex-shrink-0 rounded-full bg-brand-50 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-brand-700 ring-1 ring-inset ring-brand-200/70"
                                >
                                  Priority
                                </span>
                              )}
                            </span>
                            {detailLine && <span className="block truncate text-[11px] text-surface-500">{detailLine}</span>}
                            <span className="mt-1 block md:hidden"><IssueBadges item={item} /></span>
                          </span>
                        </span>
                        <span className="hidden md:block"><IssueBadges item={item} /></span>
                        <span className="whitespace-nowrap text-right">
                          <span className="text-[13.5px] font-semibold tabular-nums text-surface-950">{item.passRate}%</span>
                          <span className="ml-1 text-[10.5px] tabular-nums text-surface-400">{item.passing}/{item.checks.length}</span>
                        </span>
                        <span className="hidden text-right text-[12px] tabular-nums text-surface-600 md:block">{updated ?? '—'}</span>
                        <ChevronRight size={14} className="hidden justify-self-end text-surface-400 md:block" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {visible.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-surface-200/70 px-3 py-1.5">
              <span className="text-[11px] tabular-nums text-surface-500">
                {(from + 1).toLocaleString()}–{Math.min(from + PAGE_SIZE, visible.length).toLocaleString()} of {visible.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="secondary" icon="chevron-left" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0} accessibilityLabel="Previous page" />
                <Button variant="secondary" icon="chevron-right" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} accessibilityLabel="Next page" />
              </div>
            </div>
          )}
        </section>

        <aside className={`${cardClass} hidden min-h-0 overflow-hidden xl:flex xl:flex-col`} aria-label="Winning moves">
          <MovesPanel
            kind={kind}
            state={movesState}
            issues={issues}
            score={dashboard?.overallScore ?? null}
            active={move}
            onSelect={selectMove}
            onRetry={() => void loadMoves()}
          />
        </aside>
      </div>

      <WinningMovesPanel open={movesOpen} onClose={closeMoves} />
    </div>
    </AppPage>
  );
}
