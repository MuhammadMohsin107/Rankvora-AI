// ─── Real data for the five pillar dashboards (/seo, /content, /speed, /cro, /ai-discovery) ──
//
// These pages previously rendered hard-coded scores from *.mock.ts and made no network call at
// all, so every number on them was invented. This repository is the replacement: one generic
// fetch that works for any pillar, because the API already exposes the same shape for each.
//
// Sub-pillar labels and route slugs still come from pillarMeta — those are navigation structure,
// not measurements, and stay a frontend catalog. Every NUMBER here comes from the database.

import { api, ApiError } from '../../lib/api';
import type { AuditRow, AuditScoreRow, FindingRow, StoreRow } from '../api.types';
import { isMeasuredScore } from '../api.types';
import type { PillarKey } from '../dashboard/dashboard.types';
import { pillarMeta } from '../pillarMeta';
import { fetchFindingRows, isOutstandingStoreIssue } from '../findings.repository';

/** Thrown-through so callers can tell "no audit yet" from a genuine failure. AUDIT_STALE_STORE is
 * the same truth after a different shop is connected: the audits on file describe another store. */
export const NO_AUDIT_CODES = ['AUDIT_NOT_FOUND', 'AUDITS_NOT_FOUND', 'AUDIT_STALE_STORE'];

export interface PillarArea {
  id: string;
  label: string;
  route: string;
  /** null when the check could not measure this sub-pillar — render "not measured", never 0. */
  score: number | null;
  analyzedCount: number | null;
  healthyCount: number | null;
  issueCount: number | null;
}

export interface PillarIssue {
  id: string;
  title: string;
  severity: FindingRow['severity'];
  subPillarLabel: string;
  route: string;
  affectedCount: number;
  affectedLabel: string;
}

export interface PillarDashboardData {
  storeName: string;
  storeUrl: string;
  lastAnalyzed: string;
  /** null when nothing in this pillar could be measured — the UI must not substitute 0. */
  overallScore: number | null;
  areas: PillarArea[];
  issues: PillarIssue[];
  counts: { critical: number; high: number; medium: number; low: number };
  /** 'seed' marks demo fixtures; the UI labels them so they are never passed off as a real audit. */
  source: string;
}

interface LatestAuditResponse {
  audit: AuditRow & { source?: string };
  scores: AuditScoreRow[];
}

/**
 * Loads one pillar's dashboard from the API.
 *
 * Throws `ApiError` with code AUDIT_NOT_FOUND when the store has never been audited — callers
 * render an empty state rather than inventing numbers to fill the layout.
 */
export async function fetchPillarDashboard(pillar: PillarKey): Promise<PillarDashboardData> {
  const [latest, findingRows, store] = await Promise.all([
    api.get<LatestAuditResponse>(`/audits/latest?pillar=${pillar}`),
    // Every page, not one `limit=100` request: a pillar with more findings than that lost the
    // rest from its issue list and its severity counts with nothing on screen to say so.
    fetchFindingRows({ pillar }),
    api.get<StoreRow>('/stores/current'),
  ]);

  const meta = pillarMeta[pillar];
  const bySubPillar = new Map(latest.scores.filter((s) => s.subPillar).map((s) => [s.subPillar as string, s]));
  const pillarRow = latest.scores.find((s) => s.subPillar === null) ?? null;

  // Driven by the catalog, not by what the audit returned, so a sub-pillar the engine did not
  // reach still appears — as "not measured" rather than silently vanishing from the page.
  const areas: PillarArea[] = meta.subPillars.map((sub) => {
    const row = bySubPillar.get(sub.id);
    // A row whose details say 'unavailable' carries a placeholder zero, not a score — treat it
    // exactly like a sub-pillar the engine never reached, so the card reads "Not measured"
    // instead of a fabricated 0. (A store with no blog articles is the common case.)
    const measured = row ? isMeasuredScore(row) : false;
    const analyzed = measured ? row?.analyzedCount ?? null : null;
    const healthy = measured ? row?.healthyCount ?? null : null;
    return {
      id: sub.id,
      label: sub.label,
      route: `/${pillar}/${sub.id}`,
      score: measured && row ? row.score : null,
      analyzedCount: analyzed,
      healthyCount: healthy,
      issueCount: analyzed !== null && healthy !== null ? analyzed - healthy : null,
    };
  });

  const labelFor = new Map(meta.subPillars.map((s) => [s.id, s.label]));
  // Outstanding problems found in the store only. The list used to include findings the merchant
  // had already resolved or ignored, and counted them in the severity totals as open issues.
  const issues: PillarIssue[] = findingRows.filter(isOutstandingStoreIssue).map((finding) => ({
    id: String(finding.id),
    title: finding.title,
    severity: finding.severity,
    subPillarLabel: labelFor.get(finding.subPillar) ?? finding.subPillar,
    route: `/${pillar}/${finding.subPillar}`,
    affectedCount: finding.affectedCount,
    affectedLabel: finding.affectedLabel,
  }));

  const countBy = (severity: FindingRow['severity']) => issues.filter((i) => i.severity === severity).length;

  return {
    storeName: store.name,
    storeUrl: store.url,
    lastAnalyzed: latest.audit.runAt,
    // A pillar row marked 'unavailable' carries the engine's NOT-NULL placeholder zero; showing it
    // would put "0" in the pillar's score ring for a pillar nothing could measure.
    overallScore: pillarRow && isMeasuredScore(pillarRow) ? pillarRow.score : null,
    areas,
    issues,
    counts: { critical: countBy('critical'), high: countBy('high'), medium: countBy('medium'), low: countBy('low') },
    source: latest.audit.source ?? 'engine',
  };
}

/** True when the failure means "this store has not been audited yet", not "something broke". */
export function isNoAuditError(error: unknown): boolean {
  return error instanceof ApiError && NO_AUDIT_CODES.includes(error.code ?? '');
}
