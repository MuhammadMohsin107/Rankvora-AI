import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';

/**
 * ─── Speed · Image Optimization ──────────────────────────────────────
 * Scores product imagery on the two signals the Admin API genuinely exposes:
 *
 *   1. DIMENSIONS — an image whose pixel area far exceeds what any product page renders is
 *      shipped weight for nothing. The threshold (> ~5.5MP, i.e. beyond ~2048x2560) marks a
 *      source image no storefront breakpoint will ever display at full size.
 *   2. FORMAT — inferred from the CDN URL's extension. JPEG/PNG sources are flagged when
 *      oversized; WebP/AVIF sources are treated as modern.
 *
 * HONEST LIMIT, stated in the summary too: TRANSFERRED BYTES are not visible here. Shopify's
 * CDN transcodes and resizes on delivery, so real byte weight is a storefront/lab measurement
 * (blocked while the storefront is password-protected). What is measured is the source asset
 * the CDN has to work from — a real, actionable signal, but not a page-weight figure, and this
 * check never pretends otherwise.
 *
 * The unit is the IMAGE, not the product: one product with nine heavy images is nine problems.
 */

/** > 5.5 megapixels: larger than 2048x2560, the biggest size Shopify's own product-media
 * guidance treats as necessary for zoom. */
const OVERSIZED_PIXELS = 5_500_000;

const OPTIMIZED = 'Optimized';
const OVERSIZED = 'Oversized';
const UNKNOWN_SIZE = 'No Dimensions';

function formatOf(src: string): string {
  const match = src.split('?')[0]?.match(/\.([a-z0-9]+)$/i);
  return (match?.[1] ?? 'unknown').toLowerCase();
}

export const imageWeightCheck: AuditCheck = {
  id: 'speed.image-weight',
  pillar: 'speed',
  subPillar: 'image-weight',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('image-weight', 'Rankvora AI could not read products from this store, so imagery could not be checked.');
    }

    const images = snapshot.products.flatMap((product) =>
      product.images.map((image) => ({ product, image })));
    if (images.length === 0) {
      return unavailableResult('image-weight', 'No product images were found, so there is nothing to measure.');
    }

    const counts: Record<string, number> = { [OPTIMIZED]: 0, [OVERSIZED]: 0, [UNKNOWN_SIZE]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let totalMegapixels = 0;
    let measurable = 0;

    for (const { product, image } of images) {
      const pixels = image.width !== null && image.height !== null ? image.width * image.height : null;
      const format = formatOf(image.src);
      let status: string;
      if (pixels === null) {
        // Dimensionless media (a processing failure or non-standard source) is counted and
        // shown, never silently treated as fine.
        status = UNKNOWN_SIZE;
      } else {
        measurable += 1;
        totalMegapixels += pixels / 1_000_000;
        status = pixels > OVERSIZED_PIXELS ? OVERSIZED : OPTIMIZED;
      }
      counts[status] = (counts[status] ?? 0) + 1;

      rows.push({
        id: `image:${image.id}`,
        status,
        facet: status,
        cells: {
          url: product.url,
          pageType: 'Product',
          title: product.title,
          length: pixels !== null ? Math.round(pixels / 1_000_000) : 0,
        },
        current: {
          label: 'Source image',
          value: pixels !== null ? `${image.width}×${image.height} ${format}` : `dimensions unknown (${format})`,
          meta: product.title,
        },
      });
    }

    const analyzed = images.length;
    const healthy = counts[OPTIMIZED];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[OVERSIZED] > 0) {
      findings.push({
        title: 'Source images far larger than any display size',
        severity: 'medium',
        affectedCount: counts[OVERSIZED],
        affectedLabel: 'images',
        scoreLift: lift(counts[OVERSIZED]),
        resolutionType: 'media',
        problem: `${formatCount(counts[OVERSIZED])} product images exceed ${Math.round(OVERSIZED_PIXELS / 1_000_000)} megapixels at source.`,
        why: 'Very large sources cost upload bandwidth, slow the CDN’s first transcode of every new size, and on themes that request large variants they ship real page weight a shopper never benefits from.',
        recommendation: 'Re-export these images at or below 2048×2560 before uploading — detail survives, the excess weight does not.',
        evidence: [`${formatCount(counts[OVERSIZED])} of ${formatCount(analyzed)} product images are over the ${Math.round(OVERSIZED_PIXELS / 1_000_000)}MP source threshold.`],
        details: { issueType: OVERSIZED },
      });
    }

    if (counts[UNKNOWN_SIZE] > 0) {
      findings.push({
        title: 'Images with unreadable dimensions',
        severity: 'low',
        affectedCount: counts[UNKNOWN_SIZE],
        affectedLabel: 'images',
        scoreLift: lift(counts[UNKNOWN_SIZE]),
        resolutionType: 'media',
        problem: `${formatCount(counts[UNKNOWN_SIZE])} images returned no width/height from Shopify.`,
        why: 'An image whose dimensions the platform cannot report usually failed processing — it may render inconsistently or not at all.',
        recommendation: 'Re-upload these images so Shopify can process them normally.',
        evidence: [`${formatCount(counts[UNKNOWN_SIZE])} of ${formatCount(analyzed)} images carry no dimensions.`],
        details: { issueType: UNKNOWN_SIZE },
      });
    }

    return {
      subPillar: 'image-weight',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} product images are appropriately sized at source. Measured from source dimensions via the Admin API — delivered byte weight needs storefront access and is not claimed here.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Average source size',
        contextValue: measurable > 0 ? `${(totalMegapixels / measurable).toFixed(1)} MP` : '—',
        healthyStatus: OPTIMIZED,
        evidenceRows: takeEvidenceSample(rows, OPTIMIZED),
      },
      findings,
    };
  },
};
