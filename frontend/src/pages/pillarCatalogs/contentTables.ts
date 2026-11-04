import type { GenericSubPillarDetails } from './genericTypes';

/**
 * ─── Content · evidence table config ─────────────────────────────────
 *
 * COLUMN DEFINITIONS ONLY. `fetchSubPillarAnalysis` replaces `evidence.rows` with the rows the
 * audit actually produced, so `rows: []` is correct and load-bearing here.
 *
 * Every entry previously carried a worked example of a fictional audio store — "Wireless Earbuds",
 * "Gaming Audio", "/products/gaming-headset-surround-7-1" — and each opportunity card interpolated
 * a count from `data/content/content.mock.ts`. None of it reached the screen, and that is exactly
 * what made it risky: nothing about reading this file said the figures were invented, and a single
 * changed line in the repository would have rendered them as measurements.
 *
 * `opportunities` is empty for the same reason. Nothing reads it — `buildAnalysis` consumes only
 * `details.table` — and every title it held was a sentence about a number that was never measured.
 */

const good = 'bg-success-100 text-success-700';
const warn = 'bg-warning-100 text-warning-700';
const bad = 'bg-critical-100 text-critical-700';

/** Detail tables for Content sub-pillars (keyed by route). */
export const contentTables: Record<string, GenericSubPillarDetails> = {
  /**
   * Product descriptions had NO entry here, so the page fell back to the generic evidence
   * columns (`item` / `issue` / `affected`). The check writes `product`, `description`, `words`,
   * `issue` and `recommendation`, so only "Issue" ever had a value and the rest of the table
   * rendered blank. Same shape as collections below — it is the same check, keyed by resource.
   */
  'content/product-descriptions': {
    table: {
      title: 'Product Description Analysis',
      subtitle: 'Search and filter products by description status',
      searchPlaceholder: 'Search by product or description…',
      filters: ['All', 'Missing', 'Too Short', 'Duplicate', 'Good'],
      statusClass: { Missing: bad, 'Too Short': warn, Duplicate: bad, Good: good },
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'description', header: 'Description', variant: 'muted' },
        { key: 'words', header: 'Word Count', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'issue', header: 'Issue', variant: 'muted' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },

  'content/collection-descriptions': {
    table: {
      title: 'Collection Description Analysis',
      subtitle: 'Search and filter collections by description status',
      searchPlaceholder: 'Search by collection or description…',
      filters: ['All', 'Missing', 'Too Short', 'Duplicate', 'Good'],
      statusClass: { Missing: bad, 'Too Short': warn, Duplicate: bad, Good: good },
      columns: [
        { key: 'collection', header: 'Collection' },
        { key: 'description', header: 'Description', variant: 'muted' },
        { key: 'words', header: 'Word Count', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'issue', header: 'Issue', variant: 'muted' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },

  /**
   * Metafields had no entry here either, so its page would have fallen back to the generic
   * columns and rendered a table of blanks.
   *
   * THE UNIT IS THE METAFIELD, NOT THE PRODUCT — unlike every other Content sub-pillar. The check
   * writes one row per metafield key in use, with the share of the catalogue that fills it, and
   * these are its own cell keys: `field`, `label`, `category`, `applicable`, `missing`,
   * `coverage`, `recommendation`. The status vocabulary is the check's own three bands, not the
   * Healthy/Needs Work set the AI and CRO tables use.
   */
  'content/metafields': {
    table: {
      title: 'Metafield Completeness',
      subtitle: 'Each metafield the catalog uses, by the share of products that fill it in',
      searchPlaceholder: 'Search by field or namespace…',
      filters: ['All', 'Critical Gap', 'Gap', 'Complete'],
      statusClass: { 'Critical Gap': bad, Gap: warn, Complete: good },
      columns: [
        { key: 'field', header: 'Metafield' },
        { key: 'category', header: 'Namespace', variant: 'muted' },
        { key: 'applicable', header: 'Products', align: 'center', variant: 'number' },
        { key: 'missing', header: 'Missing', align: 'center', variant: 'number' },
        { key: 'coverage', header: 'Coverage %', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },

  'content/dup-templated': {
    table: {
      title: 'Duplicate & Templated Copy Analysis',
      subtitle: 'Pages ranked by content similarity to their nearest sibling',
      searchPlaceholder: 'Search by page or pattern…',
      filters: ['All', 'Highly Templated', 'Potential Duplicate', 'Unique'],
      statusClass: { 'Highly Templated': bad, 'Potential Duplicate': warn, Unique: good },
      columns: [
        { key: 'page', header: 'Page' },
        { key: 'similarity', header: 'Content Similarity', align: 'center', variant: 'number' },
        { key: 'pattern', header: 'Pattern', variant: 'muted' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },

  'content/blog-freshness': {
    table: {
      title: 'Article Freshness',
      subtitle: 'Search and filter articles by freshness status',
      searchPlaceholder: 'Search by article title…',
      filters: ['All', 'Stale', 'Aging', 'Fresh'],
      statusClass: { Stale: bad, Aging: warn, Fresh: good },
      columns: [
        { key: 'article', header: 'Article' },
        { key: 'published', header: 'Published', variant: 'muted' },
        { key: 'updated', header: 'Last Updated', variant: 'muted' },
        { key: 'age', header: 'Age', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },

  'content/media-richness': {
    table: {
      title: 'Product Media Coverage',
      subtitle: 'Search and filter products by media richness',
      searchPlaceholder: 'Search by product…',
      filters: ['All', 'Missing Media', 'Limited', 'Rich'],
      statusClass: { 'Missing Media': bad, Limited: warn, Rich: good },
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'images', header: 'Images', align: 'center', variant: 'number' },
        { key: 'video', header: 'Video', align: 'center', variant: 'bool' },
        { key: 'gallery', header: 'Gallery', align: 'center', variant: 'number' },
        { key: 'status', header: 'Status', align: 'center', variant: 'status' },
        { key: 'recommendation', header: 'Recommendation', variant: 'muted' },
      ],
      rows: [],
    },
    opportunities: [],
  },
};
