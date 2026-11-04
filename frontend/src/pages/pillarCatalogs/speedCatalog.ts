import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles and descriptions only — every number comes from the audit. See liveOnly.ts. */
const speed = (key: string, title: string, description: string, analyzedLabel: string) =>
  liveOnlyConfig('speed', 'Speed', key, title, description, analyzedLabel);

export const speedPillarCatalog: Record<string, GenericSubPillarConfig> = {
  // Every description below names what its check MEASURES, and stops there. The previous copy
  // promised compressed and modern image formats, deferred below-the-fold work and page-experience
  // signals in general — none of which any of these checks reads. A sub-pillar's description sits
  // directly above its score, so it is read as a description of that score.
  'speed/cwv': speed(
    'cwv',
    'Core Web Vitals',
    'LCP, INP and CLS as Google measures them — from real Chrome visitors where there are enough, and from a Lighthouse lab run where there are not.',
    // The unit is a MEASUREMENT — one Core Web Vital on one device — not a page. A run measures
    // the storefront on mobile and desktop, so "Pages" would have described a count nothing
    // produces.
    'Measurements',
  ),
  'speed/image-weight': speed(
    'image-weight',
    'Image Optimization',
    'Product images whose source file is far larger than any storefront breakpoint displays them at. Delivered bytes are a storefront measurement and are not claimed here.',
    'Images',
  ),
  'speed/app-bloat': speed(
    'app-bloat',
    'App & Script Bloat',
    'App embeds enabled in the theme and external scripts hardcoded into the layout — the third-party load that runs on every page and that the Admin API can see.',
    'Sources',
  ),
  'speed/theme-weight': speed(
    'theme-weight',
    'Theme Weight / Fonts / Lazy-load',
    'Theme scripts, stylesheets and fonts by stored size. Which assets a given page loads, and whether it lazy-loads them, needs a rendered page and is not measured.',
    'Assets',
  ),
};
