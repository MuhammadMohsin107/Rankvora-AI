import { useEffect, useState, useCallback, useRef } from 'react';
import { Clock, ExternalLink, Globe } from 'lucide-react';
import type { DashboardData } from '../data/dashboard/dashboard.types';
import { fetchDashboardData, formatLastUpdated } from '../data/dashboard/dashboard.repository';
import AppPage from '../components/polaris/AppPage';
import PillarOverview from '../components/dashboard/PillarOverview';
import PriorityIssues, { type IssuesFocusRequest } from '../components/dashboard/PriorityIssues';
import RecommendedActions from '../components/dashboard/RecommendedActions';
import ScoreTrend from '../components/dashboard/ScoreTrend';
import ScoreOverview from '../components/dashboard/ScoreOverview';
import SignalCards from '../components/dashboard/SignalCards';
import DashboardSkeleton from '../components/dashboard/DashboardSkeleton';
import DashboardError from '../components/dashboard/DashboardError';
import DashboardEmpty from '../components/dashboard/DashboardEmpty';
import SetupResumeCard from '../components/onboarding/SetupResumeCard';
import SetupStatusCard from '../components/onboarding/SetupStatusCard';
import { ApiError } from '../lib/api';
import { useAuditCompletion, useAuditRun } from '../data/useAuditRun';

