import { api } from '../../lib/api';
import type { AuditRow, AuditScoreRow, FindingRow, StoreRow, TrendAuditRow } from '../api.types';
import { describeCoverage, isMeasuredScore } from '../api.types';
import { fetchFindingRows, isOutstandingStoreIssue } from '../findings.repository';
import { describePillar, pillarMeta, pillarOrder, pillarRoutes, scoreToStatus, subPillarLabel } from '../pillarMeta';
import type {
  DashboardData,
  KeyMetric,
  PillarKey,
  PillarScore,
  PriorityIssue,
  RecommendedAction,
  ScoreTrendPoint,
  Severity,
} from './dashboard.types';

interface DashboardSummary {
  latest: AuditRow;
  previous: AuditRow | null;
  scores: AuditScoreRow[];
  priorityFindings: FindingRow[];
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const RECOMMENDED_COUNT = 4;

function trendFrom(latest: number, previous: number | null): { trend: 'up' | 'down' | 'stable'; trendValue: number } {
  if (previous === null || latest === previous) return { trend: 'stable', trendValue: 0 };
  return { trend: latest > previous ? 'up' : 'down', trendValue: Math.abs(latest - previous) };
}

/** The sub-pillar page when the app has one for this slug, else the pillar dashboard. */
export function routeFor(pillar: PillarKey, subPillar: string): string {
  const base = pillarRoutes[pillar] ?? '/';
  return pillarMeta[pillar]?.subPillars.some((entry) => entry.id === subPillar) ? `${base}/${subPillar}` : base;
}

function toPriorityIssue(finding: FindingRow): PriorityIssue {
  const pillar = finding.pillar as PillarKey;
  return {
    id: String(finding.id),
    title: finding.title,
    description: finding.problem ?? finding.why,
    severity: finding.severity,
    pillar,
    pillarLabel: pillarMeta[pillar].label,
    actionLabel: finding.severity === 'critical' || finding.severity === 'high' ? 'Fix issue' : 'Review',
    reviewed: finding.status === 'reviewed',
    route: routeFor(pillar, finding.subPillar),
    affectedCount: finding.affectedCount,
    affectedLabel: finding.affectedLabel,
    population: typeof finding.details?.population === 'number' && finding.details.population > 0 ? finding.details.population : null,
    areaLabel: subPillarLabel(pillar, finding.subPillar),
  };
}

function toRecommendedAction(finding: FindingRow): RecommendedAction {
  const pillar = finding.pillar as PillarKey;
  return {
    id: `rec-${finding.id}`,
    title: finding.title,
    description: finding.recommendation,
    severity: finding.severity,
    pillar,
    pillarLabel: pillarMeta[pillar].label,
    affectedCount: finding.affectedCount,
    affectedLabel: finding.affectedLabel,
    evidence: finding.evidence?.find((line) => typeof line === 'string' && line.trim().length > 0) ?? null,
    route: routeFor(pillar, finding.subPillar),
  };
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The overall summary, stated from what the audit counted.
 *
 * This used to be one fixed sentence per score band — "critical issues are affecting multiple
 * pillars" for any score under 50 — asserted whether or not the findings said so. Every clause here
 * is a count from this audit.
 */
function describeAudit(issues: FindingRow[], pillars: PillarScore[]): string {
  const bySeverity = SEVERITY_ORDER
    .map((severity) => ({ severity, count: issues.filter((finding) => finding.severity === severity).length }))
    .filter((entry) => entry.count > 0);

  const measured = pillars.filter((pillar) => pillar.score !== null);
  const lowest = measured.length > 1
    ? measured.reduce((low, pillar) => (pillar.score! < low.score! ? pillar : low))
    : null;
  const lowestClause = lowest ? ` ${lowest.label} is the lowest-scoring pillar at ${lowest.score}.` : '';

  if (issues.length === 0) return `The latest analysis found no open issues.${lowestClause}`;

  // "3 critical and 7 high-severity issues are open across 4 pillars."
  const counts = joinList(bySeverity.map(({ severity, count }) => `${count} ${severity}`));
  const pillarsHit = [...new Set(issues.map((finding) => finding.pillar as PillarKey))];
  const where = pillarsHit.length === 1
    ? `in ${pillarMeta[pillarsHit[0]]?.label ?? 'one pillar'}`
    : `across ${pillarsHit.length} pillars`;
  return `${counts}-severity ${issues.length === 1 ? 'issue is' : 'issues are'} open ${where}.${lowestClause}`;
}

/** Fetches real dashboard data: summary + score trend + store identity + the latest audit's
 * complete findings, assembled into `DashboardData`. */
export async function fetchDashboardData(): Promise<DashboardData> {
  const [summary, trend, store, findingRows] = await Promise.all([
    api.get<DashboardSummary>('/dashboard/summary'),
    api.get<TrendAuditRow[]>('/reports/trend?limit=6'),
    api.get<StoreRow>('/stores/current'),
    // The COMPLETE set for the latest audit, not the summary's top ten: "Total issues" and
    // "Critical" were counted from a list the API caps at 10, so a store with 25 open issues read
    // "10" and nothing on screen said so.
    fetchFindingRows(),
  ]);

  const { latest, previous, scores } = summary;

  // The engine writes overallAvailable:false when NO pillar produced a measurable result; the
  // accompanying overall_score is a NOT-NULL placeholder zero, not a real score (runner.ts:83).
  // Rendering it through scoreToStatus() is what made an unmeasured store read as "Critical 0/100".
  // Older audits predate the metadata column, so `undefined` is treated as measured —
  // only an explicit `false` suppresses the score.
  const measured = latest.metadata?.overallAvailable !== false;
  // Only products are surfaced here: it is the resource that actually gets truncated on large
  // catalogues, and stacking every resource type onto the hero card would bury the point.
  const coverageNote = describeCoverage(latest.metadata?.coverageDetail?.products, 'products');

  // A change needs two measured scores. The API returns the previous MEASURED audit, but an older
  // server may still send one that measured nothing, whose score is a placeholder.
  const previousScore = previous && previous.metadata?.overallAvailable !== false ? previous.overallScore : null;
  const { trend: scoreTrendDir, trendValue } = trendFrom(latest.overallScore, previousScore);
  const overallStatus = measured
    ? scoreToStatus(latest.overallScore)
    : { status: 'not-measured' as const, statusLabel: 'Not measured' };

  const pillarScores = scores.filter((score) => score.subPillar === null);

  // Driven by the pillar CATALOG, not by what the audit happened to return — the same rule
  // pillarDashboard.repository.ts already applies to sub-pillar areas.
  //
  // This previously did `.filter(Boolean)` on the lookup, which silently DELETED any pillar the
  // engine produced no row for. With checks registered only for SEO and Content, that dropped
  // Speed, CRO and AI Discovery from the dashboard entirely — they were absent, not zero, so the
  // merchant had no way to tell "not measured yet" from "does not exist". Keeping the catalog as
  // the source means a pillar can never disappear, and a future pillar needs no change here.
  const pillars: PillarScore[] = pillarOrder.map((key) => {
    const meta = pillarMeta[key];
    const row = pillarScores.find((score) => score.pillar === key);
    // A row whose details say 'unavailable' carries a NOT-NULL placeholder zero, not a result.
    const isMeasured = row ? isMeasuredScore(row) : false;
    const score = isMeasured && row ? row.score : null;
    const checksTotal = isMeasured ? row?.checksTotal ?? 0 : 0;
    const checksPassed = isMeasured ? row?.checksPassed ?? 0 : 0;
    const { status, statusLabel } = isMeasured && score !== null
      ? scoreToStatus(score)
      : { status: 'not-measured' as const, statusLabel: 'Not measured' };

    return {
      key,
      label: meta.label,
      score,
      status,
      statusLabel,
      description: isMeasured && score !== null
        ? describePillar(meta.label, score, checksTotal, checksPassed)
        : `${meta.label} has not been analyzed yet.`,
      icon: meta.icon,
      checksTotal,
      checksPassed,
      subPillars: meta.subPillars,
    };
  });

  // The API already orders these as the priority list is ordered: severity, then how many items
  // each affects. Filtering keeps that order.
  const issues = findingRows.filter(isOutstandingStoreIssue);
  const criticalCount = issues.filter((finding) => finding.severity === 'critical').length;
  const pillarsWithIssues = new Set(issues.map((finding) => finding.pillar)).size;
  const totalChecksPassed = pillars.reduce((sum, pillar) => sum + pillar.checksPassed, 0);
  const totalChecks = pillars.reduce((sum, pillar) => sum + pillar.checksTotal, 0);

  const keyMetrics: KeyMetric[] = [
    { id: 'overall-health', label: 'Overall Health', value: latest.overallScore, statusLabel: overallStatus.statusLabel, color: 'success', trend: scoreTrendDir, trendValue },
    {
      id: 'issues',
      label: 'Open issues',
      value: issues.length,
      context: issues.length > 0 ? `across ${plural(pillarsWithIssues, 'pillar', 'pillars')}` : 'nothing outstanding',
      color: issues.length > 0 ? 'warning' : 'success',
    },
    {
      id: 'critical',
      label: 'Critical',
      value: criticalCount,
      context: issues.length > 0 ? `of ${issues.length.toLocaleString('en-US')} open` : undefined,
      color: 'critical',
    },
    {
      id: 'passed',
      label: 'Healthy items',
      value: totalChecksPassed,
      context: totalChecks > 0 ? `of ${totalChecks.toLocaleString('en-US')} analyzed` : undefined,
      color: 'success',
    },
  ];

  // Trend points are the backend's measured engine audits (report.service.ts). The latest audit is
  // also dropped here when it measured nothing, which this page knows from the summary: its score
  // is a placeholder, and plotting it draws a collapse to 0 that never happened.
  const scoreTrend: ScoreTrendPoint[] = trend
    .filter((audit) => measured || audit.id !== latest.id)
    .map((audit) => ({ date: audit.runAt.slice(0, 10), score: audit.overallScore }));

  return {
    storeName: store.name,
    storeUrl: store.url,
    lastUpdated: latest.runAt,
    overallScore: {
      score: latest.overallScore,
      status: overallStatus.status,
      statusLabel: overallStatus.statusLabel,
      description: measured
        ? describeAudit(issues, pillars)
        : 'No audit data available yet. Run an audit to measure your store.',
      trend: scoreTrendDir,
      trendValue,
      measured,
      coverageNote,
    },
    keyMetrics,
    pillars,
    priorityIssues: issues.map(toPriorityIssue),
    // The most severe first, then the most items affected — the order the audit's own rules give.
    recommendedActions: issues.slice(0, RECOMMENDED_COUNT).map(toRecommendedAction),
    scoreTrend,
  };
}

/**
 * Formats relative time from an ISO date string.
 */
export function formatLastUpdated(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Returns semantic color class prefix for a score status.
 */
export function getScoreColorClass(score: number): string {
  if (score >= 90) return 'success';
  if (score >= 75) return 'brand';
  if (score >= 50) return 'warning';
  return 'critical';
}
