import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { SnapshotProduct, StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, coveragePct, type RowStatus } from '../shared/status.js';
import { splitByPublication, unpublishedNote } from '../shared/published.js';

/**
 * ─── AI Discovery · Catalog / feed readiness ─────────────────────────
 * Measures whether each product carries the attributes a shopping feed requires, from real
 * variant data: barcode (GTIN), SKU, price, brand and category.
 *
 * WHY THIS IS AN AI DISCOVERY CHECK, NOT A HOUSEKEEPING ONE
 * An AI shopping agent asked "find me this jacket under £200" does not read your product page.
 * It reads a structured feed, and it matches products across merchants on the GTIN. A product
 * with no barcode cannot be matched to the thing the shopper actually asked for, so it is not
 * ranked lower — it is absent from the comparison entirely. The same is true of Google Shopping
 * and every marketplace integration built on the same export.
 *
 * WHAT IS CHECKED, IN SEVERITY ORDER
 *   price 0 or missing   A variant that cannot be priced is rejected by every feed. Critical.
 *   duplicate SKU        The same SKU on several variants collapses them into one row on import,
 *                        so sizes silently disappear from the feed. Real and common — it comes
 *                        from duplicating a product without editing the identifiers.
 *   no barcode           No GTIN, no cross-merchant match.
 *   no SKU               Nothing stable to key updates on between exports.
 *   no vendor / type     Brand and category are required attributes in every major feed spec.
 *
 * TRUNCATION IS REPORTED, NOT HIDDEN. Variants are read up to a per-product cap; a product with
 * more is marked so its row states the result covers the sample rather than the whole product.
 */

export interface Assessment {
  status: RowStatus;
  issue: string;
  detail: string;
  recommendation: string;
}

const NO_ISSUE = '';

/**
 * SKUs repeated WITHIN one product, normalised (trimmed, lower-cased — Shopify does not normalise
 * SKU case). The only duplication assess() judges: the same SKU on two DIFFERENT products is a
 * separate and much rarer problem, and conflating them would misreport both.
 *
 * Exported so the per-product readiness view uses this exact rule instead of a copy of it.
 */
