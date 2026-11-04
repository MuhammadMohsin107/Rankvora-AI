import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import { productImageRef } from '../../../lib/ai/fix-policy.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, pathOf, takeEvidenceSample } from './page-inventory.js';

/**
 * ─── SEO · Image alt text ────────────────────────────────────────────
 * Scores alt-text coverage across PRODUCT MEDIA.
 *
 * SCOPE LIMIT — STATED, NOT HIDDEN
 * The unit analyzed is the product, and the only images visible to this check are the ones
 * attached to products in the Admin API. Theme images (banners, logos, lookbooks, section
 * backgrounds) are rendered by Liquid and are invisible here. So this check measures catalog
 * alt coverage, NOT whole-page image accessibility, and the summary says so. Completing that
 * picture requires the storefront crawl layer.
 *
 * WHY `alt: null` AND `alt: ''` ARE DIFFERENT
 * The snapshot deliberately preserves the distinction (see SnapshotImage): null means the
 * attribute is genuinely absent, '' means it is present but empty. Both fail this check — a
 * screen reader gets nothing either way — but they are counted and reported separately because
 * an empty string is a deliberate "decorative" marker that is simply being misused on catalog
 * imagery, and the fix differs.
 *
 * A product is healthy only when EVERY one of its images has non-empty alt text. Partial
 * coverage is a partial failure; averaging it away would hide products that are mostly unlabelled.
 *
 * SCORED BY PRODUCT, EVIDENCED BY IMAGE
 * The score and the findings count products, for the reason above. The evidence rows are one per
 * IMAGE, because alt text is written to an image: a product-level row can hold a coverage summary
 * ("0 of 3 images labelled") but it cannot hold a value, cannot say which of three photos a value
 * belongs to, and cannot be written anywhere. Every row here names its own media id, carries the
 * image's REAL alt text as the current value, and carries the fields the merchant's alt-text
 * template draws from — so the fix flow has a target, a baseline and its source material.
 */

const COMPLETE = 'Healthy';
const PARTIAL = 'Partial';
const NONE = 'Missing';

