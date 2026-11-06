import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Clock3, Radar } from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { type EvidenceRow, type RowStatus, type SubPillarAnalysis, type SubPillarFinding } from '../data/seo/subpillar.model';
import { fetchSubPillarAnalysis, isNotAuditedYet } from '../data/seo/subpillar.repository';
import { buildAnalysis } from '../data/genericAnalysis';
import AppPage from '../components/polaris/AppPage';
import ScoreCard from '../components/seo/subpillar/ScoreCard';
import HealthCard from '../components/seo/subpillar/HealthCard';
import FindingsList from '../components/seo/subpillar/FindingsList';
import EvidenceTable from '../components/seo/subpillar/EvidenceTable';
import InvestigationDrawer from '../components/seo/subpillar/InvestigationDrawer';
import SubPillarSkeleton from '../components/seo/subpillar/SubPillarSkeleton';
import { card, eyebrow } from '../components/seo/subpillar/tone';
import { genericCatalog } from './pillarCatalogs/genericCatalog';
import { detailCatalog } from './pillarCatalogs/detailCatalog';
import PageSettingsPanel from '../components/settings/PageSettingsPanel';
import RunAuditButton from '../components/audit/RunAuditButton';
import { isSubPillarFixable, isSubPillarImplemented } from '../data/audits.capabilities';
import { getDefaultSubPillarSettings, getSubPillarSettingsDefinition, hasSubPillarSettings, type PageSettingValue } from '../data/pageSettings.registry';
import GrantShopifyAccess from '../components/audit/GrantShopifyAccess';
import { fetchSubPillarSettings, saveSubPillarSettings } from '../data/pageSettings.repository';
import { useAuditCompletion, useAuditRun } from '../data/useAuditRun';
import MissingImagesPanel from '../components/images/MissingImagesPanel';
import Button from '../components/polaris/Button';

/** Where an unrecognised slug is sent. The pillar LABELS that used to sit beside this were only
 * needed by the in-page breadcrumb, which the header now owns on its own. */
const backRoutes: Record<string, string> = { content: '/content', speed: '/speed', cro: '/cro', 'ai-discovery': '/ai-discovery' };

