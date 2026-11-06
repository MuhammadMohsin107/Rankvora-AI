import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles only — every number comes from the audit. See liveOnly.ts. */
const speed = (key: string, title: string, analyzedLabel: string) =>
  liveOnlyConfig('speed', 'Speed', key, title, analyzedLabel);

export const speedPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'speed/cwv': speed(
    'cwv',
    'Core Web Vitals',
    // The unit is a MEASUREMENT — one Core Web Vital on one device — not a page. A run measures
    // the storefront on mobile and desktop, so "Pages" would have described a count nothing
    // produces.
    'Measurements',
  ),
  'speed/image-weight': speed(
    'image-weight',
    'Image Optimization',
    'Images',
  ),
  'speed/app-bloat': speed(
    'app-bloat',
    'App & Script Bloat',
    'Sources',
  ),
  'speed/theme-weight': speed(
    'theme-weight',
    'Theme Weight / Fonts / Lazy-load',
    'Assets',
  ),
};
