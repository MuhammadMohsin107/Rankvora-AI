import type { GenericSubPillarConfig, GenericSubPillarDetails } from './genericTypes';

/**
 * ─── Presentation config for a sub-pillar whose numbers come from the API ───
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a pillar catalog describes what a sub-pillar MEASURES.
 * It never carries what a sub-pillar FOUND.
 *
 * `fetchSubPillarAnalysis` (data/seo/subpillar.repository.ts) replaces score, analyzed, healthy,
 * issues, critical, summary, healthChip, findings, evidence rows and lastAnalyzed with what the
 * audit actually produced, and the page renders a skeleton until that lands. So every numeric
 * field here is zero and every list is empty.
 *
 * They were previously derived from per-pillar mock files — a store with 1,342 pages analysed, 318
 * products missing FAQs, $48,000 of cart-recovery opportunity. None of it was ever displayed, and
 * that is exactly what made it dangerous: nothing about reading those files told you the figures
 * were fictional, and one changed line in the repository would have put them on screen as
 * measurements. A zero cannot be mistaken for a measurement; a plausible number can.
 *
 * A store with no audit yet gets the page's empty state. That is the honest answer.
 */

const good = 'bg-success-100 text-success-700';
const warn = 'bg-warning-100 text-warning-700';
const bad = 'bg-critical-100 text-critical-700';

export function liveOnlyConfig(
  pillar: string,
  pillarLabel: string,
  key: string,
  title: string,
  description: string,
  analyzedLabel: string,
): GenericSubPillarConfig {
  return {
    pillar,
    pillarLabel,
    key,
    title,
    description,
    // Replaced by the audit. `statusLabel` is blank rather than the band a score of 0 would fall
    // into — "Critical" for a store that has simply not been audited would be a lie of omission.
    score: 0,
    statusLabel: '',
    analyzedLabel,
    analyzed: 0,
    healthy: 0,
    metrics: [],
    breakdown: [],
    issues: [],
  };
}

/**
 * Evidence-table config: column definitions and an opportunity card, never rows.
 *
 * `rows: []` is load-bearing — the repository replaces the row list wholesale, so any row written
 * here would describe a resource that does not exist and would never reach the screen anyway.
 */
export function liveOnlyDetails(
  title: string,
  subtitle: string,
  searchPlaceholder: string,
  signalHeader: string,
  opportunity: { title: string; description: string },
): GenericSubPillarDetails {
  return {
    table: {
      title,
      subtitle,
      searchPlaceholder,
      filters: ['All', 'Critical', 'Needs Work', 'Healthy'],
      statusClass: { Critical: bad, 'Needs Work': warn, Healthy: good },
      columns: [
        { key: 'signal', header: signalHeader },
        { key: 'detail', header: 'Detail', variant: 'muted' },
        { key: 'coverage', header: 'Coverage', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [
      {
        id: 'critical-1',
        title: opportunity.title,
        description: opportunity.description,
        // No impact or effort rating: both were typed in here, 'High' and 'Low' for every CRO
        // sub-pillar whatever its audit found. Nothing measured either one.
        ctaLabel: 'Review Signals',
        filter: 'Critical',
      },
    ],
  };
}