export function duplicateSkusWithin(product: Pick<SnapshotProduct, 'variants'>): Set<string> {
  const seen = new Map<string, number>();
  for (const variant of product.variants) {
    const key = variant.sku?.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

export function assess(product: SnapshotProduct, duplicateSkus: Set<string>): Assessment {
  const variants = product.variants;

  // No variant data at all — cannot judge the product either way.
  if (variants.length === 0) {
    return {
      status: NEEDS_WORK,
      issue: 'No variant data',
      detail: 'Shopify returned no variants for this product',
      recommendation: 'Check this product in Shopify — a product with no variant cannot be sold or exported.',
    };
  }

  const unpriced = variants.filter((variant) => variant.price === null || variant.price <= 0);
  if (unpriced.length > 0) {
    return {
      status: CRITICAL,
      issue: 'Variant with no price',
      detail: `${formatCount(unpriced.length)} of ${formatCount(variants.length)} variants priced at 0 or blank`,
      recommendation: 'Set a real price on every variant — feeds reject a zero-priced item outright.',
    };
  }

  const duplicated = variants.filter((variant) => variant.sku && duplicateSkus.has(variant.sku.trim().toLowerCase()));
  if (duplicated.length > 0) {
    return {
      status: CRITICAL,
      issue: 'Duplicate SKU across variants',
      detail: `SKU ${duplicated[0]?.sku} repeats on ${formatCount(duplicated.length)} variants`,
      recommendation: 'Give every variant its own SKU — a repeated SKU collapses your sizes into one feed row.',
    };
  }

  const noBarcode = variants.filter((variant) => !variant.barcode);
  const noSku = variants.filter((variant) => !variant.sku);

  if (noBarcode.length === variants.length) {
    return {
      status: NEEDS_WORK,
      issue: 'No barcode (GTIN)',
      detail: `None of ${formatCount(variants.length)} variants carry a barcode`,
      recommendation: 'Add the manufacturer GTIN/EAN/UPC to each variant so agents can match this product.',
    };
  }

  if (noSku.length > 0) {
    return {
      status: NEEDS_WORK,
      issue: 'Missing SKU',
      detail: `${formatCount(noSku.length)} of ${formatCount(variants.length)} variants have no SKU`,
      recommendation: 'Set a SKU on every variant so feed updates key to a stable identifier.',
    };
  }

  if (noBarcode.length > 0) {
    return {
      status: NEEDS_WORK,
      issue: 'Barcode missing on some variants',
      detail: `${formatCount(noBarcode.length)} of ${formatCount(variants.length)} variants have no barcode`,
      recommendation: 'Fill in the remaining barcodes — a partially identified product exports inconsistently.',
    };
  }

  const missingAttributes: string[] = [];
  if (!product.vendor.trim()) missingAttributes.push('brand');
  if (!product.productType.trim()) missingAttributes.push('category');
  if (missingAttributes.length > 0) {
    return {
      status: NEEDS_WORK,
      issue: `No ${missingAttributes.join(' or ')}`,
      detail: missingAttributes.map((attribute) => `${attribute} is blank`).join(', '),
      recommendation: `Set the product's ${missingAttributes.join(' and ')} — both are required attributes in every major feed spec.`,
    };
  }

  return {
    status: HEALTHY,
    issue: NO_ISSUE,
    detail: `${formatCount(variants.length)} variants, all priced and identified`,
    // Empty, not an em dash — the dash is the table's way of DISPLAYING an absent value.
    recommendation: '',
  };
}

export const feedCheck: AuditCheck = {
  id: 'ai-discovery.feed',
  pillar: 'ai-discovery',
  subPillar: 'feed',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('feed', 'Rankvora AI could not read products from this store, so feed readiness could not be checked.');
    }

    if (snapshot.products.length === 0) {
      return unavailableResult('feed', 'This store has no products, so there is no product feed to assess.');
    }

    // Only what a feed exports and an agent can match. A draft product is in no feed.
    const { published: products, unpublished } = splitByPublication(snapshot.products);
    if (products.length === 0) {
      return unavailableResult(
        'feed',
        `None of this store’s ${formatCount(unpublished)} products are published to the online store, so there is nothing a shopping feed would export.`,
      );
    }

    // A SKU is only a duplicate if it repeats WITHIN one product — see duplicateSkusWithin.
    const duplicateSkusByProduct = new Map(products.map((product) => [product.id, duplicateSkusWithin(product)]));

    const rows: SubPillarEvidenceRow[] = [];
    const byIssue = new Map<string, SnapshotProduct[]>();
    let healthy = 0;
    let truncated = 0;

    for (const product of products) {
      const assessment = assess(product, duplicateSkusByProduct.get(product.id) ?? new Set());
      if (product.variantsTruncated) truncated += 1;
      if (assessment.status === HEALTHY) healthy += 1;
      else {
        const bucket = byIssue.get(assessment.issue) ?? [];
        bucket.push(product);
        byIssue.set(assessment.issue, bucket);
      }

      rows.push({
        id: `product:${product.id}`,
        status: assessment.status,
        facet: assessment.status,
        cells: {
          signal: product.title,
          detail: assessment.issue || 'Feed-ready',
          // NO `coverage`: one product passes or it does not, and 100/0 was that yes/no restated
          // as a percentage nobody measured.
          status: assessment.status,
          recommendation: assessment.recommendation,
        },
        current: {
          label: 'Detected',
          value: assessment.detail,
          meta: product.variantsTruncated
            ? `${product.url} · first ${formatCount(product.variants.length)} of ${formatCount(product.variantCount)} variants read`
            : product.url,
        },
        ...(assessment.recommendation ? { suggested: { label: 'Recommendation', value: assessment.recommendation } } : {}),
      });
    }

    const analyzed = products.length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);
    const bucket = (issue: string) => byIssue.get(issue) ?? [];

    const unpriced = bucket('Variant with no price');
    if (unpriced.length > 0) {
      findings.push({
        title: 'Products with an unpriced variant',
        severity: 'critical',
        affectedCount: unpriced.length,
        affectedLabel: 'products',
        scoreLift: lift(unpriced.length),
        resolutionType: 'catalog',
        problem: `${formatCount(unpriced.length)} products have at least one variant priced at zero or left blank.`,
        why: 'Every shopping feed and every AI agent rejects an item it cannot price. These products are not ranked badly — they are dropped from the export, so no agent can ever surface them.',
        recommendation: 'Set a real price on every variant, or archive the variants that are not for sale.',
        evidence: unpriced.slice(0, 5).map((product) => `${product.title}: unpriced variant.`),
        evidenceRows: rows.filter((row) => row.cells.detail === 'Variant with no price').slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    const duplicates = bucket('Duplicate SKU across variants');
    if (duplicates.length > 0) {
      findings.push({
        title: 'Products where several variants share one SKU',
        severity: 'high',
        affectedCount: duplicates.length,
        affectedLabel: 'products',
        scoreLift: lift(duplicates.length),
        resolutionType: 'catalog',
        problem: `${formatCount(duplicates.length)} products repeat the same SKU across more than one variant.`,
        why: 'Feed importers key on the SKU, so repeated identifiers collapse several variants into a single row. The sizes or colours that got merged away simply stop existing anywhere downstream, and nothing in Shopify reports it.',
        recommendation: 'Give every variant its own SKU. This usually appears after a product was duplicated and the identifiers were never edited.',
        // The row's own wording, from the same assess() call. This used to print every variant's
        // count beside the FIRST variant's SKU — so SKUs A1, B2, B2 read "3 variants sharing SKU A1",
        // naming a SKU that was not repeated and a count that was not its own.
        evidence: duplicates.slice(0, 5).map((product) =>
          `${product.title}: ${assess(product, duplicateSkusByProduct.get(product.id) ?? new Set()).detail}.`,
        ),
        evidenceRows: rows.filter((row) => row.cells.detail === 'Duplicate SKU across variants').slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    const noBarcode = [...bucket('No barcode (GTIN)'), ...bucket('Barcode missing on some variants')];
    if (noBarcode.length > 0) {
      findings.push({
        title: 'Products with no GTIN for agents to match on',
        severity: 'high',
        affectedCount: noBarcode.length,
        affectedLabel: 'products',
        scoreLift: lift(noBarcode.length),
        resolutionType: 'catalog',
        problem: `${formatCount(noBarcode.length)} products are missing a barcode on some or all variants.`,
        why: 'A GTIN is how an AI shopping agent knows your listing and another merchant\'s listing are the same physical product. Without one your product cannot enter that comparison at all — it is not outranked, it is invisible.',
        recommendation: 'Add the manufacturer barcode (GTIN/EAN/UPC) to each variant. For own-brand products with no GTIN, keep SKUs unique and complete so at least the internal identity is stable.',
        evidence: [
          `${formatCount(noBarcode.length)} of ${formatCount(analyzed)} products lack a complete set of barcodes.`,
          ...noBarcode.slice(0, 5).map((product) => `${product.title}: barcode missing.`),
        ],
        evidenceRows: rows.filter((row) => String(row.cells.detail).startsWith('No barcode') || String(row.cells.detail).startsWith('Barcode missing')).slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    const noSku = bucket('Missing SKU');
    if (noSku.length > 0) {
      findings.push({
        title: 'Variants with no SKU',
        severity: 'medium',
        affectedCount: noSku.length,
        affectedLabel: 'products',
        scoreLift: lift(noSku.length),
        resolutionType: 'catalog',
        problem: `${formatCount(noSku.length)} products have at least one variant with no SKU.`,
        why: 'Without a stable identifier, each export looks like a new product rather than an update to an existing one, so price and stock changes do not propagate cleanly.',
        recommendation: 'Set a unique SKU on every variant.',
        evidence: noSku.slice(0, 5).map((product) => `${product.title}: variant without a SKU.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    const noAttributes = [...byIssue.entries()]
      .filter(([issue]) => issue.startsWith('No brand') || issue.startsWith('No category'))
      .flatMap(([, items]) => items);
    if (noAttributes.length > 0) {
      findings.push({
        title: 'Products missing brand or category',
        severity: 'medium',
        affectedCount: noAttributes.length,
        affectedLabel: 'products',
        scoreLift: lift(noAttributes.length),
        resolutionType: 'catalog',
        problem: `${formatCount(noAttributes.length)} products have no vendor or no product type set.`,
        why: 'Brand and category are required attributes in every major feed spec. Missing either one means the product cannot be filed into the right comparison set, so it only surfaces for searches that name it exactly.',
        recommendation: 'Set a vendor and a product type on every product — both are single fields on the product record.',
        evidence: noAttributes.slice(0, 5).map((product) => {
          const missing = [!product.vendor.trim() ? 'brand' : '', !product.productType.trim() ? 'category' : ''].filter(Boolean);
          return `${product.title}: missing ${missing.join(' and ')}.`;
        }),
        details: { issueType: NEEDS_WORK },
      });
    }

    const noVariants = bucket('No variant data');
    if (noVariants.length > 0) {
      findings.push({
        title: 'Products Shopify returned with no variants',
        severity: 'medium',
        affectedCount: noVariants.length,
        affectedLabel: 'products',
        scoreLift: lift(noVariants.length),
        resolutionType: 'catalog',
        problem: `${formatCount(noVariants.length)} products came back with no variant records.`,
        why: 'A product with no variant has nothing to price, identify or sell, so it cannot appear in any feed.',
        recommendation: 'Open these products in Shopify and confirm they have at least one variant.',
        evidence: noVariants.slice(0, 5).map((product) => `${product.title}: no variants returned.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    const barcodeCoverage = coveragePct(
      products.filter((product) => product.variants.length > 0 && product.variants.every((variant) => Boolean(variant.barcode))).length,
      analyzed,
    );

    return {
      subPillar: 'feed',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} published products carry everything a shopping feed requires — a real price, unique identifiers, a brand and a category.${truncated > 0 ? ` ${formatCount(truncated)} products have more variants than were read, so their result covers the variants sampled.` : ''}${unpublishedNote(unpublished)}`,
        // Whole percent: a decimal place implies a precision these counts do not carry.
        healthChip: `${coveragePct(healthy, analyzed)}% healthy`,
        contextLabel: 'Products fully barcoded',
        contextValue: `${barcodeCoverage}%`,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
