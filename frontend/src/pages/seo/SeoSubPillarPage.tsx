import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Clock3, Radar } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  type EvidenceRow,
  type RowStatus,
  type SubPillarAnalysis,
  type SubPillarFinding,
} from '../../data/seo/subpillar.model';
import { fetchSubPillarAnalysis, isNotAuditedYet } from '../../data/seo/subpillar.repository';
import AppPage from '../../components/polaris/AppPage';
import ScoreCard from '../../components/seo/subpillar/ScoreCard';
import HealthCard from '../../components/seo/subpillar/HealthCard';
import FindingsList from '../../components/seo/subpillar/FindingsList';
import EvidenceTable from '../../components/seo/subpillar/EvidenceTable';
import InvestigationDrawer from '../../components/seo/subpillar/InvestigationDrawer';
import SubPillarSkeleton from '../../components/seo/subpillar/SubPillarSkeleton';
import { card, eyebrow } from '../../components/seo/subpillar/tone';
import PageSettingsPanel from '../../components/settings/PageSettingsPanel';
import RunAuditButton from '../../components/audit/RunAuditButton';
import { isSubPillarImplemented } from '../../data/audits.capabilities';
import {
  getDefaultSubPillarSettings,
  getSubPillarSettingsDefinition,
  hasSubPillarSettings,
  type PageSettingValue,
} from '../../data/pageSettings.registry';
import { useAuditCompletion, useAuditRun } from '../../data/useAuditRun';
import { fetchSubPillarSettings, saveSubPillarSettings } from '../../data/pageSettings.repository';
import GrantShopifyAccess from '../../components/audit/GrantShopifyAccess';
import { ApiError } from '../../lib/api';
import Button from '../../components/polaris/Button';

type LoadState = 'loading' | 'success' | 'empty' | 'error';

interface Props {
  /** The sub-pillar's own analysis. Layout is shared; data is not. */
  analysis: SubPillarAnalysis;
  /**
   * A configuration surface belonging to this sub-pillar alone, rendered under the header and
   * above the score.
   *
   * A slot rather than a branch: Image Alt Text has a template builder and the other seven
   * sub-pillars do not, and putting `slug === 'image-alt-text'` inside this shared template would
   * make every future exception another condition in a file that is supposed to be identical for
   * all of them. The route decides; the template just renders what it is given.
   */
  configurator?: React.ReactNode;
}

/**
 * The approved SEO sub-pillar template (established on Title Tags).
 * Every SEO sub-pillar renders through this shell and supplies its own
 * score, findings, evidence columns and terminology.
 */
