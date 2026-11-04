import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';

/**
 * ─── Content · Metafield completeness ────────────────────────────────
 * Measures, for every metafield the store actually uses, how much of the catalog fills it in.
 *
 * THE UNIT HERE IS THE METAFIELD, NOT THE PRODUCT — which is unlike every other check so far, and
 * is dictated by the UI: contentTables.ts declares columns `field / label / category / applicable
 * / missing / coverage / status`, i.e. one row per metafield definition with a coverage figure.
 * So `analyzedCount` is the number of distinct metafield keys in use, and a key is "healthy" when
 * its coverage clears the completeness bar.
 *
 * WHY DEFINITIONS ARE INFERRED FROM USAGE
 * The snapshot carries each product's metafields but not the shop's metafield DEFINITIONS (that
 * is a separate Admin API resource the provider does not fetch). So "which metafields should this
 * catalog have?" is answered empirically: any namespace.key present on at least one product is
 * treated as a field the store intends to use, and coverage is measured against the whole catalog.
 *
 * The honest consequence: a metafield defined in Shopify but filled in on ZERO products is
 * invisible to this check — it cannot be distinguished from a field that does not exist. That is
 * stated in the summary rather than papered over.
 *
 * BANDS (status vocabulary matches contentTables.ts):
 *   coverage < 50%   Critical Gap
 *   coverage < 90%   Gap
 *   coverage ≥ 90%   Complete
 */

const COMPLETE_MIN_COVERAGE = 90;
const CRITICAL_MAX_COVERAGE = 50;

const COMPLETE = 'Complete';
const GAP = 'Gap';
const CRITICAL_GAP = 'Critical Gap';

export const metafieldsCheck: AuditCheck = {
  id: 'content.metafields',
  pillar: 'content',
  subPillar: 'metafields',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('metafields', 'Rankvora AI could not read products from this store, so metafield coverage could not be checked.');
    }
    // metafieldsAvailable false means the provider could not read metafields — an empty array is
    // then "unknown", not "none". Scoring that as 0% coverage would invent a failure.
    if (!snapshot.coverage.metafields) {
      return unavailableResult('metafields', 'Metafields could not be read for this store, so coverage is unknown.');
    }

    const products = snapshot.products.filter((product) => product.metafieldsAvailable);
    if (products.length === 0) {
      return unavailableResult('metafields', 'No product returned readable metafield data, so coverage could not be measured.');
    }

    // key -> how many products carry a non-empty value for it
    const filled = new Map<string, number>();
    for (const product of products) {
      for (const metafield of product.metafields) {
        const key = `${metafield.namespace}.${metafield.key}`;
        if (!filled.has(key)) filled.set(key, 0);
        if (metafield.hasValue) filled.set(key, (filled.get(key) ?? 0) + 1);
      }
    }

    if (filled.size === 0) {
      return unavailableResult(
        'metafields',
        'This store uses no product metafields, so there is nothing to measure. Metafields defined in Shopify but never filled in are not visible through this data source.',
      );
    }

    const applicable = products.length;
    const counts: Record<string, number> = { [COMPLETE]: 0, [GAP]: 0, [CRITICAL_GAP]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let totalCoverage = 0;

    // Worst coverage first — the merchant should see the biggest gap without sorting.
    const ordered = [...filled.entries()].sort((a, b) => a[1] - b[1]);

    for (const [key, present] of ordered) {
      const coverage = Math.round((present / applicable) * 100);
      totalCoverage += coverage;
      const status = coverage >= COMPLETE_MIN_COVERAGE ? COMPLETE : coverage < CRITICAL_MAX_COVERAGE ? CRITICAL_GAP : GAP;
      counts[status] += 1;

      const [namespace, ...rest] = key.split('.');
      rows.push({
        id: `metafield:${key}`,
        status,
        facet: status,
        cells: {
          field: key,
          label: rest.join('.'),
          category: namespace,
          applicable,
          missing: applicable - present,
          coverage,
          recommendation:
            status === COMPLETE ? '—' : `Fill this field on the remaining ${formatCount(applicable - present)} products.`,
        },
        current: { label: 'Coverage', value: `${coverage}%`, meta: `${formatCount(present)} of ${formatCount(applicable)} products` },
      });
    }

    const analyzed = filled.size;
    const healthy = counts[COMPLETE];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[CRITICAL_GAP] > 0) {
      findings.push({
        title: 'Metafields filled in on under half the catalog',
        severity: 'high',
        affectedCount: counts[CRITICAL_GAP],
        affectedLabel: 'metafields',
        scoreLift: lift(counts[CRITICAL_GAP]),
        resolutionType: 'content',
        problem: `${formatCount(counts[CRITICAL_GAP])} metafields are populated on fewer than ${CRITICAL_MAX_COVERAGE}% of products.`,
        why: 'A field the store clearly intends to use but mostly leaves blank cannot be relied on by themes, filters, feeds or AI shopping surfaces — anything built on it will be inconsistent.',
        recommendation: 'Either backfill these fields across the catalog or retire the ones no longer needed.',
        evidence: [`${formatCount(counts[CRITICAL_GAP])} of ${formatCount(analyzed)} metafields in use are under ${CRITICAL_MAX_COVERAGE}% coverage.`],
        details: { issueType: CRITICAL_GAP },
      });
    }

    if (counts[GAP] > 0) {
      findings.push({
        title: 'Metafields with incomplete coverage',
        severity: 'low',
        affectedCount: counts[GAP],
        affectedLabel: 'metafields',
        scoreLift: lift(counts[GAP]),
        resolutionType: 'content',
        problem: `${formatCount(counts[GAP])} metafields sit between ${CRITICAL_MAX_COVERAGE}% and ${COMPLETE_MIN_COVERAGE}% coverage.`,
        why: 'Mostly-populated fields are the risky kind: they look dependable, so themes and feeds get built on them, and then break on the products that are missing a value.',
        recommendation: `Backfill the remainder to clear ${COMPLETE_MIN_COVERAGE}%.`,
        evidence: [`${formatCount(counts[GAP])} of ${formatCount(analyzed)} metafields are partially populated.`],
        details: { issueType: GAP },
      });
    }

    return {
      subPillar: 'metafields',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} metafields in use are populated on at least ${COMPLETE_MIN_COVERAGE}% of ${formatCount(applicable)} products. Fields defined in Shopify but never filled in anywhere are not visible to this check.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Average coverage',
        contextValue: `${Math.round(totalCoverage / analyzed)}%`,
        healthyStatus: COMPLETE,
        evidenceRows: takeEvidenceSample(rows, COMPLETE),
      },
      findings,
    };
  },
};
