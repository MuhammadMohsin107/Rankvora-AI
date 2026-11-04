import type { SubPillarFindingResult, SubPillarResult, Severity } from './types.js';

// ─── Rankvora AI score engine ────────────────────────────────────────────
// ONE scoring mechanism for the whole product. Individual checks report facts
// (how many resources were analyzed, how many were healthy, what findings resulted)
// and this module — and only this module — turns facts into scores.
//
//   raw check results        analyzed / healthy counts + findings
//          ↓
//   severity cap             worst finding severity bounds the score
//          ↓
//   sub-pillar score         round(healthy / analyzed * 100), then capped
//          ↓
//   pillar score             mean of that pillar's MEASURED sub-pillar scores
//          ↓
//   overall score            mean of MEASURED pillar scores
//
// Properties: deterministic (no randomness/time), bounded (always 0-100),
// explainable (every number traces to counts + findings), testable (pure functions).
//
// Sub-pillars whose status is 'unavailable' are EXCLUDED from every average rather
// than counted as 0. Counting them as 0 would invent a bad score out of missing data;
// excluding them keeps "not measured" honestly separate from "measured and failing".

/** Cap applied when a finding of this severity is present. Prevents a store with a
 * critical defect from showing a reassuring score just because most resources passed. */
const SEVERITY_CAP: Record<Severity, number> = {
  critical: 60,
  high: 80,
  medium: 95,
  low: 100,
};

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export function worstSeverity(findings: SubPillarFindingResult[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((finding) => finding.severity === severity)) return severity;
  }
  return null;
}

/**
 * Sub-pillar score from measured facts.
 * `analyzed === 0` means there was nothing of this resource type to check (e.g. a store with
 * no blog articles) — that is a legitimate 100, distinct from `unavailable`, which callers
 * must express via unavailableResult() instead of calling this.
 */
export function scoreSubPillar(analyzed: number, healthy: number, findings: SubPillarFindingResult[]): number {
  if (analyzed <= 0) return 100;
  const bounded = Math.max(0, Math.min(healthy, analyzed));
  const raw = Math.round((bounded / analyzed) * 100);
  const severity = worstSeverity(findings);
  const cap = severity ? SEVERITY_CAP[severity] : 100;
  return Math.max(0, Math.min(100, Math.min(raw, cap)));
}

/** Mean of measured sub-pillar scores. Returns null when nothing in the pillar was measurable,
 * so the caller can persist "unavailable" rather than a fabricated zero. */
export function scorePillar(subPillarResults: SubPillarResult[]): number | null {
  const measured = subPillarResults.filter((result) => result.status === 'ok');
  if (measured.length === 0) return null;
  const total = measured.reduce((sum, result) => sum + result.score, 0);
  return Math.round(total / measured.length);
}

/** Mean of measured pillar scores. Null when no pillar produced a measurable result. */
export function scoreOverall(pillarScores: Array<number | null>): number | null {
  const measured = pillarScores.filter((score): score is number => score !== null);
  if (measured.length === 0) return null;
  const total = measured.reduce((sum, score) => sum + score, 0);
  return Math.round(total / measured.length);
}