export default function SeoSubPillarPage({ analysis, configurator }: Props) {
  const [data, setData] = useState<SubPillarAnalysis | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // What the server said when loading failed, or why there is no audit for this store. Shown as
  // is: "could not be retrieved" for every cause hid the one sentence that says what to do.
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  // The finding under investigation, plus the row it was opened from. `row` is null when the user
  // came from the findings list, where they picked an issue rather than a specific item.
  const [investigation, setInvestigation] = useState<{ finding: SubPillarFinding; rows: EvidenceRow[] } | null>(null);
  const [statusFilter, setStatusFilter] = useState<RowStatus | 'All'>('All');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Values saved to the store from the investigation drawer, shown in the table until the next
  // analysis replaces its rows.
  const [drawerSaves, setDrawerSaves] = useState<Array<{ id: string; value: string }>>([]);
  useEffect(() => { setDrawerSaves([]); }, [data]);
  // null = not yet known / lookup failed. Treated as "assume measurable" so a capability outage
  // never hides a Run Audit button that would actually have worked.
  const [implemented, setImplemented] = useState<boolean | null>(null);
  const [pageSettings, setPageSettings] = useState<Record<string, PageSettingValue>>(() => getDefaultSubPillarSettings(analysis.slug));
  const evidenceRef = useRef<HTMLDivElement>(null);
  const settingsDefinition = getSubPillarSettingsDefinition(analysis.slug);
  // A page with nothing to configure shows no Settings button — never another page's settings.
  const settingsAvailable = hasSubPillarSettings(analysis.slug);

  useEffect(() => {
    let active = true;
    setPageSettings(getDefaultSubPillarSettings(analysis.slug));
    setSettingsOpen(false);
    isSubPillarImplemented('seo', analysis.slug)
      .then((value) => { if (active) setImplemented(value); })
      .catch(() => { if (active) setImplemented(null); });
    if (hasSubPillarSettings(analysis.slug)) {
      fetchSubPillarSettings(analysis.slug)
        .then((values) => { if (active) setPageSettings(values); })
        .catch((error) => console.error('Failed to load page settings', error));
    }
    return () => { active = false; };
  }, [analysis.slug]);

  const load = useCallback(
    async (isRefresh = false) => {
      try {
        if (isRefresh) setIsRefreshing(true);
        else setState('loading');
        const result = await fetchSubPillarAnalysis(analysis);
        setData(result);
        setLoadMessage(null);
        setState('success');
      } catch (error) {
        // A store with no audit yet is a first-run state, not a failure. Without this the page
        // shows "Unable to load", implying something broke when nothing has been measured.
        const notAudited = isNotAuditedYet(error);
        // The stale-shop case explains itself (which shop the old audit was of); a plain "no audit
        // yet" needs no extra sentence. A real failure carries the server's message.
        setLoadMessage(
          error instanceof ApiError && (!notAudited || error.code === 'AUDIT_STALE_STORE') ? error.message : null,
        );
        // Drop results already on screen: after a failed reload they would describe a state the
        // server no longer vouches for.
        setData(null);
        setState(notAudited ? 'empty' : 'error');
      } finally {
        setIsRefreshing(false);
      }
    },
    [analysis],
  );

  // "Re-analyze" must re-ANALYSE the store — run a real audit and wait for it — not re-read the
  // audit already stored, which rendered the same numbers and looked like it had done something.
  // Same hook the pillar dashboards' Refresh uses; load() picks up the new audit once it lands.
  const auditRun = useAuditRun();
  const reanalyze = () => void auditRun.run();
  // Whichever page started an analysis, this one loads its results when it finishes.
  useAuditCompletion(() => load(true));

  // Reset view state when navigating between sub-pillars.
  useEffect(() => {
    setInvestigation(null);
    setStatusFilter('All');
    load();
  }, [load]);

  /**
   * Filters the evidence table to one status and scrolls to it.
   *
   * The status is applied ONLY if a row actually carries it. A finding's `issueType` and the
   * statuses its evidence rows use are set independently by each check, and where they disagree
   * the table filtered down to nothing and rendered "Nothing matches these filters" — reached by
   * pressing a control whose whole purpose is to show evidence. Falling back to 'All' shows the
   * rows that do exist. Same guard as NonSeoSubPillarPage; both templates share these components.
   */
  const focusEvidence = (status: RowStatus | 'All') => {
    const applicable = status === 'All' || (data?.evidence.rows ?? []).some((row) => row.status === status);
    setStatusFilter(applicable ? status : 'All');
    evidenceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const updatePageSetting = (key: string, value: PageSettingValue) => {
    setPageSettings((current) => ({ ...current, [key]: value }));
  };

  const savePageSettings = () => {
    saveSubPillarSettings(analysis.slug, pageSettings)
      .catch((error) => console.error('Failed to save page settings', error));
    setSettingsOpen(false);
  };

  // Every state sits in the same page frame, so the title bar keeps this area's name while its data
  // loads, is missing, or fails to load. Re-analyze (and Settings) join it only on the page that has
  // results to refresh; the other states carry their own "Run the audit" or "Retry".
  if (state === 'loading') return <AppPage heading={analysis.title}><SubPillarSkeleton /></AppPage>;

  // The check ran but could not measure anything (e.g. a store with no blog articles). The score
  // it carries is a placeholder zero, so this renders the reason instead of a fabricated result.
  // Distinct from 'empty', which means no audit has been run at all.
  if (data && data.status === 'unavailable') {
    return (
      <AppPage heading={analysis.title}>
      <div className="mx-auto max-w-2xl py-10">
        <div className={`${card} flex flex-col items-center p-6 text-center`}>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-100 text-surface-500">
            <Radar size={18} />
          </span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">{data.title} — not measured</h2>
          <p className="mt-1 max-w-md text-[12.5px] leading-[1.5] text-surface-500">
            {data.unavailableReason ?? 'Rankvora AI could not measure this check for your store.'}
          </p>
          <p className="mt-2 text-[11px] text-surface-400">Last audit {data.lastAnalyzed}</p>
          {/* A missing permission is fixed in Shopify, through the same approval screen Connect
              uses — then the audit has to run again to read what the permission unlocks. */}
          {data.requiredScope && <GrantShopifyAccess scope={data.requiredScope} />}
          <RunAuditButton label="Run the audit again" />
        </div>
      </div>
      </AppPage>
    );
  }

  if (state === 'empty') {
    return (
      <AppPage heading={analysis.title}>
      <div className="mx-auto max-w-2xl py-10">
        <div className={`${card} flex flex-col items-center p-6 text-center`}>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Radar size={18} />
          </span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">
            No {analysis.title} audit available
          </h2>
          {loadMessage && <p className="mt-1 max-w-md text-[12.5px] leading-[1.5] text-surface-600">{loadMessage}</p>}
          {implemented === false ? (
            /* Rankvora AI has no check registered for this sub-pillar, so an audit run provably
               cannot populate it. Offering the button here would be a dead end. */
            <p className="mt-1 max-w-md text-[12.5px] leading-[1.5] text-surface-500">
              Rankvora AI does not measure this check yet, so running an audit will not populate this
              page. Support for it is still being built.
            </p>
          ) : (
            <>
              <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-surface-500">
                Run an audit to generate real results for this check. Nothing on this page is estimated.
              </p>
              {/* Runs a real audit job and reloads this page's data when it finishes — it no
                  longer just navigates to the dashboard while claiming to run one. */}
              <RunAuditButton />
            </>
          )}
        </div>
      </div>
      </AppPage>
    );
  }

  if (state === 'error' || !data) {
    return (
      <AppPage heading={analysis.title}>
      <div className="mx-auto max-w-2xl py-10">
        <div className={`${card} flex flex-col items-center p-6 text-center`}>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-critical-50 text-critical-600">
            <AlertCircle size={18} />
          </span>
          <h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">
            Unable to load {analysis.title} analysis
          </h2>
          <p className="mt-1 max-w-sm text-[12.5px] leading-[1.5] text-surface-500">
            {loadMessage ?? 'The analysis could not be retrieved.'} Your previous results are unaffected.
          </p>
          <Button variant="primary" onClick={() => load()} className="mt-3">
            
            Retry
          </Button>
        </div>
      </div>
      </AppPage>
    );
  }

  return (
    // The area's name, its Settings and its Re-analyze action are in the page frame (AppPage), drawn by the
    // Shopify admin's title bar. What is left is the content, on the admin's own background.
    <AppPage
      heading={analysis.title}
      primaryAction={{
        label: auditRun.running ? `Analyzing… ${auditRun.progress}%` : isRefreshing ? 'Loading results…' : 'Re-analyze',
        onClick: reanalyze,
        loading: auditRun.running || isRefreshing,
        disabled: auditRun.running || isRefreshing,
        accessibilityLabel: `Re-analyze this store and refresh ${analysis.title}`,
      }}
      secondaryActions={settingsAvailable ? [{ label: 'Settings', onClick: () => setSettingsOpen(true), accessibilityLabel: `${analysis.title} settings` }] : undefined}
    >
      <div className="page-shell">
        {/* One line of context and when the audit last ran, on a single row: the title and the page's
            actions are in the page frame, so there is no second title here. */}
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="page-subtitle min-w-0">{data.description}</p>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
            {/* A seeded fixture is never passed off as a measurement of the merchant's store. */}
            {data.source === 'seed' && (
              <span className="inline-flex items-center rounded border border-warning-200 bg-warning-50 px-1.5 py-0.5 text-[10.5px] font-bold text-warning-700">
                Demo data
              </span>
            )}
            <span className="meta-chip">
              <Clock3 size={12} className="text-surface-400" aria-hidden="true" />
              Last analyzed <span className="font-medium text-surface-800">{data.lastAnalyzed}</span>
            </span>
          </div>
        </div>

        {/* The analysis running, finished or failed is shown by the banner above every page
            (components/audit/AnalysisBanner.tsx). The results below are the previous audit's until it finishes. */}

        {/* The configurator no longer sits here. It moved INTO the Settings panel this page
            already opens from the header, beside Re-analyze — a template the merchant sets once is
            configuration, and it was pushing the score, the findings and the evidence table below
            the fold on every visit. The page now reads score first, exactly like the other seven. */}

        {/* Score + breakdown */}
        <div className="mt-3 grid grid-cols-12 gap-3">
          <div className="col-span-12 xl:col-span-7">
            <ScoreCard totals={data.totals} summary={data.summary} healthChip={data.healthChip} />
          </div>
          <div className="col-span-12 xl:col-span-5">
            <HealthCard totals={data.totals} findings={data.findings} onSelectIssue={focusEvidence} />
          </div>

          {/* Findings */}
          <div className="col-span-12">
            <FindingsList
              findings={data.findings}
              onInvestigate={(finding) => setInvestigation({ finding, rows: [] })}
              emptyTitle={`Excellent — no ${data.title} issues`}
              emptyBody="Nothing was flagged in the latest analysis."
            />
          </div>

          {/* Evidence */}
          <div ref={evidenceRef} className="col-span-12 scroll-mt-3">
            <EvidenceTable
              evidence={data.evidence}
              totalIssues={data.totals.issues}
                supportsBulkFix={data.supportsBulkFix !== false}
                titleSuffixLength={data.titleSuffix?.value.length ?? 0}
                bulkFixMode={data.bulkFixMode}
                bulkFixGenerator={data.bulkFixGenerator}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              findings={data.findings}
              onInvestigate={(finding, rows) => setInvestigation({ finding, rows })}
              externalUpdates={drawerSaves}
            />
          </div>

          {/* Related areas */}
          <div className="col-span-12">
            <p className={eyebrow}>Related areas</p>
            <ul className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {data.relatedAreas.map((area) => (
                <li key={area.href}>
                  <Link
                    to={area.href}
                    className="group flex items-center justify-between gap-2 rounded-md border border-surface-200/80 bg-surface-0 px-2.5 py-1.5 transition-colors hover:border-brand-200 hover:bg-surface-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-surface-800 group-hover:text-brand-700">
                        {area.label}
                      </span>
                      <span className="block truncate text-[10.5px] text-surface-500">{area.hint}</span>
                    </span>
                    <ArrowRight
                      size={13}
                      className="flex-shrink-0 text-surface-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-600 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <InvestigationDrawer
        finding={investigation?.finding ?? null}
        evidence={data.evidence.rows}
        selectedRows={investigation?.rows ?? []}
        subPillar={analysis.slug}
        titleSuffixLength={data.titleSuffix?.value.length ?? 0}
        onApplied={(rowId, value) => setDrawerSaves((current) => [...current, { id: rowId, value }])}
        onClose={() => setInvestigation(null)}
        onReviewAffected={(finding) => {
          setInvestigation(null);
          focusEvidence(finding.issueType);
        }}
      />

      {settingsAvailable && (
        <PageSettingsPanel
          open={settingsOpen}
          definition={settingsDefinition}
          values={pageSettings}
          onClose={() => setSettingsOpen(false)}
          onChange={updatePageSetting}
          onReset={() => setPageSettings(getDefaultSubPillarSettings(analysis.slug))}
          onSave={savePageSettings}
        >
          {configurator}
        </PageSettingsPanel>
      )}
    </AppPage>
  );
}
