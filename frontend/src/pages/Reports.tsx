import { useCallback, useEffect, useRef, useState } from 'react';
import { scrollChaining } from '../lib/scrollChaining';
import { useLocation, useSearchParams } from 'react-router-dom';
import { FileText, LineChart, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import {
  REPORT_COMPARISONS,
  REPORT_PERIODS,
  exportReportCsv,
  fetchReportDetail,
  fetchReports,
  type ReportComparison,
  type ReportOverview,
  type ReportPeriod,
  type ReportPillar,
  type ReportTrendPoint,
  type ReportsState,
} from '../data/reports.repository';
import type { AuditScoreRow } from '../data/api.types';
import { isMeasuredScore } from '../data/api.types';
import { pillarMeta, pillarOrder } from '../data/pillarMeta';
import type { PillarKey } from '../data/dashboard/dashboard.types';
import { useAuditRun } from '../data/useAuditRun';
import { ApiError } from '../lib/api';
import AppPage from '../components/polaris/AppPage';
import Banner from '../components/polaris/Banner';
import { Button, Drawer, MetricTile, SectionHeading } from '../components/workflows/WorkflowPrimitives';
import { SelectField } from '../components/polaris/fields';

/** Card shell shared by every block on this page — one definition, so padding stays uniform. */
const panel = 'rounded-lg border border-surface-200 bg-surface-0 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const longDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An unmeasured value is a dash, never a zero — see reports.repository.ts. */
const showScore = (value: number | null) => (value === null ? '—' : String(value));
const showDelta = (current: number | null, previous: number | null) =>
  current === null || previous === null ? null : current - previous;

const subPillarLabelFor = (pillar: string, subPillar: string) =>
  pillarMeta[pillar as PillarKey]?.subPillars.find((item) => item.id === subPillar)?.label ?? subPillar;

/**
 * The plot was 230px tall inside a 3-unit-padded card, which pushed the pillar comparison table
 * off the first screen on a laptop. 168px still resolves every point and label — the series has
 * one line and a handful of markers, so the extra 62px was empty plot area, not resolution.
 */
function TrendChart({ points: trendPoints, period }: { points: ReportTrendPoint[]; period: ReportPeriod }) {
  const width = 760;
  const height = 168;
  const padding = 18;
  const values = trendPoints.map((point) => point.score);
  const min = Math.min(...values) - 3;
  const max = Math.max(...values) + 3;
  const span = max - min || 1;
  const points = values
    .map((value, index) => `${padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1)},${height - padding - ((value - min) / span) * (height - padding * 2)}`)
    .join(' ');
  const first = trendPoints[0];
  const last = trendPoints[trendPoints.length - 1];

  return (
    <div className={`${panel} overflow-hidden p-2.5`}>
      {/* Eyebrow and heading share one baseline instead of stacking — two words that read as one
          label should not cost two lines at the top of every card. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <h3 className="text-[12.5px] font-bold text-surface-950">Score trend</h3>
        </div>
        <span className="text-[11px] text-surface-500">Last {period}</span>
      </div>

      {/* An empty window is a real answer, not a broken chart: the store has audits, just none
          inside the selected period. Plotting a flat line or a zero would say otherwise. */}
      {trendPoints.length === 0 ? (
        <p className="flex h-[168px] items-center justify-center text-center text-[11.5px] text-surface-500">
          No audits in the last {period}.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mt-1.5 h-[168px] w-full"
          role="img"
          aria-label={`Overall score trend from ${first?.score ?? 0} to ${last?.score ?? 0}`}
        >
          <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} className="stroke-surface-200" />
          <line x1={padding} x2={width - padding} y1={padding} y2={padding} className="stroke-surface-100" />
          <polyline fill="none" strokeWidth="2.5" className="stroke-chart-line" strokeLinecap="round" strokeLinejoin="round" points={points} />
          {values.map((trendValue, index) => {
            const [x, y] = points.split(' ')[index].split(',');
            return <circle key={`${trendValue}-${x}-${y}`} cx={x} cy={y} r="3.5" strokeWidth="2" className="fill-surface-0 stroke-chart-line" />;
          })}
          {first && <text x={padding} y={height - 4} fontSize="11" className="fill-surface-500">{shortDate(first.date)}</text>}
          {last && trendPoints.length > 1 && <text x={width - 54} y={height - 4} fontSize="11" className="fill-surface-500">{shortDate(last.date)}</text>}
          <text x={padding} y={padding - 5} fontSize="11" className="fill-surface-500">{Math.max(...values)}</text>
        </svg>
      )}
    </div>
  );
}

