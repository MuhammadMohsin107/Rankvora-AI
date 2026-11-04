import type { GenericSubPillarConfig } from './genericTypes';
import { contentPillarCatalog } from './contentCatalog';
import { speedPillarCatalog } from './speedCatalog';
import { aiPillarCatalog } from './aiCatalog';
import { croPillarCatalog } from './croCatalog';

/**
 * Every generic (non-SEO) sub-pillar, keyed by route (e.g. "speed/cwv").
 * SEO sub-pillars render through their own master template
 * (pages/seo/SeoSubPillarPage) and are intentionally not listed here.
 */
export const genericCatalog: Record<string, GenericSubPillarConfig> = {
  ...contentPillarCatalog,
  ...speedPillarCatalog,
  ...aiPillarCatalog,
  ...croPillarCatalog,
};
