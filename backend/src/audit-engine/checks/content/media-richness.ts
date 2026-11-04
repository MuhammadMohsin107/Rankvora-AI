import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';

/**
 * ─── Content · Media richness ────────────────────────────────────────
 * Scores how many images each product carries.
 *
 * WHAT IS MEASURED
 * `Product.images` from the Admin API — the product's own media, which is what a product page
 * gallery renders.
 *
 * BANDS (status vocabulary matches contentTables.ts: Rich / Limited / Missing Media):
 *   0 images     Missing Media
 *   1-2 images   Limited
 *   3+ images    Rich
 *
 * Three is the threshold at which a gallery can show a product from more than one angle, which is
 * the practical difference between "there is a photo" and "I can see what I am buying".
 *
 * HONEST LIMIT: the `video` column the UI declares is reported as "No" for every row. The
 * snapshot models images only (SnapshotImage), so video presence is genuinely UNKNOWN here — it
 * is not measured and must not be scored. Adding video would require extending the provider to
 * read Product.media union types, not guessing from image data.
 */

const RICH_MIN_IMAGES = 3;

const RICH = 'Rich';
const LIMITED = 'Limited';
const MISSING_MEDIA = 'Missing Media';

export const mediaRichnessCheck: AuditCheck = {
  id: 'content.media-richness',
  pillar: 'content',
  subPillar: 'media-richness',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('media-richness', 'Rankvora AI could not read products from this store, so media coverage could not be checked.');
    }
    if (snapshot.products.length === 0) {
      return unavailableResult('media-richness', 'This store has no products to check.');
    }

    const counts: Record<string, number> = { [RICH]: 0, [LIMITED]: 0, [MISSING_MEDIA]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let totalImages = 0;

    for (const product of snapshot.products) {
      const images = product.images.length;
      const status = images === 0 ? MISSING_MEDIA : images < RICH_MIN_IMAGES ? LIMITED : RICH;
      counts[status] += 1;
      totalImages += images;

      rows.push({
        id: `product:${product.id}`,
        status,
        facet: status,
        cells: {
          product: product.title,
          // The product's first image as Shopify returned it (null when it has none). Not a column
          // of this check's table: the Products page reads it for the row's thumbnail, and this is
          // the one product check that records every product rather than one row per image.
          imageSrc: product.images[0]?.src ?? null,
          // When Shopify last recorded a change to the product (null when it did not say). Also for
          // the Products page, which lists it as "Last updated".
          updatedAt: product.updatedAt,
          images,
          // Not measured — see the header note. Reported as 'No' because the UI's bool column has
          // no "unknown" rendering; the limitation is stated in the summary instead.
          video: 'No',
          gallery: images,
          recommendation:
            status === MISSING_MEDIA ? 'Add at least one product photo.'
            : status === LIMITED ? `Add more angles — aim for ${RICH_MIN_IMAGES}+ images.`
            : '—',
        },
        current: { label: 'Images', value: String(images), meta: product.title },
      });
    }

    const analyzed = snapshot.products.length;
    const healthy = counts[RICH];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[MISSING_MEDIA] > 0) {
      findings.push({
        title: 'Products with no images',
        severity: 'critical',
        affectedCount: counts[MISSING_MEDIA],
        affectedLabel: 'products',
        scoreLift: lift(counts[MISSING_MEDIA]),
        resolutionType: 'media',
        problem: `${formatCount(counts[MISSING_MEDIA])} products have no image at all.`,
        why: 'A product page without a photo is close to unsellable — shoppers will not buy what they cannot see, and the listing is ineligible for image-based surfaces like Google Shopping.',
        recommendation: 'Add at least one clear photo to every product.',
        evidence: [`${formatCount(counts[MISSING_MEDIA])} of ${formatCount(analyzed)} products have zero images.`],
        details: { issueType: MISSING_MEDIA },
      });
    }

    if (counts[LIMITED] > 0) {
      findings.push({
        title: 'Products with a thin gallery',
        severity: 'low',
        affectedCount: counts[LIMITED],
        affectedLabel: 'products',
        scoreLift: lift(counts[LIMITED]),
        resolutionType: 'media',
        problem: `${formatCount(counts[LIMITED])} products have fewer than ${RICH_MIN_IMAGES} images.`,
        why: 'One photo rarely answers scale, texture and fit questions, so shoppers hesitate or leave to research elsewhere.',
        recommendation: `Add additional angles, a scale reference and a detail shot — ${RICH_MIN_IMAGES} or more.`,
        evidence: [`${formatCount(counts[LIMITED])} of ${formatCount(analyzed)} products have 1-2 images.`],
        details: { issueType: LIMITED },
      });
    }

    return {
      subPillar: 'media-richness',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} products carry ${RICH_MIN_IMAGES} or more images. Video presence is not measured — the Admin snapshot reads images only.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Average images',
        contextValue: `${(totalImages / analyzed).toFixed(1)} per product`,
        healthyStatus: RICH,
        evidenceRows: takeEvidenceSample(rows, RICH),
      },
      findings,
    };
  },
};