export const imageAltTextCheck: AuditCheck = {
  id: 'seo.image-alt-text',
  pillar: 'seo',
  subPillar: 'image-alt-text',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('image-alt-text', 'Rankvora AI could not read products from this store, so image alt text could not be checked.');
    }

    // Only products that actually have images can have alt text. Products with no media are
    // excluded from the denominator entirely — their problem is "no images", which media-richness
    // scores. Counting them here would double-penalize one defect across two sub-pillars.
    const withImages = snapshot.products.filter((product) => product.images.length > 0);
    if (withImages.length === 0) {
      return unavailableResult('image-alt-text', 'No product images were found, so alt-text coverage could not be measured.');
    }

    const counts: Record<string, number> = { [COMPLETE]: 0, [PARTIAL]: 0, [NONE]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let totalImages = 0;
    let labelledImages = 0;
    let nullAlt = 0;
    let emptyAlt = 0;
    // This store's own products with no described image, in catalogue order — named in the
    // recommendation so it points at them instead of at an invented example.
    const undescribed: string[] = [];

    for (const product of withImages) {
      const images = product.images;
      const described = images.map((image) => typeof image.alt === 'string' && image.alt.trim() !== '');
      const labelled = described.filter(Boolean).length;

      totalImages += images.length;
      labelledImages += labelled;
      for (const image of images) {
        if (image.alt === null) nullAlt += 1;
        else if (image.alt.trim() === '') emptyAlt += 1;
      }

      // The PRODUCT's verdict, carried by each of its image rows. The findings below count
      // products, and a row's status is what the evidence table filters those findings by — an
      // image-level verdict here would leave the "partially labelled" finding with a filter chip
      // that matched nothing. Which images are actually described is not lost: it is each row's
      // own current value.
      const status = labelled === images.length ? COMPLETE : labelled === 0 ? NONE : PARTIAL;
      counts[status] += 1;
      if (status === NONE && product.title.trim()) undescribed.push(product.title.trim());

      for (const [index, image] of images.entries()) {
        // The description as it will be shown and compared against: '' for both an absent alt
        // attribute and an empty one, because neither describes anything.
        const alt = described[index] ? (image.alt as string) : '';
        const position = index + 1;
        rows.push({
          id: productImageRef(product.id, image.id),
          status,
          facet: 'Product image',
          cells: {
            name: product.title,
            url: product.url,
            // Read in the review modal as the line under the name, where two photos of the same
            // product would otherwise be two identical-looking boxes.
            path: `${pathOf(product.url)} · image ${position} of ${images.length}`,
            pageType: 'Product',
            position,
            imageCount: images.length,
            imageLabel: `${position} of ${images.length}`,
            imageSrc: image.src,
            // The description itself, as a cell, because that is the column the table shows and the
            // value an applied fix replaces. Empty is a real value here, not a missing one.
            alt,
            length: alt.trim().length,
            // What the merchant's alt-text template draws from, carried on the row so generating a
            // value needs no second read of the store. Empty strings where Shopify had nothing —
            // the template renderer decides what an absent placeholder does, not this check.
            productType: product.productType,
            vendor: product.vendor,
          },
          current: {
            label: 'Current alt text',
            // The REAL alt text, which is what a fix must be measured against. A missing attribute
            // and an empty one are both no description; the pair is still counted separately in
            // the finding evidence below.
            value: alt,
            meta: `Image ${position} of ${images.length} · ${product.title}`,
          },
        });
      }
    }

    const analyzed = withImages.length;
    const healthy = counts[COMPLETE];
    const unlabelled = totalImages - labelledImages;
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[NONE] > 0) {
      findings.push({
        title: 'Products with no image alt text at all',        severity: 'high',
        affectedCount: counts[NONE],
        affectedLabel: 'products',
        scoreLift: lift(counts[NONE]),
        resolutionType: 'media',
        problem: `${formatCount(counts[NONE])} products have no alt text on any image.`,
        why: 'Screen-reader users get no description of the product at all, and search engines lose the only text signal an image carries — which is what image search ranks on.',
        // It read: "Navy merino sweater, front view" beats "sweater image" — the same invented
        // product for every store, a clothing example on a supplements catalogue. The advice now
        // names this store's own products that have nothing described.
        recommendation: `Describe what each photo shows — the product, the variant and the view — rather than a file name or a single generic word.${
          undescribed.length > 0
            ? ` Start with ${undescribed.slice(0, 3).map((title) => `"${title}"`).join(', ')}${undescribed.length > 3 ? ` and the other ${formatCount(undescribed.length - 3)}` : ''}.`
            : ''
        }`,
        evidence: [
          `${formatCount(counts[NONE])} of ${formatCount(analyzed)} products with images have zero labelled images.`,
          `${formatCount(nullAlt)} images have no alt attribute; ${formatCount(emptyAlt)} have an empty one.`,
          ...undescribed.slice(0, 5).map((title) => `${title}: no image has alt text.`),
        ],
        details: { issueType: NONE },
      });
    }

    if (counts[PARTIAL] > 0) {
      findings.push({
        title: 'Products with partially labelled images',
        severity: 'medium',
        affectedCount: counts[PARTIAL],
        affectedLabel: 'products',
        scoreLift: lift(counts[PARTIAL]),
        resolutionType: 'media',
        problem: `${formatCount(counts[PARTIAL])} products have some images labelled and others not.`,
        why: 'A gallery that is only partly described reads as incomplete to assistive technology, and the unlabelled images stay invisible to image search.',
        recommendation: 'Fill the gaps so every image in the gallery carries its own description.',
        evidence: [`${formatCount(unlabelled)} of ${formatCount(totalImages)} product images are unlabelled.`],
        details: { issueType: PARTIAL },
      });
    }

    return {
      subPillar: 'image-alt-text',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} products have alt text on every image (${formatCount(labelledImages)} of ${formatCount(totalImages)} images labelled). Catalog images only — theme and banner images are not visible to the Admin API.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Images labelled',
        contextValue: `${formatCount(labelledImages)} / ${formatCount(totalImages)}`,
        evidenceRows: takeEvidenceSample(rows, COMPLETE),
      },
      findings,
    };
  },
};
