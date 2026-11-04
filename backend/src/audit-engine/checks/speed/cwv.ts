import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { PageSpeedReport, StoreSnapshot } from '../../store-data/types.js';

/**
 * ─── Speed · Core Web Vitals ─────────────────────────────────────────
 * LCP, INP and CLS are RENDER-TIME measurements: they only exist inside a real browser loading
 * the real public page. Nothing in the Admin API approximates them, and deriving them from
 * catalogue data would be exactly the kind of invented score this engine exists to prevent.
 *
 * They therefore come from Google's PageSpeed Insights API, run by the connector on the
 * Integrations page and read from the snapshot here (see store-data/index.ts). This check does no
 * fetching of its own and remains a pure function of a snapshot.
 *
 * ─── Field first, lab second, and never silently ─────────────────────
 *
 *   FIELD (CrUX)  What real visitors experienced over Google's trailing 28-day window. This is
 *                 what Core Web Vitals ARE and what Search ranks on. Google's own rating for each
 *                 metric is used rather than re-derived, so Rankvora AI and Search Console agree.
 *
 *   LAB           One Lighthouse run on an emulated mid-range phone over a throttled connection.
 *                 Used only where there is no field data — a new or quiet store has none, which
 *                 is a fact about sample size, not about speed. Every lab row SAYS it is lab, and
 *                 the summary says so too.
 *
 * INP IS NEVER FAKED. It cannot be measured in a lab, because it needs a real person clicking.
 * Where there is no field data there is no INP row at all — Lighthouse's Total Blocking Time is a
 * different quantity and is reported under its own name, never as INP.
 */

/** Google's published Core Web Vitals thresholds. Used only for LAB values — a field metric
 * carries Google's own rating, which is the one Search Console shows. */
const THRESHOLDS = {
  lcp: { good: 2_500, poor: 4_000 },
  cls: { good: 0.1, poor: 0.25 },
} as const;

const GOOD = 'Good';
const NEEDS_IMPROVEMENT = 'Needs Improvement';
const POOR = 'Poor';

type Rating = 'good' | 'needs-improvement' | 'poor';

const STATUS_OF: Record<Rating, string> = {
  good: GOOD,
  'needs-improvement': NEEDS_IMPROVEMENT,
  poor: POOR,
};

/** A measurement older than this is still real, but it is old enough that the summary says so. */
const STALE_AFTER_DAYS = 14;