export default function NonSeoSubPillarPage() {
  const location = useLocation();
  const routeKey = location.pathname.replace(/^\//, '').replace(/\/$/, '');
  const config = genericCatalog[routeKey];
  const details = detailCatalog[routeKey];
  const [data, setData] = useState<SubPillarAnalysis | null>(null);
  const [state, setState] = useState<'loading' | 'success' | 'empty' | 'error'>('loading');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [investigation, setInvestigation] = useState<{ finding: SubPillarFinding; rows: EvidenceRow[] } | null>(null);
  // Values saved to the store from the investigation drawer, shown in the table until the next
  // analysis replaces its rows.
  const [drawerSaves, setDrawerSaves] = useState<Array<{ id: string; value: string }>>([]);
  useEffect(() => { setDrawerSaves([]); }, [data]);
  const [statusFilter, setStatusFilter] = useState<RowStatus | 'All'>('All');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The Missing images panel — only the Media richness page has one.
  const [imagesOpen, setImagesOpen] = useState(false);
  // null = unknown; treated as "assume measurable" so a capability outage never hides a working
  // Run Audit button. See data/audits.capabilities.ts.
  const [implemented, setImplemented] = useState<boolean | null>(null);
  /**
   * Whether Rankvora AI can WRITE a fix here, which is a different question from whether it can
   * measure. Starts false and is only raised once the backend confirms this sub-pillar has a
   * writable field, so the bulk-fix controls are never offered speculatively.
   */
  const [fixable, setFixable] = useState(false);
  const [pageSettings, setPageSettings] = useState<Record<string, PageSettingValue>>(() => getDefaultSubPillarSettings(routeKey));
  // Last values loaded from / saved to the API — what "close without saving" reverts to.
  const savedSettingsRef = useRef<Record<string, PageSettingValue>>(pageSettings);
  const evidenceRef = useRef<HTMLDivElement>(null);

  const analysis = useMemo(() => config ? buildAnalysis(routeKey, config, details) : null, [config, details, routeKey]);
  const load = useCallback(async (refresh = false) => { if (!analysis) return; try { if (refresh) setIsRefreshing(true); else setState('loading'); setData(await fetchSubPillarAnalysis(analysis)); setState('success'); } catch (error) { setState(isNotAuditedYet(error) ? 'empty' : 'error'); } finally { setIsRefreshing(false); } }, [analysis]);
  /**
   * "Re-analyze" must re-ANALYSE the store — run a real audit and wait for it — not re-read the
   * audit already stored.
   *
   * It used to call load(true) alone, which re-fetched the SAME persisted audit and rendered the
   * same numbers: "Last analyzed" never moved and nothing on the page changed, which is exactly
   * what a button that does nothing looks like. The SEO sub-pillar page and all five pillar
   * dashboards already ran a real audit behind the same label — this is the same hook, so the
   * eight non-SEO sub-pillar pages cannot drift from them again. load() picks up the new audit
   * once it lands.
   */
  const auditRun = useAuditRun();
  const reanalyze = () => void auditRun.run();
  // Whichever page started an analysis, this one loads its results when it finishes.
  useAuditCompletion(() => load(true));

  useEffect(() => { setInvestigation(null); setStatusFilter('All'); load(); }, [load]);
  useEffect(() => {
    let active = true;
    const defaults = getDefaultSubPillarSettings(routeKey);
    savedSettingsRef.current = defaults;
    setPageSettings(defaults);
    setSettingsOpen(false);
    const [pillarKey, subKey] = routeKey.split('/');
    isSubPillarImplemented(pillarKey ?? '', subKey ?? '')
      .then((value) => { if (active) setImplemented(value); })
      .catch(() => { if (active) setImplemented(null); });
    isSubPillarFixable(subKey ?? '')
      .then((value) => { if (active) setFixable(value); })
      .catch(() => { if (active) setFixable(false); });
    if (hasSubPillarSettings(routeKey)) {
      fetchSubPillarSettings(routeKey)
        .then((values) => { if (active) { savedSettingsRef.current = values; setPageSettings(values); } })
        .catch((error) => console.error('Failed to load page settings', error));
    }
    return () => { active = false; };
  }, [routeKey]);

  const offersImages = routeKey === 'content/media-richness';
  const settingsDefinition = getSubPillarSettingsDefinition(routeKey);
  // A page with nothing real to configure shows no Settings button — never another page's settings,
  // and never controls no check reads. Same rule as the SEO template.
  const settingsAvailable = hasSubPillarSettings(routeKey);
  // The page's main action, in the page frame (the admin's title bar) on every state that has results.
  const reanalyzeAction = {
    label: auditRun.running ? `Analyzing… ${auditRun.progress}%` : isRefreshing ? 'Loading results…' : 'Re-analyze',
    onClick: reanalyze,
    loading: auditRun.running || isRefreshing,
    disabled: auditRun.running || isRefreshing,
    accessibilityLabel: `Re-analyze this store and refresh ${config?.title ?? 'this page'}`,
  };
  const updatePageSetting = (key: string, value: PageSettingValue) => setPageSettings((current) => ({ ...current, [key]: value }));
  const savePageSettings = () => {
    savedSettingsRef.current = pageSettings;
    saveSubPillarSettings(routeKey, pageSettings)
      .catch((error) => console.error('Failed to save page settings', error));
    setSettingsOpen(false);
  };

  // An unrecognised slug is a bad URL, not a pending feature: the route wildcard accepts anything
  // after /content, /speed, /cro or /ai-discovery, so a typo or a stale link lands here. Redirect
  // to that pillar's dashboard, matching SeoSubPillarRoute — previously this rendered a
  // "not available yet" card that implied the page was coming, and the three non-CRO pillars
  // never even reached it because their routes were enumerated and simply did not match.
  if (!config || !analysis) {
    const pillarKey = routeKey.split('/')[0] ?? '';
    return <Navigate to={backRoutes[pillarKey] ?? '/'} replace />;
  }
  // Every state sits in the same page frame, so the title bar keeps this area's name while its data
  // loads, is missing, or fails to load. Re-analyze (and Settings) join it only on the page that has
  // results to refresh; the other states carry their own "Run the audit" or "Retry".
  if (state === 'loading') return <AppPage heading={config.title}><SubPillarSkeleton /></AppPage>;
  // "Not audited yet" is a first-run state, not a failure — the page must not imply a fault,
  // and must not fill its layout with numbers to compensate.
  if (state === 'empty') return <AppPage heading={config.title}><div className="mx-auto max-w-2xl py-10"><div className={`${card} flex flex-col items-center p-6 text-center`}><Radar size={18} className="text-brand-600" /><h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">No {config.title} audit yet</h2>{implemented === false
    ? <p className="mt-1 max-w-md text-[12.5px] leading-[1.5] text-surface-500">Rankvora AI does not measure this check yet.</p>
    : <RunAuditButton />}</div></div></AppPage>;

  if (state === 'error' || !data) return <AppPage heading={config.title}><div className="mx-auto max-w-2xl py-10"><div className={`${card} flex flex-col items-center p-6 text-center`}><AlertCircle size={18} className="text-critical-600" /><h2 className="mt-2.5 text-[15px] font-semibold text-surface-900">Unable to load {config.title}</h2><Button variant="primary" onClick={() => load()} className="mt-3">Retry</Button></div></div></AppPage>;

  /**
   * ─── The check ran, and could not measure anything ─────────────────
   *
   * The backend stores a placeholder score of 0 for this case and says, in so many words, that the
   * UI must render the status and not the number. This template rendered the number: a 0/100 dial
   * labelled "Critical", four zero counters, "Excellent — no issues" beneath them, and a Review
   * evidence button leading to an empty table — every piece of it derived from a measurement that
   * did not happen, on a page whose own sentence said it could not be checked. The SEO template has
   * always had this branch; the Content, Speed, CRO and AI Discovery pages now share it.
   *
   * Real rows are still shown when the check has them — prompt tracking withholds its score until a
   * question has enough answers, but the answers already recorded are genuine.
   */
  if (data.status === 'unavailable') {
    return (
      <AppPage heading={config.title} primaryAction={reanalyzeAction}>
        <div className="page-shell">
          {/* When the audit last ran: the title and Re-analyze are in the page frame. */}
          <div className="flex sm:justify-end">
            <span className="meta-chip flex-shrink-0">
              <Clock3 size={12} className="text-surface-400" aria-hidden="true" />
              Last analyzed <span className="font-medium text-surface-800">{data.lastAnalyzed}</span>
            </span>
          </div>

          <div className={`${card} mt-3 flex flex-col items-center px-4 py-5 text-center`}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-100 text-surface-500">
              <Radar size={16} aria-hidden="true" />
            </span>
            <h2 className="mt-2 text-[14px] font-semibold text-surface-900">Not measured</h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-[1.5] text-surface-600">
              {data.unavailableReason ?? 'This check could not be measured.'}
            </p>
            {data.requiredScope && <GrantShopifyAccess scope={data.requiredScope} />}
          </div>

          {data.evidence.rows.length > 0 && (
            <div className="mt-3">
              <EvidenceTable
                evidence={data.evidence}
                totalIssues={0}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                findings={data.findings}
                onInvestigate={(finding, rows) => setInvestigation({ finding, rows })}
              />
            </div>
          )}
        </div>
      </AppPage>
    );
  }

  /**
   * Filters the evidence table to one status and scrolls to it.
   *
   * The requested status is applied ONLY if a row actually carries it. A finding's `issueType` and
   * the statuses its evidence rows use are set independently by each check, and where they
   * disagree the table filtered itself down to nothing and rendered "Nothing matches these
   * filters" — a dead end reached by pressing a button labelled "Review evidence". Falling back to
   * 'All' shows the merchant the rows that do exist instead of an empty table.
   */
  const focusEvidence = (status: RowStatus | 'All') => {
    const applicable = status === 'All' || data.evidence.rows.some((row) => row.status === status);
    setStatusFilter(applicable ? status : 'All');
    evidenceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /**
   * The recommendation shown at the bottom of the page comes from the audit's most severe
   * finding.
   *
   * It used to be `config.metrics[0].description` — a static catalog string written as the tail
   * of a sentence that a number was meant to lead ("142 pages pass the experience threshold"),
   * so on its own it rendered as a fragment: "pages pass the experience threshold",
   * "images exceed the recommended payload". Every non-SEO sub-pillar showed one, and none of
   * them was a recommendation or a measurement of this store.
   */
  const severityWeight: Record<SubPillarFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const leadFinding = [...data.findings].sort((a, b) => severityWeight[a.severity] - severityWeight[b.severity])[0];

  // Same compact shell as the SEO master template: page-shell frame, one header row, a 12-column
  // grid on a 12px gutter. The two templates render the same components, so they must also agree
  // on the space around them — a Content sub-pillar and an SEO sub-pillar are the same screen.
  return (
    // The area's name, its Settings / image actions and its Re-analyze are in the page frame (AppPage),
    // drawn by the Shopify admin's title bar. What is left is the content, on the admin's own background.
    <AppPage
      heading={config.title}
      primaryAction={reanalyzeAction}
      secondaryActions={[
        ...(settingsAvailable ? [{ label: 'Settings', onClick: () => setSettingsOpen(true), accessibilityLabel: `${config.title} settings` }] : []),
        ...(offersImages ? [{ label: 'Add product images', onClick: () => setImagesOpen(true) }] : []),
      ]}
    >
      <div className="page-shell">
        {/* NO in-page breadcrumb, NO second title and NO subtitle: the page frame carries the area's
            name. What is left is when the audit last ran. */}
        <div className="flex sm:justify-end">
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

        <div className="mt-3 grid grid-cols-12 gap-3">
          <div className="col-span-12 xl:col-span-7">
            <ScoreCard totals={data.totals} summary={data.summary} healthChip={data.healthChip} />
          </div>
          <div className="col-span-12 xl:col-span-5">
            <HealthCard totals={data.totals} findings={data.findings} onSelectIssue={focusEvidence} />
          </div>

          <div className="col-span-12">
            <FindingsList
              findings={data.findings}
              onInvestigate={(finding) => setInvestigation({ finding, rows: [] })}
              emptyTitle="No issues found"
            />
          </div>

          <div ref={evidenceRef} className="col-span-12 scroll-mt-3">
            <EvidenceTable
              evidence={data.evidence}
              totalIssues={data.totals.issues}
              issueUnits={data.totals.issueUnits}
              // Gated on the backend's own write allow-list, not on the analysis config. The
              // generic page used to pass `true` for every non-SEO sub-pillar, so Catalog / Feed
              // Readiness offered to "fix" a missing GTIN — an identifier no one can derive.
              supportsBulkFix={data.supportsBulkFix && fixable}
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

          <div className="col-span-12">
            <p className={eyebrow}>Recommendation</p>
            <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-brand-100 bg-brand-50/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12.5px] leading-[1.5] text-surface-700">
                {leadFinding?.recommendation ?? 'No issues flagged.'}
              </p>
              {/*
                With a finding, this filters to the rows that caused it. With none, it filters to
                the HEALTHY rows — which is what "confirm coverage" means, and is a visible change.
                It used to pass 'All' in that case, which is already the default filter, so on a
                healthy sub-pillar the button changed nothing at all and read as broken.
              */}
              <Button variant="primary" onClick={() => focusEvidence(leadFinding?.issueType ?? data.evidence.healthyStatus ?? 'Healthy')} className="flex-shrink-0">
                
                Review evidence
              </Button>
            </div>
          </div>
        </div>
      </div>

      <InvestigationDrawer
        finding={investigation?.finding ?? null}
        evidence={data.evidence.rows}
        selectedRows={investigation?.rows ?? []}
        subPillar={routeKey.split('/')[1]}
        titleSuffixLength={data.titleSuffix?.value.length ?? 0}
        onApplied={(rowId, value) => setDrawerSaves((current) => [...current, { id: rowId, value }])}
        onAddImages={offersImages ? () => { setInvestigation(null); setImagesOpen(true); } : undefined}
        onClose={() => setInvestigation(null)}
        onReviewAffected={(finding) => { setInvestigation(null); focusEvidence(finding.issueType); }}
      />

      {offersImages && <MissingImagesPanel open={imagesOpen} onClose={() => setImagesOpen(false)} />}

      {settingsAvailable && (
        <PageSettingsPanel
          open={settingsOpen}
          definition={settingsDefinition}
          values={pageSettings}
          onClose={() => { setSettingsOpen(false); setPageSettings(savedSettingsRef.current); }}
          onChange={updatePageSetting}
          onReset={() => setPageSettings(getDefaultSubPillarSettings(routeKey))}
          onSave={savePageSettings}
        />
      )}
    </AppPage>
  );
}