/** Full-page states: no store connected, or connected but never analyzed. */
function EmptyState({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className={`${panel} px-4 py-8 text-center`}>
      <FileText size={20} className="mx-auto text-surface-300" aria-hidden="true" />
      <h2 className="mt-2 text-[13px] font-bold text-surface-900">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-[1.45] text-surface-500">{body}</p>
      <div className="mt-2.5 flex justify-center">{action}</div>
    </div>
  );
}

function Notice({ tone, children, onDismiss }: { tone: 'error' | 'info'; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <Banner tone={tone === 'error' ? 'critical' : 'info'} onDismiss={onDismiss}>
      <s-text>{children}</s-text>
    </Banner>
  );
}

/** One historical report, read from that audit's own rows. */
function ReportDetail({ auditId, onExport, exporting }: { auditId: number; onExport: () => void; exporting: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scores, setScores] = useState<AuditScoreRow[]>([]);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [overall, setOverall] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setState('loading');
    fetchReportDetail(auditId)
      .then((detail) => {
        if (!active) return;
        setScores(detail.scores);
        setRunAt(detail.audit.runAt);
        setOverall(detail.audit.metadata?.overallAvailable === false ? null : detail.audit.overallScore);
        setState('ready');
      })
      .catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [auditId]);

  if (state === 'loading') return <p className="py-4 text-[12px] text-surface-500">Loading report…</p>;
  if (state === 'error') return <p className="py-4 text-[12px] text-critical-600">Report could not be loaded.</p>;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-50 px-2.5 py-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Report date</p>
          <p className="mt-0.5 text-[12px] font-semibold text-surface-900">{runAt ? longDate(runAt) : '—'}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Overall</p>
          <p className="mt-0.5 text-[17px] font-bold leading-none tabular-nums text-surface-950">{showScore(overall)}</p>
        </div>
      </div>

      {pillarOrder.map((key) => {
        const meta = pillarMeta[key];
        const pillarScore = scores.find((score) => score.subPillar === null && score.pillar === key);
        const subScores = scores
          .filter((score) => score.pillar === key && score.subPillar !== null)
          .sort((a, b) => (a.subPillar ?? '').localeCompare(b.subPillar ?? ''));
        const measured = pillarScore ? isMeasuredScore(pillarScore) : false;

        return (
          <div key={key} className="rounded-md border border-surface-200">
            <div className="flex items-center justify-between gap-2 border-b border-surface-100 px-2.5 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                <span className="truncate text-[12px] font-bold text-surface-900">{meta.label}</span>
              </span>
              <span className="flex-shrink-0 text-[12px] font-bold tabular-nums text-surface-900">
                {measured && pillarScore ? `${pillarScore.score}/100` : 'Not measured'}
              </span>
            </div>
            {subScores.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[11px] text-surface-500">Nothing measured.</p>
            ) : (
              <ul className="divide-y divide-surface-100">
                {subScores.map((score) => (
                  <li key={score.id} className="flex items-center justify-between gap-2 px-2.5 py-1">
                    <span className="min-w-0 truncate text-[11.5px] text-surface-700">
                      {subPillarLabelFor(score.pillar, score.subPillar ?? '')}
                    </span>
                    <span className="flex-shrink-0 text-[11.5px] font-semibold tabular-nums text-surface-800">
                      {isMeasuredScore(score) ? score.score : <span className="font-normal text-surface-400">Not measured</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <Button variant="secondary" onClick={onExport} disabled={exporting}>
        {exporting ? 'Preparing…' : 'Export this report'}
      </Button>
    </div>
  );
}

/** `?audit=214`, when it is a plausible row id. Anything else opens no drawer at all. */
function auditIdFromUrl(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<ReportsState | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>('30D');
  const [comparison, setComparison] = useState<ReportComparison>('Previous audit');
  const [pillarFilter, setPillarFilter] = useState('All pillars');
  /**
   * Opened straight from the URL, which is what makes "Store analysis finished" able to name the
   * audit it is about — /reports?audit=214 shows that run rather than the history list with it
   * somewhere in it. Applied on each arrival (below), not continuously: after that the drawer is
   * the page's own state, and a URL that kept reopening it could not be closed.
   */
  const [openReportId, setOpenReportId] = useState<number | null>(() => auditIdFromUrl(searchParams.get('audit')));

  /**
   * A notification clicked while ALREADY on Reports opens its audit too.
   *
   * The id used to be read only when the page mounted, and React Router keeps the page mounted
   * across a change of query string — so "Store analysis finished", clicked from the bell while
   * this page was open, changed the address and opened nothing. Every navigation gets a new
   * `location.key`; that is what this watches. Closing the drawer also navigates (it drops
   * `?audit=`), which lands here with no id and correctly does nothing.
   */
  const location = useLocation();
  const arrivalKey = useRef(location.key);
  useEffect(() => {
    if (arrivalKey.current === location.key) return; // the initial state already read this link
    arrivalKey.current = location.key;
    const linkedAudit = auditIdFromUrl(searchParams.get('audit'));
    if (linkedAudit !== null) setOpenReportId(linkedAudit);
  }, [location.key, searchParams]);
  const [exportingId, setExportingId] = useState<number | 'current' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const auditRun = useAuditRun();

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      setState(await fetchReports(period, comparison));
      setLoadState('success');
    } catch (error) {
      console.error('Failed to load reports', error);
      setLoadError(error instanceof ApiError ? error.message : 'Reports could not be loaded.');
      setLoadState('error');
    }
  }, [period, comparison]);

  useEffect(() => { load(); }, [load]);

  const overview: ReportOverview | null = state?.overview ?? null;

  /**
   * "Create report" runs a real audit.
   *
   * It previously had no onClick at all, which is why nothing happened. In Rankvora AI a report IS an
   * audit — the page has no separate report record to create — so this queues a run through the
   * same endpoint and job polling the pillar pages use, then reloads from the new audit.
   */
  const createReport = () => {
    setActionError(null);
    setActionNotice(null);
    auditRun.run(async () => {
      setActionNotice('New report created.');
      await load();
    });
  };

  const runExport = async (auditId?: number) => {
    setActionError(null);
    setActionNotice(null);
    setExportingId(auditId ?? 'current');
    try {
      const filename = await exportReportCsv(auditId);
      setActionNotice(`Downloaded ${filename}.`);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'The export could not be generated.');
    } finally {
      setExportingId(null);
    }
  };

  // Every state sits in the same page frame, so the title bar keeps its "Reports" heading while the
  // report loads, fails to load, or does not exist yet. "Create report" joins it once there is a report.
  if (loadState === 'loading') {
    return (
      <AppPage heading="Reports">
      <div className="page-shell text-[12.5px] text-surface-500">
        <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading reports…</span>
      </div>
      </AppPage>
    );
  }

  if (loadState === 'error') {
    return (
      <AppPage heading="Reports">
      <div className="page-shell section-stack">
        <Notice tone="error">{loadError}</Notice>
        {/* Primary, like every other retry in the app — it is the only action on this screen. */}
        <div><Button onClick={load}>Try again</Button></div>
      </div>
      </AppPage>
    );
  }

  // ── No connected store ───────────────────────────────────────────────
  // Reports for a store that is no longer connected are not shown, even though the audits are
  // kept: what is on screen must describe the store this workspace is actually reading.
  if (!state?.connected) {
    return (
      <AppPage heading="Reports">
      <div className="page-shell section-stack">
        <EmptyState
          title="No store connected"
          body="Connect your Shopify store to create reports."
          action={<Button variant="primary" to="/integrations">Connect a store</Button>}
        />
      </div>
      </AppPage>
    );
  }

  // ── Connected, never analyzed ────────────────────────────────────────
  if (!overview) {
    return (
      <AppPage heading="Reports">
      <div className="page-shell section-stack">
        <EmptyState
          title="No reports yet"
          body="Run an audit to create your first report."
          action={(
            <Button loading={auditRun.running} onClick={createReport} disabled={auditRun.running}>
              {auditRun.running ? `Running audit… ${auditRun.progress}%` : 'Create report'}
            </Button>
          )}
        />
      </div>
      </AppPage>
    );
  }

  const { currentScore, previousScore, trend, pillars } = overview;
  const visiblePillars = pillars.filter((pillar) => pillarFilter === 'All pillars' || pillar.label === pillarFilter);
  const measuredPillars = pillars.filter((pillar) => pillar.current !== null && pillar.previous !== null);
  const rankedByDelta = [...measuredPillars].sort((a, b) => (b.current! - b.previous!) - (a.current! - a.previous!));
  const topImprovement: ReportPillar | undefined = rankedByDelta[0];
  const widestGap: ReportPillar | undefined = [...pillars]
    .filter((pillar) => pillar.current !== null)
    .sort((a, b) => a.current! - b.current!)[0];
  const overallDelta = showDelta(currentScore, previousScore);

  return (
    // The title and "Create report" are in the page frame (AppPage), drawn by the Shopify admin's title
    // bar. What is left is the content, on the admin's own background.
    <AppPage
      heading="Reports"
      primaryAction={{
        label: auditRun.running ? `Running… ${auditRun.progress}%` : 'Create report',
        onClick: createReport,
        loading: auditRun.running,
        disabled: auditRun.running,
      }}
    >
    <div className="page-shell section-stack">
      <p className="page-subtitle">{`Latest report ${longDate(overview.reportDate)}${overview.isFixture ? ' · demo fixture, not a live audit' : ''}.`}</p>

      {actionError && <Notice tone="error" onDismiss={() => setActionError(null)}>{actionError}</Notice>}
      {actionNotice && <Notice tone="info" onDismiss={() => setActionNotice(null)}>{actionNotice}</Notice>}
      {overview.isFixture && (
        <Notice tone="info">
          Demo data, not a live audit of your store.
        </Notice>
      )}

      {/* ── Filters ─────────────────────────────────────────────────────
          Both controls now change the query. The period filters the trend series and the
          "Start of period" baseline; the comparison picks which audit the current one is measured
          against. Previously neither did anything — the period was never sent to the API and the
          comparison only relabelled a sentence. */}
      <section className={`${panel} flex flex-col gap-2 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Period</span>
          {REPORT_PERIODS.map((item) => (
            <button
              key={item}
              onClick={() => setPeriod(item)}
              aria-pressed={period === item}
              className={`rounded-md px-2 py-1 text-[11px] font-bold transition ${period === item ? 'bg-surface-950 text-surface-0' : 'text-surface-600 hover:bg-surface-100'}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <SelectField label="Filter by pillar" labelHidden value={pillarFilter} options={['All pillars', ...pillars.map((pillar) => pillar.label)]} onChange={setPillarFilter} />
          <SelectField label="Compare against" labelHidden value={comparison} options={REPORT_COMPARISONS} onChange={setComparison} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Report summary">
        <MetricTile label="Overall score" value={showScore(currentScore)} detail="out of 100" tone="success" />
        <MetricTile
          label="Change"
          value={overallDelta === null ? '—' : `${overallDelta >= 0 ? '+' : ''}${overallDelta}`}
          // Named, not implied: a dash here means there is no baseline audit to compare against,
          // which is different from "no change".
          detail={overview.baselineDate ? `vs ${shortDate(overview.baselineDate)}` : 'No baseline audit'}
          tone={overallDelta === null ? 'neutral' : overallDelta >= 0 ? 'success' : 'critical'}
        />
        <MetricTile label="Issues resolved" value={overview.issuesResolved} tone="info" />
        <MetricTile label="Critical issues" value={overview.criticalIssues} tone="critical" />
        <MetricTile label="Findings tracked" value={overview.findingsTracked} />
      </section>

      {/* Side by side from `lg`, not `xl`: at 1024px there is room for both, and stacking them
          cost a full chart's height on every laptop. */}
      <section className="grid gap-2.5 lg:grid-cols-[1.6fr_1fr]">
        <TrendChart points={trend} period={period} />

        <div className={`${panel} p-2.5`}>
          <SectionHeading title="What changed" />
          <div className="mt-2 space-y-2">
            {topImprovement && (
              <div className="flex gap-2.5">
                <div className="h-fit rounded-md bg-success-50 p-1.5 text-success-700"><TrendingUp size={14} /></div>
                <p className="min-w-0 self-center text-[12px] font-bold leading-[1.35] text-surface-900">
                  {topImprovement.label} changed by {topImprovement.current! - topImprovement.previous! >= 0 ? '+' : ''}{topImprovement.current! - topImprovement.previous!} points
                </p>
              </div>
            )}
            {widestGap && (
              <div className="flex gap-2.5">
                <div className="h-fit rounded-md bg-warning-50 p-1.5 text-warning-700"><TrendingDown size={14} /></div>
                <p className="min-w-0 self-center text-[12px] font-bold leading-[1.35] text-surface-900">{widestGap.label} is lowest at {widestGap.current}/100</p>
              </div>
            )}
            {!topImprovement && (
              <p className="text-[11.5px] leading-[1.4] text-surface-500">
                Nothing to compare yet.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── Pillar comparison ───────────────────────────────────────── */}
      <section className="space-y-2">
        {/* No Export button here. The page had two identical "Export CSV" actions — one in the
            page header, one in the card below — and a third would repeat the mistake. Exporting
            lives in one place: the "Export as CSV" card. The drawer's export is a different
            action (one named historical report), not a duplicate of this one. */}
        <SectionHeading
          title="Pillar performance"
          description={overview.baselineDate ? `vs ${longDate(overview.baselineDate)}` : undefined}
        />
        <div className={`${panel} overflow-hidden`}>
          <div className="hidden grid-cols-[1.4fr_0.7fr_0.8fr_0.7fr_1.5fr_0.8fr] gap-2.5 border-b border-surface-200 bg-surface-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500 sm:grid">
            <span>Pillar</span><span>Current</span><span>Previous</span><span>Change</span><span>Progress</span><span>Status</span>
          </div>
          <div className="divide-y divide-surface-100">
            {visiblePillars.map((pillar) => {
              const delta = showDelta(pillar.current, pillar.previous);
              return (
                /* Below `sm` the column header is hidden, so the six cells would stack as bare
                   numbers — "78", "75", "+3" with nothing naming them. On small screens the
                   numbers carry inline labels instead; from `sm` up they line up under the real
                   header. */
                <div key={pillar.key} className="grid gap-1.5 px-3 py-1.5 transition hover:bg-surface-50 sm:grid-cols-[1.4fr_0.7fr_0.8fr_0.7fr_1.5fr_0.8fr] sm:items-center sm:gap-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: pillar.color }} />
                    <span className="truncate text-[12px] font-bold text-surface-900">{pillar.label}</span>
                  </div>
                  <div className="text-[12px] font-bold text-surface-900 tabular-nums">
                    <span className="mr-1 font-medium text-surface-400 sm:hidden">Current</span>{showScore(pillar.current)}
                  </div>
                  <div className="text-[12px] text-surface-500 tabular-nums">
                    <span className="mr-1 font-medium text-surface-400 sm:hidden">Previous</span>{showScore(pillar.previous)}
                  </div>
                  <div className={`text-[12px] font-bold tabular-nums ${delta === null ? 'text-surface-400' : delta >= 0 ? 'text-success-700' : 'text-critical-700'}`}>
                    <span className="mr-1 font-medium text-surface-400 sm:hidden">Change</span>{delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta}`}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-100">
                    {/* An unmeasured pillar gets an empty track. A zero-width bar would still
                        read as a measured zero. */}
                    {pillar.current !== null && (
                      <div className="h-full rounded-full" style={{ width: `${pillar.current}%`, backgroundColor: pillar.color }} />
                    )}
                  </div>
                  <div>
                    {pillar.current === null ? (
                      <span className="inline-flex items-center rounded border border-surface-200 bg-surface-50 px-1.5 py-0.5 text-[10.5px] font-bold text-surface-500">Not measured</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-bold" style={{ color: pillar.color, borderColor: pillar.color, backgroundColor: pillar.tint }}>
                        <span className="h-1 w-1 rounded-full" style={{ backgroundColor: pillar.color }} />{pillar.status}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── History and export ──────────────────────────────────────── */}
      <section className="grid gap-2.5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className={`${panel} p-2.5`}>
          <SectionHeading title="Previous reports" />
          {/* Three fabricated titles with fabricated dates used to live here. These are the
              store's real audit runs; each one opens and exports the audit it names. */}
          {/* The history grows with every analysis, so it scrolls inside its card — the latest three
              runs show at once — and hands over to the page at either end. */}
          <div ref={scrollChaining} className="mt-2 max-h-[11rem] divide-y divide-surface-100 overflow-y-auto pr-1 [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]">
            {overview.history.map((report) => (
              <div key={report.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="rounded-md bg-surface-100 p-1.5 text-surface-600"><FileText size={14} /></div>
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-bold text-surface-900">
                      {longDate(report.runAt)}
                      {report.isLatest && <span className="ml-1.5 rounded bg-brand-50 px-1 py-px text-[10px] font-bold text-brand-700">Latest</span>}
                      {report.isFixture && <span className="ml-1.5 rounded bg-warning-50 px-1 py-px text-[10px] font-bold text-warning-700">Demo data</span>}
                    </p>
                    <p className="text-[11px] text-surface-500">
                      Overall {showScore(report.overallScore)}{report.overallScore === null && ' · nothing measured'}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" onClick={() => setOpenReportId(report.id)}>View</Button>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-brand-100 bg-brand-50 p-2.5">
          <div className="flex items-start gap-2.5">
            <LineChart size={16} className="mt-0.5 flex-shrink-0 text-brand-700" />
            <h3 className="min-w-0 text-[12.5px] font-bold text-brand-950">Export as CSV</h3>
          </div>
          <div className="mt-2">
            <Button variant="primary" onClick={() => runExport()} disabled={exportingId !== null}>
              {exportingId === 'current' ? 'Preparing…' : 'Export data'}
            </Button>
          </div>
        </div>
      </section>

      <Drawer
        open={openReportId !== null}
        title={openReportId !== null ? longDate(overview.history.find((item) => item.id === openReportId)?.runAt ?? overview.reportDate) : ''}
        // Closing drops `?audit=` as well, so a reload — or the back button — does not put the
        // drawer straight back. `replace`, because opening and closing a panel is not a place a
        // merchant should have to press Back through.
        onClose={() => {
          setOpenReportId(null);
          if (searchParams.has('audit')) {
            const next = new URLSearchParams(searchParams);
            next.delete('audit');
            setSearchParams(next, { replace: true });
          }
        }}
      >
        {openReportId !== null && (
          <ReportDetail
            auditId={openReportId}
            exporting={exportingId === openReportId}
            onExport={() => runExport(openReportId)}
          />
        )}
      </Drawer>
    </div>
    </AppPage>
  );
}
