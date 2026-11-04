import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { SnapshotProduct, StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, isDefaultOption, type RowStatus } from '../shared/status.js';

/**
 * ─── CRO · Product options and add-ons ───────────────────────────────
 * Checks the variant structure the merchant configured, from the Admin API.
 *
 * The question this answers is not "does this product have options" — it is "can a shopper tell
 * the choices apart and pick one". Two structures fail that test, and both are invisible in the
 * admin because each product looks fine on its own:
 *
 *   1. A product with several variants whose only option is Shopify's synthetic `Title` /
 *      `Default Title` placeholder. The storefront renders a dropdown of variant titles with
 *      nothing to distinguish them, so the shopper is asked to choose without being told what
 *      they are choosing between.
 *   2. An option with exactly one value — "Color: Blue" on a product that only comes in blue.
 *      The theme renders a dropdown or swatch that cannot be changed, which reads as an
 *      unavailable choice rather than the only choice.
 *
 * Single-variant products with no real options are HEALTHY. A t-shirt sold in one size needs no
 * option, and flagging it would punish a correct catalogue — the check measures coherence, not
 * variant count.
 *
 * WHAT THIS CANNOT SEE
 * How the theme renders these options — swatch, dropdown or button — needs the storefront crawl.
 * The structural defects above are visible in the data itself, which is why they are what is
 * measured here.
 */

interface Assessment {
  status: RowStatus;
  /** Empty when the product's option structure is coherent. */
  issue: string;
  recommendation: string;
  detail: string;
}

/** Options the merchant actually configured — Shopify's `Title`/`Default Title` placeholder is
 * not one of them. */
function realOptions(product: SnapshotProduct) {
  return product.options.filter((option) => !isDefaultOption(option));
}

function assess(product: SnapshotProduct): Assessment {
  const options = realOptions(product);
  const optionNames = options.map((option) => option.name).filter(Boolean);

  // Multi-variant with no configured options: the shopper is choosing blind.
  if (product.variantCount > 1 && options.length === 0) {
    return {
      status: CRITICAL,
      issue: 'Variants with no named option',
      detail: `${formatCount(product.variantCount)} variants, no option configured`,
      recommendation: 'Give the variants a real option (Size, Colour, Material) so the storefront can label the choice.',
    };
  }

  // A single-valued option renders a control the shopper cannot use.
  const singleValued = options.filter((option) => option.values.length === 1);
  if (singleValued.length > 0) {
    return {
      status: NEEDS_WORK,
      issue: 'Option with only one value',
      detail: singleValued.map((option) => `${option.name}: ${option.values[0]}`).join(', '),
      recommendation: `Remove ${singleValued.length === 1 ? 'this option' : 'these options'} unless more values are coming — a dropdown with one entry reads as sold out.`,
    };
  }

  // An option with no values at all is a broken definition.
  const empty = options.filter((option) => option.values.length === 0);
  if (empty.length > 0) {
    return {
      status: CRITICAL,
      issue: 'Option with no values',
      detail: empty.map((option) => option.name || '(unnamed)').join(', '),
      recommendation: 'Delete the empty option or give it values — the storefront cannot render a choice with nothing in it.',
    };
  }

  return {
    status: HEALTHY,
    issue: '',
    detail: optionNames.length > 0 ? optionNames.join(' · ') : 'Single variant, no options needed',
    recommendation: '—',
  };
}

