import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles and descriptions only — every number comes from the audit. See liveOnly.ts. */
const content = (key: string, title: string, description: string, analyzedLabel: string) =>
  liveOnlyConfig('content', 'Content', key, title, description, analyzedLabel);

export const contentPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'content/product-descriptions': content(
    'product-descriptions',
    'Product Descriptions',
    'Make product copy useful, specific, and persuasive across every product detail page.',
    'Products',
  ),
  'content/collection-descriptions': content(
    'collection-descriptions',
    'Collection Descriptions',
    'Make every collection page useful for shoppers and search engines with unique, intent-led copy.',
    'Collections',
  ),
  // Registered alongside the others now — the check has always produced this sub-pillar's rows.
  'content/metafields': content(
    'metafields',
    'Metafields',
    'How much of your catalog fills in each metafield the store actually uses. A metafield defined in Shopify but filled on no product cannot be seen from product data and is not counted.',
    'Metafields',
  ),
  'content/dup-templated':content(
    'dup-templated',
    'Copy Uniqueness',
    'Find repetitive copy patterns that dilute product value, relevance, and buyer confidence.',
    'Pages',
  ),
  'content/blog-freshness': content(
    'blog-freshness',
    'Blog Freshness',
    'Keep editorial content current, useful, and aligned with the questions shoppers ask today.',
    'Articles',
  ),
  'content/media-richness': content(
    'media-richness',
    'Media Richness',
    'Give product pages the visual depth shoppers need to understand, compare, and trust what they are buying.',
    'Products',
  ),
};
