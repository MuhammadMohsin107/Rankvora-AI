import { ApiError, api } from '../lib/api';
import { hiddenPillarKeys } from '../config/modules';
import type { AuditRow, AuditScoreRow } from './api.types';
import { isMeasuredScore } from './api.types';
import { pillarMeta, pillarOrder, scoreToStatus } from './pillarMeta';
import type { PillarKey } from './dashboard/dashboard.types';
import { findingPillarScopes } from './findings.repository';
import { fetchShopifyStatus } from './shopify.repository';
import { withoutHiddenPillarRows } from './reportCsv';

/**
 * ─── Reports data ────────────────────────────────────────────────────
 *
 * Every number on the Reports page comes from this store's own audit rows. There is no fixture,
 * no fallback series and no placeholder report list.
 *
 * Three things this file deliberately does NOT do, because each one previously put a figure on
 * screen that nothing had measured:
 *
 *   · It does not fall back to the current score when there is no earlier audit. A store with one
 *     audit has no comparison, so `previous` is null and the page shows a dash — not "+0", which
 *     asserts a comparison that never happened.
 *   · It does not read `score` off a row whose details say 'unavailable'. That score is a
 *     NOT-NULL placeholder zero written by the engine, and rendering it turns "we could not
 *     measure this" into "this scored 0".
 *   · It does not drop pillars the audit produced no row for. The pillar list is driven by the
 *     catalog, so a pillar with no checks reads "Not measured" instead of vanishing.
 */