type LoadState = 'loading' | 'success' | 'empty' | 'error';

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  // Set when the store's latest audit is of a different shop than the one connected now — the
  // server's own sentence, naming both shops.
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  // A hero figure (Open issues / Critical / Passed) was clicked: where it sends the page.
  const [issuesFocus, setIssuesFocus] = useState<IssuesFocusRequest | null>(null);
  const pillarOverviewRef = useRef<HTMLDivElement>(null);
  const selectMetric = (id: string) => {
    // "Passed" has no place in the open-issues list by definition — its breakdown lives in the
    // pillar cards below, which already show each pillar's own healthy count.
    if (id === 'passed') {
      pillarOverviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setIssuesFocus({ filter: id === 'critical' ? 'critical' : 'all', token: Date.now() });
  };

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      // A refresh keeps the current dashboard on screen and swaps the numbers when they arrive;
      // only the first load may blank the page out to a skeleton.
      if (!isRefresh) setState('loading');
      const result = await fetchDashboardData();
      setData(result);
      setStaleNotice(null);
      setState('success');
    } catch (err) {
      // A store that has never been audited is a first-run state, not a failure — the backend
      // says so explicitly with AUDITS_NOT_FOUND, so don't show it as a broken dashboard.
      // AUDIT_STALE_STORE is the same truth for a newly connected shop: the history on file
      // describes another store, so there is no audit of THIS one to show yet.
      const noAuditOfThisStore = err instanceof ApiError && (err.code === 'AUDITS_NOT_FOUND' || err.code === 'AUDIT_STALE_STORE');
      setStaleNotice(err instanceof ApiError && err.code === 'AUDIT_STALE_STORE' ? err.message : null);
      setState(noAuditOfThisStore ? 'empty' : 'error');
    }
  }, []);

  /**
   * Re-analyze RE-ANALYSES the store, then reloads from the audit that run produced.
   *
   * It used to call fetchDashboardData() alone: the same stored audit, re-read and re-rendered.
   * Every number came back identical and "Analyzed 1d ago" stayed 1d ago, which is exactly what
   * a button that does nothing looks like. The five pillar dashboards already ran a real audit
   * behind the same label — this is the same hook, so the dashboard cannot drift from them again.
   */
  const auditRun = useAuditRun();
  const refresh = () => void auditRun.run();
  // Whichever page started an analysis, this one loads its results when it finishes.
  useAuditCompletion(() => loadData(true));

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Every state sits in the same page frame, so the title bar keeps its "Dashboard" heading while the
  // data loads, is missing, or fails to load. The main action (Re-analyze) is added only once there is
  // a dashboard to refresh: before that, the empty state carries its own "Start first analysis".
  if (state === 'loading') {
    return <AppPage heading="Dashboard"><DashboardSkeleton /></AppPage>;
  }

  if (state === 'empty') {
    // A store with no audit yet is the likeliest place to find unfinished setup, so the resume
    // card sits above the empty state rather than only on a populated dashboard.
    return (
      <AppPage heading="Dashboard">
        <div className="page-shell space-y-3 pb-0">
          <SetupResumeCard />
          <SetupStatusCard />
        </div>
        <DashboardEmpty notice={staleNotice} />
      </AppPage>
    );
  }

  if (state === 'error' || !data) {
    return <AppPage heading="Dashboard"><DashboardError onRetry={() => loadData()} /></AppPage>;
  }

  const storeHost = data.storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const storeLink = /^https?:\/\//.test(data.storeUrl) ? data.storeUrl : null;
  const storeInitial = data.storeName.trim().charAt(0).toUpperCase();

  return (
    <AppPage
      heading="Dashboard"
      primaryAction={{
        label: auditRun.running ? `Analyzing… ${auditRun.progress}%` : 'Re-analyze',
        onClick: refresh,
        loading: auditRun.running,
        disabled: auditRun.running,
        accessibilityLabel: 'Re-analyze this store and refresh the dashboard',
      }}
    >
    <div className="page-shell space-y-3 pt-3">
      {/* Renders nothing once guided setup is finished — see SetupResumeCard. */}
      <SetupResumeCard />
      {/* The reverse: renders only AFTER setup is finished, with what is still to set up and when
          the next scan is. */}
      <SetupStatusCard />
      {/* The page's title and its main action are in the page frame (AppPage). What is left is the
          store's own facts, on ONE row with the page's purpose: every line above the data is a line of
          data pushed below the fold. */}
      <div className="flex flex-col gap-2 motion-safe:animate-fade-in lg:flex-row lg:items-center lg:justify-between">
        <p className="min-w-0 truncate text-[12px] text-surface-500">What is healthy, what changed, and what to fix next.</p>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {/* Store identity: the name and address the backend holds for this store. A store with
              neither yet (never connected) shows no chip rather than an invented label. */}
          {(data.storeName || storeHost) && (
            <div className="inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-lg border border-surface-200/80 bg-surface-0 pl-1 pr-2.5 shadow-[0_1px_2px_var(--c-shadow-sm)]">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-brand-700 text-[11px] font-semibold text-surface-0" aria-hidden="true">
                {storeInitial || <Globe size={12} />}
              </span>
              {data.storeName && <span className="truncate text-[12px] font-semibold text-surface-900">{data.storeName}</span>}
              {storeHost && (storeLink ? (
                <a
                  href={storeLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-0.5 font-mono text-[10.5px] text-surface-500 transition-colors hover:text-brand-700"
                >
                  <span className="truncate">{storeHost}</span>
                  <ExternalLink size={10} className="flex-shrink-0" aria-hidden="true" />
                </a>
              ) : (
                <span className="truncate font-mono text-[10.5px] text-surface-500">{storeHost}</span>
              ))}
            </div>
          )}
          {data.lastUpdated && (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-surface-200/80 bg-surface-0 px-2.5 text-[11.5px] text-surface-500 shadow-[0_1px_2px_var(--c-shadow-sm)]">
              <Clock size={12} className="text-surface-400" aria-hidden="true" />
              Analyzed <span className="font-medium text-surface-900">{formatLastUpdated(data.lastUpdated)}</span>
            </span>
          )}
        </div>
      </div>

      {/* The analysis running, finished or failed is shown by the banner above every page
          (components/audit/AnalysisBanner.tsx), with the way forward when it failed. */}

      {/* 12-column content grid */}
      <div className="grid grid-cols-12 gap-3 motion-safe:animate-slide-up">
        <div className="col-span-12 xl:col-span-8">
          <ScoreOverview data={data.overallScore} metrics={data.keyMetrics} trend={data.scoreTrend} pillars={data.pillars} onSelectMetric={selectMetric} />
        </div>
        <div className="col-span-12 xl:col-span-4">
          <ScoreTrend data={data.scoreTrend} />
        </div>

        <div ref={pillarOverviewRef} className="col-span-12 scroll-mt-3">
          <PillarOverview pillars={data.pillars} />
        </div>

        {/* What is happening, under how well the store is prepared: search clicks, mobile speed, AI
            mentions, drafts waiting. Read on their own, so a slow Google never delays the page. */}
        <div className="col-span-12">
          <SignalCards refreshKey={data.lastUpdated} />
        </div>

        {/* Equal-height pair. From xl up, Priority issues is taken OUT of the row's sizing
            (absolute, filling its cell), so the row is exactly as tall as Recommended actions and
            the issue list scrolls inside that height. The min-height keeps the list usable when
            there are only one or two actions to size the row from. */}
        <div className="relative col-span-12 xl:col-span-7 xl:min-h-[340px]">
          <div className="h-full xl:absolute xl:inset-0">
            <PriorityIssues issues={data.priorityIssues} focusRequest={issuesFocus} />
          </div>
        </div>
        <div className="col-span-12 xl:col-span-5">
          <RecommendedActions actions={data.recommendedActions} />
        </div>
      </div>
    </div>
    </AppPage>
  );
}
