import type { SubPillarAnalysis } from '../subpillar.model';
import { titleTagsAnalysis } from './title-tags';
import { metaDescriptionsAnalysis } from './meta-descriptions';
import { schemaAnalysis } from './schema';
import { imageAltTextAnalysis } from './image-alt-text';
import { canonicalsAnalysis } from './canonicals';
import { handlesRedirectsAnalysis } from './handles-redirects';
import { sitemapAnalysis } from './sitemap';
import { internalLinksAnalysis } from './internal-links';

/** Every SEO sub-pillar, keyed by its route slug. */
export const seoAnalyses: Record<string, SubPillarAnalysis> = {
  'title-tags': titleTagsAnalysis,
  'meta-descriptions': metaDescriptionsAnalysis,
  schema: schemaAnalysis,
  'image-alt-text': imageAltTextAnalysis,
  canonicals: canonicalsAnalysis,
  'handles-redirects': handlesRedirectsAnalysis,
  sitemap: sitemapAnalysis,
  'internal-links': internalLinksAnalysis,
};

export {
  titleTagsAnalysis,
  metaDescriptionsAnalysis,
  schemaAnalysis,
  imageAltTextAnalysis,
  canonicalsAnalysis,
  handlesRedirectsAnalysis,
  sitemapAnalysis,
  internalLinksAnalysis,
};
