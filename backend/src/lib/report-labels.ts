/**
 * Display labels for the CSV export.
 *
 * The database stores route slugs ('dup-templated', 'ai-discovery'); an export a merchant opens
 * in Excel has to read like the app they exported it from, so the slugs are mapped back to the
 * same wording the UI uses (frontend/src/data/pillarMeta.ts).
 *
 * Anything not listed falls back to a title-cased slug rather than throwing or printing the raw
 * value — a sub-pillar added to the engine tomorrow exports as "New Check", not as a crash and
 * not as `new-check`. That fallback is why this map never has to be kept exhaustive.
 */

const PILLAR_LABELS: Record<string, string> = {
  seo: 'SEO',
  content: 'Content',
  speed: 'Speed',
  cro: 'CRO',
  'ai-discovery': 'AI Discovery',
};

const SUB_PILLAR_LABELS: Record<string, string> = {
  // SEO
  'title-tags': 'Title tags',
  'meta-descriptions': 'Meta descriptions',
  schema: 'Schema / JSON-LD',
  'image-alt-text': 'Image alt text',
  canonicals: 'Canonicals & duplicates',
  'handles-redirects': 'Handles & redirects',
  sitemap: 'Sitemap & indexability',
  'internal-links': 'Internal links & 404s',
  // Content
  'product-descriptions': 'Product descriptions',
  'collection-descriptions': 'Collection descriptions',
  'dup-templated': 'Copy Uniqueness',
  'blog-freshness': 'Blog freshness',
  'media-richness': 'Media richness',
  // Speed
  cwv: 'Core Web Vitals',
  'image-weight': 'Image Optimization',
  'app-bloat': 'App & script bloat',
  'theme-weight': 'Theme weight / fonts / lazy-load',
  // CRO
  clarity: 'Clarity / behavior readiness',
  'cart-recovery': 'Cart recovery',
  trust: 'Trust & social proof',
  returns: 'Returns flow',
  tracking: 'Order tracking',
  cod: 'COD checkout quality',
  options: 'Product options / add-ons',
  subscription: 'Subscription opportunity',
  wishlist: 'Wishlist',
  locator: 'Store locator',
  'mobile-ux': 'Mobile UX',
  // AI Discovery
  'agents-md': 'agents.md / llms.txt',
  'agentic-attrs': 'Agentic commerce attributes',
  'answerable-qa': 'Answerable Q&A + FAQ schema',
  feed: 'Catalog / feed readiness',
  indexnow: 'IndexNow readiness',
  'indexing-freshness': 'Real-time indexing readiness',
  'prompt-tracking': 'Prompt tracking',
};

function titleCase(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}

export function pillarLabel(pillar: string): string {
  return PILLAR_LABELS[pillar] ?? titleCase(pillar);
}

export function subPillarLabel(subPillar: string): string {
  return SUB_PILLAR_LABELS[subPillar] ?? titleCase(subPillar);
}

/** Report order: the same top-to-bottom order the app presents the pillars in. */
export const PILLAR_ORDER = ['seo', 'content', 'speed', 'cro', 'ai-discovery'];

export function pillarRank(pillar: string): number {
  const index = PILLAR_ORDER.indexOf(pillar);
  return index === -1 ? PILLAR_ORDER.length : index;
}

/** Critical first — an issue list that opens with "low" is not a priority list. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Score bands, matching the app's status wording exactly. */
export function scoreStatus(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Needs Work';
  return 'Critical';
}
