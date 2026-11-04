import { api, ApiError } from '../../lib/api';
import { sortBySeverity, type EvidenceRow, type SubPillarAnalysis, type SubPillarFinding } from './subpillar.model';

interface LiveSubPillarData {
  slug: string;
  summary: string;
  healthChip: string;
  totals: {
    score: number;
    analyzed: number;
    healthy: number;
    issues: number;
    critical: number;
    contextLabel: string;
    contextValue: string;
    issueUnits?: Array<{ unit: string; flagged: number; of: number }> | null;
  };
  findings: SubPillarFinding[];
  evidenceRows: EvidenceRow[];
  healthyStatus?: string;
  lastAnalyzed: string;
  status?: 'ok' | 'unavailable';
  titleSuffix?: { value: string; observedOn: number; comparedPages: number } | null;
  unavailableReason?: string | null;
  /** The Shopify permission an 'unavailable' result is waiting on, when that is why. */
  requiredScope?: string | null;
  /** 'seed' = development fixture. The pages label it instead of passing it off as an audit. */
  source?: 'engine' | 'seed';
}

function formatLastAnalyzed(isoDate: string): string {
  return new Date(isoDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * SEO analyses use a bare route slug ('title-tags'); generic pillars use a
 * pillar-prefixed route key ('speed/cwv'). Both resolve to the same endpoint
 * shape: /audits/latest/:pillar/:subPillar with a bare sub-pillar slug.
 */
function endpointFor(slug: string): { pillar: string; subPillar: string } {
  const separator = slug.indexOf('/');
  if (separator > 0) return { pillar: slug.slice(0, separator), subPillar: slug.slice(separator + 1) };
  return { pillar: 'seo', subPillar: slug };
}

/**
 * Resolves a sub-pillar's full `SubPillarAnalysis`. `base` supplies the static
 * presentation config (title/description/relatedAreas/evidence columns+facet+
 * searchKeys — everything that doesn't change per audit). The data fields
 * (totals/findings/evidence.rows/summary/healthChip/lastAnalyzed) come from
 * the backend; `evidence.sorts` is rebuilt with the real findings since
 * `sortBySeverity` closes over them.
 */
/**
 * True when the failure means this store has not been audited yet, rather than something being
 * broken. The backend distinguishes them by code; without this the pages render "Unable to load"
 * for every brand-new store, which reads as a fault when nothing has been measured.
 */
export function isNotAuditedYet(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    // AUDIT_STALE_STORE: the latest audit was of a different shop than the one connected now, so
    // for THIS store nothing has been measured yet — the same first-run state, not a fault.
    ['AUDIT_NOT_FOUND', 'AUDITS_NOT_FOUND', 'SUB_PILLAR_NOT_FOUND', 'AUDIT_STALE_STORE'].includes(error.code ?? '')
  );
}

/**
 * The number for the fourth KPI tile — the one `criticalLabel` names.
 *
 * That tile showed `totals.critical`, which the backend defines as the affected count of findings
 * whose SEVERITY is 'critical' (audit.service.ts). But almost every sub-pillar labels the tile
 * with an ISSUE TYPE instead — 'Missing', 'Conflicts', 'Broken links', 'No alt attribute' — so the
 * label and the value were measuring different things. Meta descriptions showed it worst: its
 * "Pages with no meta description" finding is deliberately severity 'high', not 'critical', so the
 * tile read "MISSING 0" on a store where 103 pages were missing one, directly contradicting the
 * breakdown beside it.
 *
 * Findings already carry the real store-wide count per issue type — it is what the breakdown
 * renders — so the tile now reads its own label's count from them. A label that names no issue
 * type (title-tags says 'Critical') matches nothing and keeps the severity count, which is
 * exactly what that label means.
 */
function countForLabel(label: string, findings: SubPillarFinding[], fallback: number): number {
  const wanted = label.trim().toLowerCase();
  const matching = findings.filter((finding) => finding.issueType.trim().toLowerCase() === wanted);
  if (matching.length === 0) return fallback;
  return matching.reduce((sum, finding) => sum + finding.affected, 0);
}

export async function fetchSubPillarAnalysis(base: SubPillarAnalysis): Promise<SubPillarAnalysis> {
  const { pillar, subPillar } = endpointFor(base.slug);
  const data = await api.get<LiveSubPillarData>(`/audits/latest/${pillar}/${subPillar}`);

  return {
    ...base,
    summary: data.summary,
    healthChip: data.healthChip,
    totals: {
      ...base.totals,
      score: data.totals.score,
      analyzed: data.totals.analyzed,
      healthy: data.totals.healthy,
      issues: data.totals.issues,
      critical: countForLabel(base.totals.criticalLabel, data.findings, data.totals.critical),
      contextLabel: data.totals.contextLabel,
      contextValue: data.totals.contextValue,
      issueUnits: data.totals.issueUnits ?? null,
    },
    titleSuffix: data.titleSuffix ?? null,
    findings: data.findings,
    evidence: {
      ...base.evidence,
      rows: data.evidenceRows,
      healthyStatus: data.healthyStatus,
      sorts: [sortBySeverity(data.findings, data.healthyStatus), ...base.evidence.sorts],
    },
    lastAnalyzed: formatLastAnalyzed(data.lastAnalyzed),
    status: data.status ?? 'ok',
    unavailableReason: data.unavailableReason ?? null,
    requiredScope: data.requiredScope ?? null,
    source: data.source ?? 'engine',
  };
}
