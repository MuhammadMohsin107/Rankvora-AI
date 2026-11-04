import { env } from '../../../config/env.js';
import type { StoreSnapshot } from '../../store-data/types.js';

/**
 * Flattens the four indexable resource groups into the one "page" shape the SEO snippet checks
 * (title tags, meta descriptions) share. Both checks score the same inventory, so building it
 * once here keeps their analyzed counts consistent — a page counted by one is counted by both.
 *
 * Facet values match the `facet` config the frontend catalogs declare for these sub-pillars
 * ('Product' | 'Collection' | 'Blog' | 'Page'), so the UI's page-type filter works unchanged.
 */

export type PageFacet = 'Product' | 'Collection' | 'Blog' | 'Page';

export interface InventoryPage {
  id: string;
  url: string;
  facet: PageFacet;
  /**
   * The resource's OWN title. This matters: Shopify's `seoTitle` is an *override*, and when it
   * is null the storefront theme renders this value instead. Treating a null override as a
   * "missing title" would report an error on a page that in fact has a perfectly good title.
   */
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  /** The page's own body copy — the only honest source for an excerpted meta description. */
  bodyHtml: string;
}

/** Resource groups whose coverage flag was false — i.e. we could not look, so they are absent
 * from the inventory and must not be reported as healthy or as zero. */
export interface InventoryGaps {
  missingGroups: string[];
}

export interface PageInventory {
  pages: InventoryPage[];
  gaps: InventoryGaps;
}

export function buildPageInventory(snapshot: StoreSnapshot): PageInventory {
  const pages: InventoryPage[] = [];
  const missingGroups: string[] = [];

  if (snapshot.coverage.products) {
    for (const product of snapshot.products) {
      pages.push({
        id: `product:${product.id}`,
        url: product.url,
        facet: 'Product',
        title: product.title,
        seoTitle: product.seoTitle,
        seoDescription: product.seoDescription,
        bodyHtml: product.bodyHtml,
      });
    }
  } else missingGroups.push('products');

  if (snapshot.coverage.collections) {
    for (const collection of snapshot.collections) {
      pages.push({
        id: `collection:${collection.id}`,
        url: collection.url,
        facet: 'Collection',
        title: collection.title,
        seoTitle: collection.seoTitle,
        seoDescription: collection.seoDescription,
        bodyHtml: collection.bodyHtml,
      });
    }
  } else missingGroups.push('collections');

  if (snapshot.coverage.pages) {
    for (const page of snapshot.pages) {
      pages.push({
        id: `page:${page.id}`,
        url: page.url,
        facet: 'Page',
        title: page.title,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        bodyHtml: page.bodyHtml,
      });
    }
  } else missingGroups.push('pages');

  if (snapshot.coverage.articles) {
    for (const article of snapshot.articles) {
      pages.push({
        id: `article:${article.id}`,
        url: article.url,
        facet: 'Blog',
        title: article.title,
        seoTitle: article.seoTitle,
        seoDescription: article.seoDescription,
        bodyHtml: article.bodyHtml,
      });
    }
  } else missingGroups.push('articles');

  return { pages, gaps: { missingGroups } };
}

/**
 * How many evidence rows a check persists. Every page is ANALYZED and counted in the score; this
 * caps only the per-row table stored in JSON and rendered in the UI. Without it a 50k-product
 * store would write a multi-megabyte blob into a single audit_scores row on every audit.
 *
 * Issue rows are kept ahead of healthy ones (see takeEvidenceSample) so the sample always shows
 * the merchant what is actually wrong rather than a page of passing rows.
 */
export const EVIDENCE_ROW_LIMIT = env.auditEvidenceRowLimit;

/** Returns at most EVIDENCE_ROW_LIMIT rows, issues first, preserving input order within a group. */
export function takeEvidenceSample<T extends { status: string }>(rows: T[], healthyStatus: string): T[] {
  if (rows.length <= EVIDENCE_ROW_LIMIT) return rows;
  const issues = rows.filter((row) => row.status !== healthyStatus);
  const healthy = rows.filter((row) => row.status === healthyStatus);
  return [...issues, ...healthy].slice(0, EVIDENCE_ROW_LIMIT);
}

/**
 * The site-relative path of a resource URL, for evidence rows.
 *
 * Every row on a store shares the same origin, so a table column showing full URLs spends its
 * entire width on "https://mynutritionstore.pk/" and truncates the one part that identifies the
 * row. The path is what tells two products apart.
 */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

/** Locale-aware thousands separator, matching how the seeded summaries read ("1,146 of 1,284"). */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Groups page ids by a normalized value so duplicate detection is case/whitespace insensitive. */
export function findDuplicateValues(entries: Array<{ id: string; value: string }>): Set<string> {
  const byValue = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.value.trim().toLowerCase();
    if (!key) continue;
    byValue.set(key, (byValue.get(key) ?? 0) + 1);
  }
  const duplicated = new Set<string>();
  for (const [key, count] of byValue) if (count > 1) duplicated.add(key);
  return duplicated;
}