export const REPORT_PERIODS = ['7D', '30D', '90D', '6M', '1Y'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const PERIOD_DAYS: Record<ReportPeriod, number> = { '7D': 7, '30D': 30, '90D': 90, '6M': 182, '1Y': 365 };
const DAY_MS = 86_400_000;

/**
 * What the current report is measured against.
 *
 * These replace "Previous period" / "Previous year", which the page offered but never applied —
 * the comparison was always the immediately preceding audit whichever was selected, so the two
 * options relabelled the text and changed nothing. Both options below are resolvable from the
 * store's own audit history, and both actually change the baseline.
 */
export const REPORT_COMPARISONS = ['Previous audit', 'Start of period'] as const;
export type ReportComparison = (typeof REPORT_COMPARISONS)[number];

export interface ReportPillar {
  key: PillarKey;
  label: string;
  /** null when this pillar produced no measurable result in this audit. */
  current: number | null;
  /** null when there is no baseline audit, or the baseline could not measure this pillar. */
  previous: number | null;
  status: string;
  /** The pillar's accent and its translucent badge ground, both CSS variables — see
   * pillarMeta.ts for why these are not hex literals. */
  color: string;
  tint: string;
}

export interface ReportTrendPoint {
  date: string;
  score: number;
}

export interface ReportHistoryItem {
  id: number;
  runAt: string;
  /** null when the run measured nothing — its stored overall score is a placeholder. */
  overallScore: number | null;
  isLatest: boolean;
  /** True for development fixtures, which the UI labels rather than passing off as an audit. */
  isFixture: boolean;
}

export interface ReportOverview {
  auditId: number;
  reportDate: string;
  isFixture: boolean;
  /** null when the audit measured nothing at all. */
  currentScore: number | null;
  previousScore: number | null;
  baselineDate: string | null;
  trend: ReportTrendPoint[];
  pillars: ReportPillar[];
  issuesResolved: number;
  criticalIssues: number;
  findingsTracked: number;
  history: ReportHistoryItem[];
}

export interface ReportsState {
  /** False when this workspace has no Shopify connection at all. */
  connected: boolean;
  shopDomain: string | null;
  /** null when the connected store has never been analyzed. */
  overview: ReportOverview | null;
}

interface AuditListResponse {
  items: AuditRow[];
}

interface AuditScoresResponse {
  audit: AuditRow;
  scores: AuditScoreRow[];
}

interface FindingCountResponse {
  pagination: { total: number };
}

/** 404 here means "this store has nothing yet", which is an empty state, not a failure. */
async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const runTime = (audit: AuditRow) => new Date(audit.runAt).getTime();

/** The engine writes overallAvailable:false when no pillar produced a result; the stored score
 * is then a placeholder, not a measurement. Legacy rows have no metadata and are treated as real. */
const isMeasuredAudit = (audit: AuditRow) => audit.metadata?.overallAvailable !== false;

/** One count query per tile, reading `pagination.total` — so the figures are the store's real
 * totals rather than a count of whatever the first page happened to contain. */
function countFindings(query: string): Promise<number> {
  // Added up per visible pillar when a pillar is hidden, so its findings are not in the totals; one
  // unscoped query otherwise (see findingPillarScopes).
  return Promise.all(
    findingPillarScopes().map((scope) =>
      api
        .get<FindingCountResponse>(`/findings?limit=1${query}${scope}`)
        .then((response) => response.pagination.total)
        .catch(() => 0),
    ),
  ).then((totals) => totals.reduce((sum, total) => sum + total, 0));
}

export async function fetchReports(period: ReportPeriod, comparison: ReportComparison): Promise<ReportsState> {
  // A workspace with no store row at all 404s here. That is the same "nothing to report on"
  // state as a store with no Shopify connection, not a failure to surface as an error.
  const status = await orNull(fetchShopifyStatus());
  // 'error' and 'reauthorization_required' still describe a linked store whose audits are real;
  // only 'not_connected' means there is nothing to report on.
  const connected = status !== null && status.status !== 'not_connected';
  const shopDomain = status?.shopDomain ?? null;
  if (!connected) return { connected: false, shopDomain, overview: null };

  const [list, latest] = await Promise.all([
    orNull(api.get<AuditListResponse>('/audits?limit=100')),
    orNull(api.get<AuditScoresResponse>('/audits/latest')),
  ]);

  if (!latest || !list) return { connected: true, shopDomain, overview: null };

  const auditRows = list.items; // newest first, from the API
  const current = latest.audit;
  const windowStart = Date.now() - PERIOD_DAYS[period] * DAY_MS;
  const inWindow = auditRows.filter((audit) => runTime(audit) >= windowStart);

  // ── Baseline ────────────────────────────────────────────────────────
  const older = auditRows.filter((audit) => audit.id !== current.id && runTime(audit) < runTime(current));
  const baseline = comparison === 'Start of period'
    ? [...inWindow].reverse().find((audit) => audit.id !== current.id && runTime(audit) < runTime(current)) ?? null
    : older[0] ?? null;

  const baselineScores = baseline
    ? (await orNull(api.get<AuditScoresResponse>(`/audits/${baseline.id}/scores`)))?.scores ?? null
    : null;

  const pillarRow = (scores: AuditScoreRow[] | null, key: string) =>
    scores?.find((score) => score.subPillar === null && score.pillar === key) ?? null;

  const pillars: ReportPillar[] = pillarOrder.map((key) => {
    const meta = pillarMeta[key];
    const row = pillarRow(latest.scores, key);
    const score = row && isMeasuredScore(row) ? row.score : null;
    const before = pillarRow(baselineScores, key);
    return {
      key,
      label: meta.label,
      current: score,
      previous: before && isMeasuredScore(before) ? before.score : null,
      status: score === null ? 'Not measured' : scoreToStatus(score).statusLabel,
      color: meta.color,
      tint: meta.tint,
    };
  });

  const [findingsTracked, issuesResolved, criticalIssues] = await Promise.all([
    countFindings(''),
    countFindings('&status=resolved'),
    countFindings('&severity=critical&status=open'),
  ]);

  return {
    connected: true,
    shopDomain,
    overview: {
      auditId: current.id,
      reportDate: current.runAt,
      isFixture: current.source === 'seed',
      currentScore: isMeasuredAudit(current) ? current.overallScore : null,
      previousScore: baseline && isMeasuredAudit(baseline) ? baseline.overallScore : null,
      baselineDate: baseline?.runAt ?? null,
      // Unmeasured runs are left out of the series: their stored zero is a placeholder, and a
      // plotted zero is indistinguishable from a store that genuinely scored nothing.
      trend: inWindow
        .filter(isMeasuredAudit)
        .map((audit) => ({ date: audit.runAt, score: audit.overallScore }))
        .reverse(),
      pillars,
      issuesResolved,
      criticalIssues,
      findingsTracked,
      history: auditRows.map((audit) => ({
        id: audit.id,
        runAt: audit.runAt,
        overallScore: isMeasuredAudit(audit) ? audit.overallScore : null,
        isLatest: audit.id === current.id,
        isFixture: audit.source === 'seed',
      })),
    },
  };
}

/** One historical report, opened from the Previous reports list. */
export async function fetchReportDetail(auditId: number): Promise<AuditScoresResponse> {
  return api.get<AuditScoresResponse>(`/audits/${auditId}/scores`);
}

/**
 * Downloads the report CSV the SERVER builds.
 *
 * The page used to assemble its own CSV from the five pillar rows it had already rendered, so
 * the export could never contain anything the page did not — no sub-pillar breakdown, no issues,
 * no recommendations. GET /reports/export joins those server-side for the audit being exported.
 */
export async function exportReportCsv(auditId?: number): Promise<string> {
  const { blob: serverFile, filename } = await api.download(
    `/reports/export${auditId ? `?auditId=${auditId}` : ''}`,
    'rankvora-ai-report.csv',
  );

  // The server's file covers every pillar it measured. A pillar the customer cannot see is taken
  // out of their copy (data/reportCsv.ts); with nothing hidden the file is saved exactly as sent.
  const blob = hiddenPillarKeys().length === 0
    ? serverFile
    : new Blob([withoutHiddenPillarRows(await serverFile.text())], { type: serverFile.type || 'text/csv' });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: Safari cancels an in-flight download if the object URL is released
  // in the same task that clicked the link.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