export const optionsCheck: AuditCheck = {
  id: 'cro.options',
  pillar: 'cro',
  subPillar: 'options',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('options', 'Rankvora AI could not read products from this store, so product options could not be checked.');
    }

    const products = snapshot.products;
    if (products.length === 0) {
      return unavailableResult('options', 'This store has no products, so there are no product options to check.');
    }

    const rows: SubPillarEvidenceRow[] = [];
    const unnamed: SnapshotProduct[] = [];
    const singleValued: SnapshotProduct[] = [];
    const emptyOption: SnapshotProduct[] = [];
    let healthy = 0;

    for (const product of products) {
      const assessment = assess(product);
      if (assessment.status === HEALTHY) healthy += 1;
      else if (assessment.issue === 'Variants with no named option') unnamed.push(product);
      else if (assessment.issue === 'Option with only one value') singleValued.push(product);
      else emptyOption.push(product);

      rows.push({
        id: `product:${product.id}`,
        status: assessment.status,
        facet: assessment.status,
        cells: {
          surface: product.title,
          signal: assessment.issue || 'Option structure is coherent',
          coverage: assessment.status === HEALTHY ? 100 : 0,
          status: assessment.status,
          recommendation: assessment.recommendation,
        },
        current: { label: 'Detected', value: assessment.detail, meta: product.url },
        suggested: { label: 'Recommendation', value: assessment.recommendation },
      });
    }

    const analyzed = products.length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);

    if (unnamed.length > 0) {
      findings.push({
        title: 'Products whose variants have no named option',
        severity: 'high',
        affectedCount: unnamed.length,
        affectedLabel: 'products',
        scoreLift: lift(unnamed.length),
        resolutionType: 'catalog',
        problem: `${formatCount(unnamed.length)} products have more than one variant but no option the merchant configured — only Shopify's default placeholder.`,
        why: 'The storefront has nothing to label the choice with, so the shopper sees a list of variants without being told what separates them. Asking someone to choose without saying what they are choosing between is where the sale is lost.',
        recommendation: 'Add a real option — Size, Colour, Material — to each of these products so the variant picker means something.',
        evidence: [
          `${formatCount(unnamed.length)} of ${formatCount(analyzed)} products have variants but no configured option.`,
          ...unnamed.slice(0, 5).map((product) => `${product.title}: ${formatCount(product.variantCount)} variants, no option.`),
        ],
        evidenceRows: rows.filter((row) => row.cells.signal === 'Variants with no named option').slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    if (emptyOption.length > 0) {
      findings.push({
        title: 'Products with an option that has no values',
        severity: 'high',
        affectedCount: emptyOption.length,
        affectedLabel: 'products',
        scoreLift: lift(emptyOption.length),
        resolutionType: 'catalog',
        problem: `${formatCount(emptyOption.length)} products define an option with no values attached.`,
        why: 'The theme is asked to render a choice with nothing in it. Depending on the theme that is an empty dropdown or a broken control, and either way the product cannot be configured.',
        recommendation: 'Delete the empty option, or add the values it was meant to hold.',
        evidence: emptyOption.slice(0, 5).map((product) => `${product.title}: option defined with no values.`),
        details: { issueType: CRITICAL },
      });
    }

    if (singleValued.length > 0) {
      findings.push({
        title: 'Products with a single-value option',
        severity: 'low',
        affectedCount: singleValued.length,
        affectedLabel: 'products',
        scoreLift: lift(singleValued.length),
        resolutionType: 'catalog',
        problem: `${formatCount(singleValued.length)} products have an option with exactly one value.`,
        why: 'A swatch or dropdown the shopper cannot change reads as "the other options are sold out" rather than "this is the only version". It adds a decision step that has no decision in it.',
        recommendation: 'Remove options that will only ever have one value, and keep the detail in the description instead.',
        evidence: [
          `${formatCount(singleValued.length)} of ${formatCount(analyzed)} products carry a one-value option.`,
          ...singleValued.slice(0, 5).map((product) => {
            const option = realOptions(product).find((entry) => entry.values.length === 1);
            return `${product.title}: ${option?.name ?? 'option'} — only "${option?.values[0] ?? ''}".`;
          }),
        ],
        evidenceRows: rows.filter((row) => row.cells.signal === 'Option with only one value').slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    return {
      subPillar: 'options',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} products have a variant structure a shopper can read. Single-variant products are counted as healthy — they need no options. How the theme renders these controls needs the storefront crawl, which Rankvora AI does not run yet.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Products with real options',
        contextValue: formatCount(products.filter((product) => realOptions(product).length > 0).length),
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
