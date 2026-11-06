import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles only — every number comes from the audit. See liveOnly.ts. */
const content = (key: string, title: string, analyzedLabel: string) =>
  liveOnlyConfig('content', 'Content', key, title, analyzedLabel);

export const contentPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'content/product-descriptions': content(
    'product-descriptions',
    'Product Descriptions',
    'Products',
  ),
  'content/collection-descriptions': content(
    'collection-descriptions',
    'Collection Descriptions',
    'Collections',
  ),
  // Registered alongside the others now — the check has always produced this sub-pillar's rows.
  'content/metafields': content(
    'metafields',
    'Metafields',
    'Metafields',
  ),
  'content/dup-templated':content(
    'dup-templated',
    'Copy Uniqueness',
    'Pages',
  ),
  'content/blog-freshness': content(
    'blog-freshness',
    'Blog Freshness',
    'Articles',
  ),
  'content/media-richness': content(
    'media-richness',
    'Media Richness',
    'Products',
  ),
};