interface Observation {
  metric: 'LCP' | 'INP' | 'CLS';
  strategy: PageSpeedReport['strategy'];
  /** Where the number came from. Shown on every row — the two are not interchangeable. */
  source: 'field' | 'lab';
  value: number;
  display: string;
  rating: Rating;
  /** The url the measurement describes, or the origin when CrUX fell back to it. */
  url: string;
  /** Set when CrUX had too little data for the url itself and reported the whole origin. */
  originScope: boolean;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function ratingFor(value: number, thresholds: { good: number; poor: number }): Rating {
  if (value <= thresholds.good) return 'good';
  if (value <= thresholds.poor) return 'needs-improvement';
  return 'poor';
}

/** Google's rating for a Largest Contentful Paint in milliseconds — the one the audit uses for lab runs. */
export function lcpRating(milliseconds: number): Rating {
  return ratingFor(milliseconds, THRESHOLDS.lcp);
}

/**
 * Every Core Web Vital this report actually established, as rows.
 *
 * A metric Google did not return produces NO row. An absent measurement is not a passing one, and
 * padding the set to a fixed three per device would put invented values into the score.
 */
function observationsFrom(report: PageSpeedReport): Observation[] {
  const url = report.finalUrl ?? report.requestedUrl;
  const observations: Observation[] = [];
  const field = report.field;

  if (field) {
    const originScope = field.scope === 'origin';
    if (field.lcp) {
      observations.push({ metric: 'LCP', strategy: report.strategy, source: 'field', value: field.lcp.p75, display: seconds(field.lcp.p75), rating: field.lcp.rating, url, originScope });
    }
    if (field.inp) {
      observations.push({ metric: 'INP', strategy: report.strategy, source: 'field', value: field.inp.p75, display: `${Math.round(field.inp.p75)} ms`, rating: field.inp.rating, url, originScope });
    }
    if (field.cls) {
      observations.push({ metric: 'CLS', strategy: report.strategy, source: 'field', value: field.cls.p75, display: field.cls.p75.toFixed(3), rating: field.cls.rating, url, originScope });
    }
  }

  // Lab fills in only what field data did not establish, so a store with real-user data is never
  // scored on an emulated phone alongside it. INP is deliberately absent: there is no lab INP.
  const measured = new Set(observations.map((observation) => observation.metric));
  if (!measured.has('LCP') && report.lab.lcpMs !== null) {
    observations.push({ metric: 'LCP', strategy: report.strategy, source: 'lab', value: report.lab.lcpMs, display: seconds(report.lab.lcpMs), rating: ratingFor(report.lab.lcpMs, THRESHOLDS.lcp), url, originScope: false });
  }
  if (!measured.has('CLS') && report.lab.cls !== null) {
    observations.push({ metric: 'CLS', strategy: report.strategy, source: 'lab', value: report.lab.cls, display: report.lab.cls.toFixed(3), rating: ratingFor(report.lab.cls, THRESHOLDS.cls), url, originScope: false });
  }

  return observations;
}

const DEVICE: Record<PageSpeedReport['strategy'], string> = { mobile: 'Mobile', desktop: 'Desktop' };

/** What to do about each vital, in terms that apply to a Shopify storefront. */
const REMEDY: Record<Observation['metric'], { why: string; recommendation: string }> = {
  LCP: {
    why: 'Largest Contentful Paint is how long a visitor waits before the main thing on the page — usually the hero or the product photo — is actually there. It is a Core Web Vital, so Search uses it, and it is the metric shoppers feel as "this store is slow".',
    recommendation: 'Serve the hero and first product image at the size it is displayed, let it load eagerly rather than lazily, and cut render-blocking CSS and fonts above the fold. The measurement below lists what Lighthouse costed on your own pages.',
  },
  INP: {
    why: 'Interaction to Next Paint is how long the page takes to respond after a real visitor taps something — add to cart, open a variant, expand a menu. It replaced First Input Delay as a Core Web Vital, and it is measured from real interactions, so it reflects what your customers actually hit.',
    recommendation: 'Reduce the JavaScript running on the main thread while shoppers interact: remove apps whose scripts load on every page, defer anything not needed for the first interaction, and split long tasks. Total Blocking Time in the lab result points at the same scripts.',
  },
  CLS: {
    why: 'Cumulative Layout Shift measures content jumping while the page loads. It is a Core Web Vital, and on a storefront it is the reason a shopper taps the wrong thing — a price or a button moving as an image or a banner arrives late.',
    recommendation: 'Give images and embeds explicit width and height (or a reserved aspect-ratio box), reserve space for banners and app widgets injected after load, and preload webfonts so text does not reflow when they swap in.',
  },
};

const SEVERITY_OF: Record<Exclude<Rating, 'good'>, SubPillarFindingResult['severity']> = {
  poor: 'high',
  'needs-improvement': 'medium',
};

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function formatMeasuredAt(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export const cwvCheck: AuditCheck = {
  id: 'speed.cwv',
  pillar: 'speed',
  subPillar: 'cwv',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    // Password gating is the more specific, merchant-actionable reason — report it first. A gated
    // storefront serves its password screen to Google too, which is why the connector refuses to
    // store that run at all rather than reporting the screen's excellent scores as the store's.
    if (snapshot.storefront?.passwordProtected) {
      return unavailableResult(
        'cwv',
        'Core Web Vitals are measured by loading your live storefront in a browser, and your storefront is currently password-protected — every page redirects to the password screen. Remove the storefront password (Shopify admin → Online Store → Preferences) to enable this measurement.',
      );
    }

    // Absent on snapshots built before PageSpeed existed. "Not looked at" is not "not measured".
    if (!snapshot.pageSpeed) {
      return unavailableResult('cwv', 'This audit ran before Rankvora AI could read PageSpeed measurements. Run a new audit to include Core Web Vitals.');
    }

    const { reports, lastError } = snapshot.pageSpeed;

    if (reports.length === 0) {
      return unavailableResult(
        'cwv',
        lastError
          ? `Core Web Vitals could not be measured. ${lastError}`
          : 'Core Web Vitals have not been measured yet. Run a PageSpeed measurement from Integrations → PageSpeed Insights, then run this audit again. Nothing is estimated in its place.',
      );
    }

    const observations = reports.flatMap(observationsFrom);
    if (observations.length === 0) {
      return unavailableResult(
        'cwv',
        'Google completed a PageSpeed run on your storefront but returned none of the Core Web Vitals for it. Run the measurement again from Integrations → PageSpeed Insights.',
      );
    }

    const rows: SubPillarEvidenceRow[] = observations.map((observation): SubPillarEvidenceRow => ({
      id: `${observation.strategy}:${observation.metric}`,
      status: STATUS_OF[observation.rating],
      facet: STATUS_OF[observation.rating],
      cells: {
        metric: observation.metric,
        device: DEVICE[observation.strategy],
        source: observation.source === 'field' ? 'Real visitors' : 'Lab test',
        value: observation.display,
        url: observation.url,
      },
      current: {
        label: `${observation.metric} · ${DEVICE[observation.strategy]}`,
        value: observation.display,
        meta: observation.source === 'field'
          ? `Real visitors, 75th percentile${observation.originScope ? ' · whole domain' : ''}`
          : 'Lighthouse lab test on an emulated phone',
      },
      note: observation.source === 'field'
        ? (observation.originScope
          // Said on the row, because it changes what the number is about.
          ? 'Google had too few visits to this exact page, so this is the figure for your whole domain.'
          : 'Measured from real Chrome visits to this page over the last 28 days.')
        : 'No real-visitor data for this page yet, so this is Google’s lab measurement. It is deliberately pessimistic and does not describe any real visit.',
    }));

    const healthy = observations.filter((observation) => observation.rating === 'good').length;
    const analyzed = observations.length;

    // One finding per failing metric, not per row: LCP failing on mobile and desktop is one
    // problem with two measurements, and splitting it would double-count it in the Fix Center.
    const findings: SubPillarFindingResult[] = [];
    for (const metric of ['LCP', 'INP', 'CLS'] as const) {
      const failing = observations.filter((observation) => observation.metric === metric && observation.rating !== 'good');
      if (failing.length === 0) continue;

      const worst = failing.some((observation) => observation.rating === 'poor') ? 'poor' : 'needs-improvement';
      const onField = failing.some((observation) => observation.source === 'field');
      const where = failing.map((observation) => `${DEVICE[observation.strategy]} ${observation.display}`).join(', ');

      findings.push({
        title: `${metric} is ${worst === 'poor' ? 'failing' : 'below Google’s "good" threshold'}`,
        severity: SEVERITY_OF[worst],
        affectedCount: failing.length,
        affectedLabel: failing.length === 1 ? 'measurement' : 'measurements',
        scoreLift: Math.round((failing.length / analyzed) * 100),
        // Theme and app work, which classifyFixability() correctly reports as manual: there is no
        // field on a Shopify record that makes a page render faster, and offering to write one
        // would be a promise Rankvora AI cannot keep.
        resolutionType: 'theme',
        problem: `${metric} measured ${where} on ${observations.find((o) => o.metric === metric)?.url ?? 'your storefront'}.`,
        why: REMEDY[metric].why,
        recommendation: REMEDY[metric].recommendation,
        evidence: [
          ...failing.map((observation) =>
            `${DEVICE[observation.strategy]}: ${observation.display} (${STATUS_OF[observation.rating]}) — ${observation.source === 'field' ? `real visitors${observation.originScope ? ', whole domain' : ''}` : 'Lighthouse lab test'}.`),
          onField
            ? 'Real-visitor data is what Google Search uses to judge page experience.'
            : 'This store has no real-visitor data for this metric yet, so the figure above is a lab measurement.',
        ],
        details: { issueType: STATUS_OF[worst] },
      });
    }

    const newest = reports.reduce((latest, report) => (report.fetchedAt > latest ? report.fetchedAt : latest), reports[0].fetchedAt);
    const age = daysSince(newest);
    const anyField = observations.some((observation) => observation.source === 'field');
    const scores = reports
      .filter((report): report is PageSpeedReport & { performanceScore: number } => report.performanceScore !== null)
      .map((report) => `${DEVICE[report.strategy]} ${report.performanceScore}`);

    return {
      subPillar: 'cwv',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary:
          `${healthy} of ${analyzed} Core Web Vitals measurements are in Google's "good" band. `
          + (anyField
            ? 'Measured from real Chrome visits over the last 28 days, with Google’s lab test filling in the metrics that have no real-visitor data yet. '
            : 'Measured by Google’s Lighthouse lab test — this store has no real-visitor data yet, so no INP is reported, because INP cannot be measured without real interactions. ')
          + `Taken ${formatMeasuredAt(newest)}${age >= STALE_AFTER_DAYS ? `, ${age} days ago — re-run the measurement from Integrations for a current reading` : ''}.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'PageSpeed score',
        // Google's own performance score, quoted as it gave it. '—' when it returned none, never 0.
        contextValue: scores.length > 0 ? scores.join(' · ') : '—',
        healthyStatus: GOOD,
        evidenceRows: rows,
      },
      findings,
    };
  },
};
