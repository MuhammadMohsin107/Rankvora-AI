import { useCallback, useEffect, useRef, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  FileSearch,
  Flag,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AppPage from '../polaris/AppPage';
import Badge, { type BadgeTone } from '../polaris/Badge';
import PillarKpiCard, { type KpiAccent } from './PillarKpiCard';
import PillarScoreRing from './PillarScoreRing';
import { PillarDashboardEmpty, PillarDashboardError, PillarDashboardSkeleton, SeedDataNotice } from './PillarDashboardState';
import { fetchPillarDashboard, isNoAuditError, type PillarDashboardData } from '../../data/pillars/pillarDashboard.repository';
import type { PillarKey } from '../../data/dashboard/dashboard.types';
import { useAuditCompletion, useAuditRun } from '../../data/useAuditRun';
import Button from '../../components/polaris/Button';

/**
 * ─── The pillar dashboard ────────────────────────────────────────────
 * ONE screen, rendered by all five pillars.
 *
 * /seo, /content, /speed, /cro and /ai-discovery were five separate 400-line files describing the
 * same page: the same header band, the same four KPIs, the same area grid, the same priority list.
 * They had drifted apart in every detail that was not load-bearing — 3 columns here and 4 there,
 * `rounded-xl` here and `rounded-2xl` there, a 104px score ring beside a 96px one — because a
 * change made on one page had no way to reach the other four.
 *
 * A pillar now supplies only what genuinely differs: its key, its name and its icon.
 * Everything structural lives here, so the five pages cannot disagree again.
 *
 * DATA IS UNCHANGED. This calls the same fetchPillarDashboard(pillar) each page already called,
 * renders only what the API returns, and keeps the three real states — a store with no audit gets
 * the empty state, never a fabricated score.
 */

export interface PillarDashboardProps {
  /** Which pillar to load. The only argument the data layer needs. */
  pillar: PillarKey;
  /** Display name, used in the title, the states and the health card. */
  title: string;
  /** Pillar mark shown beside the title. */
  icon: LucideIcon;
  /** Optional per-pillar KPI icons. The labels are fixed; only the glyphs vary. */
  kpiIcons?: Record<string, { icon: LucideIcon; accent: KpiAccent }>;
  /**
   * Panels a single pillar adds below the shared layout, for data that does not come from the
   * audit at all.
   *
   * AI Discovery uses it for live Google and GA4 reads. They are rendered in the EMPTY state as
   * well as the ready one, deliberately: AI referral traffic and Google index coverage do not
   * depend on an audit having run, and hiding them behind "no audit yet" would tell a merchant
   * there is nothing to see when there is.
   */
  extraPanels?: React.ReactNode;
}

type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';
type LoadState = 'loading' | 'ready' | 'empty' | 'error';

/** Shared thresholds: ≥85 Excellent · 70-84 Good · 50-69 Needs Work · <50 Critical. */
const statusLabel = (score: number) =>
  score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical';

// Full class strings so Tailwind sees them at build time.
// The score's verdict, as a Polaris badge. A label that is none of these (such as "Not measured") is neutral.
const labelBadgeTone: Record<string, BadgeTone> = {
  Excellent: 'success',
  Good: 'info',
  'Needs Work': 'warning',
  Critical: 'critical',
};

const statusBar: Record<string, string> = {
  Excellent: 'bg-success-500',
  Good: 'bg-info-500',
  'Needs Work': 'bg-warning-500',
  Critical: 'bg-critical-500',
};

const severityRank: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const severityBadge: Record<IssueSeverity, string> = {
  critical: 'bg-critical-50 text-critical-700 border border-critical-100',
  high: 'bg-warning-50 text-warning-700 border border-warning-100',
  medium: 'bg-surface-100 text-surface-600 border border-surface-200',
  low: 'bg-surface-100 text-surface-500 border border-surface-200',
};

const defaultKpiIcons: Record<string, { icon: LucideIcon; accent: KpiAccent }> = {
  'Open Issues': { icon: AlertTriangle, accent: 'warning' },
  'Critical Issues': { icon: AlertOctagon, accent: 'critical' },
  'High Priority': { icon: Flag, accent: 'warning' },
  'Areas Measured': { icon: FileSearch, accent: 'info' },
};

type IssueFilter = 'all' | IssueSeverity;

/**
 * Severity filter for this pillar's own Priority Issues — the same chip pattern the main
 * dashboard's issue list uses, scoped to one pillar's counts (`data.counts`) so it never needs to
 * recompute what the KPI cards above already show.
 */
function SeverityChips({ counts, total, active, onChange }: {
  counts: { critical: number; high: number; medium: number; low: number };
  total: number;
  active: IssueFilter;
  onChange: (next: IssueFilter) => void;
}) {
  const items: { key: IssueFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ];
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-surface-200/70 bg-surface-50 p-0.5" role="tablist" aria-label="Filter issues by severity">
      {items.map((item) => {
        const count = item.key === 'all' ? total : counts[item.key];
        const isActive = active === item.key;
        const isEmpty = count === 0;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              isActive
                ? 'bg-surface-0 text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)] ring-1 ring-surface-200'
                : isEmpty
                  ? 'text-surface-400 hover:text-surface-600'
                  : 'text-surface-600 hover:text-surface-900'
            }`}
          >
            {item.label}
            <span className={`tabular-nums ${isActive ? 'text-surface-500' : 'text-surface-400'}`}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One issue row. Used by Priority Issues and Quick Wins, which differ only in their leading mark. */
function IssueRow({ lead, title, detail, onReview }: { lead: React.ReactNode; title: string; detail: string; onReview: () => void }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 transition-colors hover:bg-surface-50">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-surface-900">{title}</p>
        <p className="text-[10.5px] text-surface-500">{detail}</p>
      </div>
      <Button variant="secondary" onClick={onReview} className="flex-shrink-0">
        Review
      </Button>
    </div>
  );
}

/**
 * Card shell for the four list panels, so their headers cannot drift apart.
 *
 * `headerRight` sits beside the title — used only by Priority Issues, for its severity filter.
 */
function ListCard({ title, headerRight, children, className = '', scroll = false }: { title: string; headerRight?: React.ReactNode; children: React.ReactNode; className?: string; scroll?: boolean }) {
  return (
    <div className={`flex flex-col overflow-hidden rounded-lg border border-surface-200 bg-surface-0 shadow-sm ${className}`}>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-surface-200 px-3 py-2">
        <h2 className="section-title">{title}</h2>
        {headerRight}
      </div>
      {/* `scroll`: the card is as tall as the room it is given and the rows scroll inside it, from
          their first row to their last — `min-h-0` is what lets a flex child shrink below its content
          — handing over to the page at either end (lib/scrollChaining.ts). On a narrow screen there
          is no row to size from, so the list is simply capped. */}
      <div
        ref={scroll ? scrollChaining : undefined}
        className={`divide-y divide-surface-100 ${scroll ? 'min-h-0 flex-1 overflow-y-auto max-lg:max-h-[26rem] [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

export default function PillarDashboard({
  pillar,
  title,
  icon: Icon,
  kpiIcons = defaultKpiIcons,
  extraPanels,
}: PillarDashboardProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<PillarDashboardData | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  // The KPI cards above double as filters for Priority Issues below, and a way to jump straight to
  // the area grid — both already on this page, so a click leads somewhere real rather than nowhere.
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all');
  const issuesRef = useRef<HTMLDivElement>(null);
  const areasRef = useRef<HTMLDivElement>(null);
  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const load = useCallback(async (isRefresh = false) => {
    // Only the first load blanks the page to a skeleton. Doing it after a refresh threw the
    // whole dashboard away and rebuilt it, which read as the page reloading rather than the
    // numbers updating.
    if (!isRefresh) setState('loading');
    try {
      setData(await fetchPillarDashboard(pillar));
      setState('ready');
    } catch (error) {
      // A store that has never been audited is a first-run state, not a failure — and it is the
      // reason this page must not render numbers of its own.
      setState(isNoAuditError(error) ? 'empty' : 'error');
    }
  }, [pillar]);

  // "Re-analyze" must re-ANALYSE the store, not just re-read the audit already stored. load()
  // refreshes this page's data once the new audit has actually finished.
  const auditRun = useAuditRun();
  const refresh = () => void auditRun.run();
  // Whichever page started an analysis, this one loads its results when it finishes.
  useAuditCompletion(() => load(true));

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setIssueFilter('all'); }, [pillar]);

  // Every state sits in the same page frame, so the title bar keeps this pillar's name while the data
  // loads, is missing, or fails to load. The Re-analyze action joins it only once there is a dashboard
  // to refresh: before that, the empty state says how to run the first audit.
  if (state === 'loading') return <AppPage heading={title}><PillarDashboardSkeleton title={title} /></AppPage>;
  // The extra panels survive both non-ready states: they read live APIs of their own, so an
  // unaudited — or failed — pillar says nothing about whether they have data. See extraPanels.
  if (state === 'empty') {
    return (
      <AppPage heading={title}>
        <PillarDashboardEmpty title={title} />
        {extraPanels ? <div className="page-shell section-stack pb-8">{extraPanels}</div> : null}
      </AppPage>
    );
  }
  if (state === 'error' || !data) {
    return (
      <AppPage heading={title}>
        <PillarDashboardError title={title} onRetry={() => load()} />
        {extraPanels ? <div className="page-shell section-stack pb-8">{extraPanels}</div> : null}
      </AppPage>
    );
  }

  const overallScore = data.overallScore;
  const overallStatus = overallScore === null ? 'Not measured' : statusLabel(overallScore);
  const sortedIssues = [...data.issues].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const measuredAreas = data.areas.filter((area) => area.score !== null);
  const attentionAreas = measuredAreas.slice().sort((a, b) => (a.score as number) - (b.score as number)).slice(0, 4);
  const kpis = [
    { label: 'Open Issues', value: String(data.issues.length) },
    { label: 'Critical Issues', value: String(data.counts.critical) },
    { label: 'High Priority', value: String(data.counts.high) },
    { label: 'Areas Measured', value: `${measuredAreas.length}/${data.areas.length}` },
  ];
  // What each KPI card leads to: the three issue counts filter-and-scroll to Priority Issues
  // below; Areas Measured scrolls to the area grid, which is what it is actually counting.
  const kpiActions: Record<string, () => void> = {
    'Open Issues': () => { setIssueFilter('all'); scrollTo(issuesRef); },
    'Critical Issues': () => { setIssueFilter('critical'); scrollTo(issuesRef); },
    'High Priority': () => { setIssueFilter('high'); scrollTo(issuesRef); },
    'Areas Measured': () => scrollTo(areasRef),
  };
  const filteredIssues = issueFilter === 'all' ? sortedIssues : sortedIssues.filter((issue) => issue.severity === issueFilter);

  return (
    // The pillar's name and its Re-analyze action are in the page frame (AppPage), drawn by the Shopify
    // admin's title bar. What is left is the content, on the admin's own background.
    <AppPage
      heading={title}
      primaryAction={{
        label: auditRun.running ? `Analyzing… ${auditRun.progress}%` : 'Re-analyze',
        onClick: refresh,
        loading: auditRun.running,
        disabled: auditRun.running,
        accessibilityLabel: `Re-analyze this store and refresh ${title}`,
      }}
    >
      <div className="page-shell section-stack">
        {/* ── Summary band ──────────────────────────────────────────
            One band. The pillar's mark, how many areas it covers and its score are the facts; the blurred accent
            glows that used to sit behind them were decoration measured in inches. The title and the
            action are in the page frame. The store name, its address and "Last analyzed" are gone from
            here — removed at the merchant's request. */}
        <div className="flex flex-col gap-2.5 rounded-lg border border-surface-200 bg-surface-0 p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-brand-600 text-white">
                <Icon size={14} strokeWidth={2.2} />
              </span>
              <span className="inline-flex items-center rounded border border-brand-100 bg-brand-50 px-1.5 py-px text-[10.5px] font-medium text-brand-700">
                {data.areas.length} areas monitored
              </span>
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-3 lg:border-l lg:border-surface-100 lg:pl-3">
            {overallScore === null ? (
              <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-[3px] border-dashed border-surface-200 text-center text-[10.5px] font-medium text-surface-400">
                Not<br />measured
              </div>
            ) : (
              <PillarScoreRing score={overallScore} gradientId={`${pillar}-score-ring-gradient`} />
            )}
            <div>
              <p className="eyebrow">{title} Health</p>
              <span className="mt-1 inline-flex"><Badge tone={labelBadgeTone[overallStatus] ?? 'neutral'}>{overallStatus}</Badge></span>
            </div>
          </div>
        </div>

        {/* The analysis running, finished or failed is shown by the banner above every page
            (components/audit/AnalysisBanner.tsx), with the way forward when it failed. */}

        {data.source === 'seed' && <SeedDataNotice />}

        {/* ── Summary metrics ───────────────────────────────────────
            Four KPIs in four columns. The old 5-column grid held four cards and one empty cell. */}
        <div className="grid-cards grid-cols-2 sm:grid-cols-4">
          {kpis.map((kpi) => {
            const meta = kpiIcons[kpi.label];
            return <PillarKpiCard key={kpi.label} label={kpi.label} value={kpi.value} icon={meta?.icon} accent={meta?.accent} onClick={kpiActions[kpi.label]} />;
          })}
        </div>

        {/* ── Areas ─────────────────────────────────────────────────
            Four across on a laptop, so even an 11-area pillar is three rows rather than six. */}
        <div ref={areasRef} className="scroll-mt-3">
          <div className="section-head">
            <h2 className="section-title">{title} Areas</h2>
            <span className="meta-text tabular-nums">{data.areas.length} sub-pillars</span>
          </div>

          <div className="grid-cards grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.areas.map((area) => {
              const measured = area.score !== null;
              const label = measured ? statusLabel(area.score as number) : 'Not measured';
              return (
                <button
                  key={area.id}
                  onClick={() => navigate(area.route)}
                  className="group relative flex flex-col overflow-hidden rounded-lg border border-surface-200 bg-surface-0 p-2.5 text-left shadow-sm transition-all duration-200 hover:border-brand-200 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <h3 className="min-w-0 text-[12.5px] font-semibold leading-snug text-surface-900 transition-colors group-hover:text-brand-700">
                      {area.label}
                    </h3>
                    <span className="flex-shrink-0"><Badge tone={labelBadgeTone[label] ?? 'neutral'}>{label}</Badge></span>
                  </div>

                  {measured ? (
                    <>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-[20px] font-semibold leading-none tracking-tight text-surface-900 tabular-nums">{area.score}</span>
                        <span className="text-[10.5px] font-medium text-surface-400">/100</span>
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-100">
                        <div className={`h-full rounded-full ${statusBar[label]}`} style={{ width: `${area.score}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="mt-1.5 text-[12px] text-surface-400">No audit data yet</p>
                  )}


                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-surface-100 pt-1.5 text-[10.5px]">
                    <span className="truncate text-surface-500">
                      {area.analyzedCount === null ? 'Not analyzed' : `${area.analyzedCount.toLocaleString()} analyzed`}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1 font-semibold text-surface-800">
                      {area.issueCount === null ? '—' : `${area.issueCount.toLocaleString()} issues`}
                      <ArrowRight size={11} className="text-surface-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-600" />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Priority issues + health summary ──────────────────────── */}
        {/* One height for the pair: the row is as tall as the health card needs, but never less
            than a screenful of issues, and the Priority Issues card fills it (absolute, like the
            dashboard's) so its list scrolls inside that height instead of stretching the page. */}
        <div className="grid gap-3 lg:grid-cols-3">
          <div ref={issuesRef} className="relative scroll-mt-3 lg:col-span-2 lg:min-h-[24rem]">
          <ListCard
            title="Priority Issues"
            headerRight={<SeverityChips counts={data.counts} total={data.issues.length} active={issueFilter} onChange={setIssueFilter} />}
            scroll
            className="lg:absolute lg:inset-0"
          >
            {filteredIssues.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12.5px] text-surface-500">
                {sortedIssues.length === 0
                  ? 'No open issues'
                  : `No ${issueFilter} issues`}
              </p>
            ) : (
              filteredIssues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  lead={
                    <span className={`w-[60px] flex-shrink-0 rounded px-1.5 py-px text-center text-[9.5px] font-bold uppercase tracking-wide ${severityBadge[issue.severity]}`}>
                      {issue.severity}
                    </span>
                  }
                  title={issue.title}
                  detail={`${issue.affectedCount.toLocaleString()} ${issue.affectedLabel} • ${issue.subPillarLabel}`}
                  onReview={() => navigate(issue.route)}
                />
              ))
            )}
          </ListCard>
          </div>

          <div className="rounded-lg border border-surface-200 bg-surface-0 p-3 shadow-sm">
            <h2 className="section-title">{title} Health</h2>
            <div className="mt-2 space-y-1.5">
              {([
                ['Critical Issues', data.counts.critical, 'bg-critical-500'],
                ['High Priority', data.counts.high, 'bg-warning-500'],
                ['Medium Priority', data.counts.medium, 'bg-surface-400'],
              ] as const).map(([label, count, dot]) => (
                <div key={label} className="flex items-center justify-between rounded-md bg-surface-50 px-2.5 py-1.5">
                  <span className="flex items-center gap-2 text-[12px] font-medium text-surface-900">
                    <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
                    {label}
                  </span>
                  <span className="text-[14px] font-semibold text-surface-900 tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* "Quick wins" are the highest-severity real findings — there is no separate
            recommendation engine, so this ranks what the audit actually found rather than
            inventing a second list beside it. */}
        <div className="grid gap-3 lg:grid-cols-2">
          <ListCard title="Quick Wins">
            {sortedIssues.slice(0, 4).map((issue, index) => (
              <IssueRow
                key={issue.id}
                lead={
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-surface-100 text-[10.5px] font-bold text-surface-700">
                    {index + 1}
                  </span>
                }
                title={issue.title}
                detail={`${issue.affectedCount.toLocaleString()} ${issue.affectedLabel} · ${issue.subPillarLabel}`}
                onReview={() => navigate(issue.route)}
              />
            ))}
          </ListCard>

          <ListCard title="Needs Attention">
            {attentionAreas.map((area) => (
              <div key={area.id} className="flex items-center gap-2 px-3 py-1.5">
                <ChevronRight size={13} className="flex-shrink-0 text-surface-300" />
                <p className="min-w-0 flex-1 truncate text-[12.5px] text-surface-800">{area.label}</p>
                <span className="flex-shrink-0 text-[11px] tabular-nums text-surface-400">{area.score}/100</span>
                <Button variant="secondary" onClick={() => navigate(area.route)} className="flex-shrink-0">
                  Review
                </Button>
              </div>
            ))}
          </ListCard>
        </div>

        {extraPanels}
      </div>
    </AppPage>
  );
}
