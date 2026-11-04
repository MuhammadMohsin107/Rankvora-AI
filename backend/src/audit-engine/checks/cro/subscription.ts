import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { HEALTHY, NEEDS_WORK } from '../shared/status.js';

/**
 * ─── CRO · Subscription opportunity ──────────────────────────────────
 * Measures how consistently a store's EXISTING subscription programme is applied across the
 * catalogue, using each product's real `sellingPlanGroupCount` from the Admin API.
 *
 * THIS CHECK REFUSES TO INVENT A FAILURE. Most stores do not sell subscriptions, and they are
 * right not to — a one-off fashion purchase has no recurring form. Scoring every product as
 * unhealthy for lacking a selling plan would manufacture a catalogue-wide defect out of a
 * deliberate business decision, and would drag the CRO pillar score down for a store with
 * nothing wrong with it. So:
 *
 *   No selling plans anywhere  ->  'unavailable', with a reason that says there is no programme
 *                                  to audit. Excluded from the pillar average (scoring.ts), never
 *                                  rendered as a zero.
 *   Some products enrolled     ->  measured. The unit is the product, healthy means enrolled, and
 *                                  the finding is about the products left out of a programme the
 *                                  merchant has already decided they want.
 *
 * The second case is the one worth flagging: a store that set up subscriptions and then enrolled
 * a third of the eligible catalogue is leaking recurring revenue on the rest, and the gap is
 * usually invisible because nothing in the admin lists what was skipped.
 *
 * WHAT THIS CANNOT SEE
 * Whether the theme actually renders a subscribe-and-save widget on the product page, and what
 * discount each plan offers — the first needs the storefront crawl, the second needs the selling
 * plan detail this check does not fetch. It measures enrolment, and says so.
 */

export const subscriptionCheck: AuditCheck = {
  id: 'cro.subscription',
  pillar: 'cro',
  subPillar: 'subscription',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('subscription', 'Rankvora AI could not read products from this store, so subscription coverage could not be checked.');
    }

    if (snapshot.products.length === 0) {
      return unavailableResult('subscription', 'This store has no products, so there is no subscription coverage to measure.');
    }

    // Only products whose selling-plan membership Shopify actually reported. An unreported count
    // is unknown — it is neither enrolled nor missing, so it is left out of both.
    const products = snapshot.products.filter(
      (product): product is typeof product & { sellingPlanGroupCount: number } => product.sellingPlanGroupCount !== null,
    );
    if (products.length === 0) {
      return unavailableResult('subscription', 'Shopify did not report selling-plan membership for any product, so subscription coverage could not be measured.');
    }

    const enrolled = products.filter((product) => product.sellingPlanGroupCount > 0);

    // No programme exists. Not a defect, and deliberately not scored — see the header.
    if (enrolled.length === 0) {
      return unavailableResult(
        'subscription',
        `No product in this store belongs to a selling plan, so there is no subscription programme to measure. Rankvora AI does not score this as a failure — subscriptions are a business decision, not a defect. Set one up in Shopify and this check will start measuring how consistently it is applied across your ${formatCount(products.length)} products.`,
      );
    }

    // Only products the merchant plausibly meant to include are judged. Enrolment tends to follow
    // product type — a store selling coffee subscriptions and one-off mugs should not be marked
    // down for the mugs — so a type with zero enrolled products is treated as out of scope.
    const typesWithPlans = new Set(enrolled.map((product) => product.productType.trim().toLowerCase()).filter(Boolean));
    const inScope = products.filter((product) => {
      const type = product.productType.trim().toLowerCase();
      // Untyped products are only in scope when the store's whole programme is untyped too,
      // otherwise every uncategorised product would be dragged into every programme.
      if (!type) return typesWithPlans.size === 0 || typesWithPlans.has('');
      return typesWithPlans.has(type);
    });

    const scoped = inScope.length > 0 ? inScope : enrolled;
    const missing = scoped.filter((product) => product.sellingPlanGroupCount === 0);
    const healthy = scoped.length - missing.length;

    const rows: SubPillarEvidenceRow[] = scoped.map((product) => {
      const isEnrolled = product.sellingPlanGroupCount > 0;
      const status = isEnrolled ? HEALTHY : NEEDS_WORK;
      return {
        id: `product:${product.id}`,
        status,
        facet: status,
        cells: {
          surface: product.title,
          signal: isEnrolled
            ? `${formatCount(product.sellingPlanGroupCount)} selling plan ${product.sellingPlanGroupCount === 1 ? 'group' : 'groups'}`
            : 'No selling plan',
          coverage: isEnrolled ? 100 : 0,
          status,
          recommendation: isEnrolled ? '—' : 'Add this product to the existing selling plan group.',
        },
        current: {
          label: 'Detected',
          value: isEnrolled ? 'Enrolled in a subscription plan' : 'Not enrolled',
          meta: product.productType || 'No product type',
        },
        suggested: {
          label: 'Recommendation',
          value: isEnrolled ? 'No change needed.' : 'Add this product to the existing selling plan group.',
        },
      };
    });

    const findings: SubPillarFindingResult[] = [];

    if (missing.length > 0) {
      const types = [...new Set(missing.map((product) => product.productType).filter(Boolean))].slice(0, 4);
      findings.push({
        title: 'Products left out of an existing subscription programme',
        severity: missing.length > scoped.length / 2 ? 'medium' : 'low',
        affectedCount: missing.length,
        affectedLabel: 'products',
        scoreLift: Math.round((missing.length / scoped.length) * 100),
        resolutionType: 'catalog',
        problem: `${formatCount(missing.length)} products of the same type as your subscription products are not enrolled in any selling plan.`,
        why: 'You already decided subscriptions belong in this part of the catalogue and built the plan. Every comparable product left out is a repeat purchase the shopper has to remember to make themselves — which most do not.',
        recommendation: `Add the remaining ${formatCount(missing.length)} products to your existing selling plan group in Shopify, or narrow the programme deliberately if they were excluded on purpose.`,
        evidence: [
          `${formatCount(enrolled.length)} of ${formatCount(products.length)} products across the store are enrolled in a selling plan.`,
          `Within the product types that have a plan${types.length > 0 ? ` (${types.join(', ')})` : ''}, ${formatCount(missing.length)} of ${formatCount(scoped.length)} are not enrolled.`,
          ...missing.slice(0, 5).map((product) => `${product.title}: no selling plan.`),
        ],
        evidenceRows: rows.filter((row) => row.status === NEEDS_WORK).slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    return {
      subPillar: 'subscription',
      status: 'ok',
      score: scoreSubPillar(scoped.length, healthy, findings),
      analyzedCount: scoped.length,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(scoped.length)} products in the product types you already sell on subscription are enrolled in a selling plan (${formatCount(enrolled.length)} enrolled across the whole ${formatCount(products.length)}-product catalogue). Whether your theme shows a subscribe option needs the storefront crawl, which Rankvora AI does not run yet.`,
        healthChip: `${((healthy / scoped.length) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Enrolled catalogue-wide',
        contextValue: `${formatCount(enrolled.length)} of ${formatCount(products.length)}`,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
