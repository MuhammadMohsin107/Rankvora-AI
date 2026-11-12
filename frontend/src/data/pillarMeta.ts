// ─── Pillar structural metadata ──────────────────────────────────────
// Navigation structure, icon keys and color tokens for each pillar.
// None of this is audit data — it's the same kind of static UI mapping
// as a notification type→icon lookup — so it stays a frontend catalog
// even after scores/findings move to the database (see schema.ts's own
// "deliberately excluded: UI-only, derived, or placeholder" note).

import { isPillarVisible } from '../config/modules';
import type { PillarKey, ScoreStatus, SubPillar } from './dashboard/dashboard.types';

export interface PillarMeta {
  key: PillarKey;
  label: string;
  icon: string;
  /**
   * The pillar's accent, as a CSS variable rather than a literal.
   *
   * WHY NOT A HEX: this value is used as TEXT as well as a fill — the status badge on Reports
   * colours its label with it — and the light SEO accent #4f46e5 is a dark indigo measuring
   * about 3.2:1 on the dark ground, a WCAG AA failure for the small bold type it labels.
   * index.css carries a lifted dark-mode value for each pillar, so this single reference is
   * correct in both themes.
   *
   * VALID ONLY IN A CSS CONTEXT — a style prop, or a Tailwind arbitrary value. A canvas or WebGL
   * consumer needs a resolved colour and would have to read it via getComputedStyle.
   */
  color: string;
  /** The translucent same-hue ground the accent sits on in a badge. Its own token because an
   * alpha suffix cannot be concatenated onto a var(), which is what the old `${color}12` did. */
  tint: string;
  subPillars: SubPillar[];
}

export const pillarMeta: Record<PillarKey, PillarMeta> = {
  seo: {
    key: 'seo',
    label: 'SEO',
    icon: 'search',
    color: 'var(--c-pillar-seo)',
    tint: 'var(--c-pillar-seo-tint)',
    // ids are the ROUTE slugs (/seo/<id>) and the values stored in findings.subPillar.
    subPillars: [
      { id: 'title-tags', label: 'Title tags' },
      { id: 'meta-descriptions', label: 'Meta descriptions' },
      { id: 'schema', label: 'Schema / JSON-LD' },
      { id: 'image-alt-text', label: 'Image alt text' },
      { id: 'canonicals', label: 'Canonicals & duplicates' },
      { id: 'handles-redirects', label: 'Handles & redirects' },
      { id: 'sitemap', label: 'Sitemap & indexability' },
      { id: 'internal-links', label: 'Internal links & 404s' },
    ],
  },
  content: {
    key: 'content',
    label: 'Content',
    icon: 'file-text',
    color: 'var(--c-pillar-content)',
    tint: 'var(--c-pillar-content-tint)',
    subPillars: [
      { id: 'product-descriptions', label: 'Product descriptions' },
      { id: 'collection-descriptions', label: 'Collection descriptions' },
      /**
       * MISSING, while the check that fills it ran on every audit.
       *
       * `content.metafields` is registered in the engine, writes an audit_scores row under this
       * id and raises findings a merchant can already see on the dashboard
       * ("Metafields filled in on under half the catalog"). Absent from this list, the area never
       * appeared on /content, "Areas Measured" counted 4 of 5 where it should have been 5 of 6,
       * and /content/metafields — the route a merchant reaches by clicking that very finding —
       * resolved to NotFound. The engine was measuring something the UI had no way to show.
       */
      { id: 'metafields', label: 'Metafields' },
      // Slug stays 'dup-templated' — it is the identifier stored in findings.sub_pillar and in
      // every audit already recorded. Only the LABEL changed: "Duplicate / Templated Copy" named
      // the defect, while its siblings all name the quality being measured (Blog Freshness, Media Richness), so it read as the odd one out.
      { id: 'dup-templated', label: 'Copy Uniqueness' },
      { id: 'blog-freshness', label: 'Blog freshness' },
      { id: 'media-richness', label: 'Media richness' },
    ],
  },
  speed: {
    key: 'speed',
    label: 'Speed',
    icon: 'zap',
    color: 'var(--c-pillar-speed)',
    tint: 'var(--c-pillar-speed-tint)',
    subPillars: [
      { id: 'cwv', label: 'Core Web Vitals' },
      { id: 'image-weight', label: 'Image Optimization' },
      { id: 'app-bloat', label: 'App & script bloat' },
      { id: 'theme-weight', label: 'Theme weight / fonts / lazy-load' },
    ],
  },
  cro: {
    key: 'cro',
    label: 'CRO',
    icon: 'target',
    color: 'var(--c-pillar-cro)',
    tint: 'var(--c-pillar-cro-tint)',
    subPillars: [
      { id: 'clarity', label: 'Clarity / behavior readiness' },
      { id: 'cart-recovery', label: 'Cart recovery' },
      { id: 'trust', label: 'Trust & social proof' },
      { id: 'returns', label: 'Returns flow' },
      { id: 'tracking', label: 'Order tracking' },
      { id: 'cod', label: 'COD checkout quality' },
      { id: 'options', label: 'Product options / add-ons' },
      { id: 'subscription', label: 'Subscription opportunity' },
      { id: 'wishlist', label: 'Wishlist' },
      { id: 'locator', label: 'Store locator' },
      { id: 'mobile-ux', label: 'Mobile UX' },
    ],
  },
  'ai-discovery': {
    key: 'ai-discovery',
    label: 'AI Discovery',
    icon: 'sparkles',
    color: 'var(--c-pillar-ai)',
    tint: 'var(--c-pillar-ai-tint)',
    subPillars: [
      { id: 'agents-md', label: 'agents.md / llms.txt' },
      { id: 'agentic-attrs', label: 'Agentic commerce attributes' },
      { id: 'answerable-qa', label: 'Answerable Q&A + FAQ schema' },
      { id: 'feed', label: 'Catalog / feed readiness' },
      { id: 'indexing-freshness', label: 'Real-time indexing readiness' },
      { id: 'indexnow', label: 'IndexNow readiness' },
      { id: 'prompt-tracking', label: 'Prompt tracking' },
    ],
  },
};

/** Every pillar the app knows, in canonical order. Hidden pillars are in it; see `pillarOrder`. */
const ALL_PILLARS: PillarKey[] = ['seo', 'content', 'speed', 'cro', 'ai-discovery'];

/**
 * Canonical display order of the pillars the customer can SEE — sidebar nav, dashboard rows, report
 * tables, search. A pillar switched off in config/modules.ts is not in it, which is what keeps a
 * hidden pillar out of every one of those lists at once; `pillarMeta` above still describes it, so
 * switching it back on needs nothing else.
 */
export const pillarOrder: PillarKey[] = ALL_PILLARS.filter(isPillarVisible);

/**
 * Route for each visible pillar dashboard. Derived from pillarOrder so it cannot fall out of step
 * with the pillars themselves — the same map was previously written out by hand in BOTH
 * components/Sidebar.tsx and components/dashboard/scoreTone.ts, where a future route rename
 * updated in one place and not the other would have silently broken the other's navigation.
 * A hidden pillar has no entry, so nothing can link to its page.
 */
export const pillarRoutes: Record<PillarKey, string> = Object.fromEntries(
  pillarOrder.map((key) => [key, `/${key}`]),
) as Record<PillarKey, string>;

/** The pillars as an ordered list, for components that iterate rather than look up. */
export const pillarList: PillarMeta[] = pillarOrder.map((key) => pillarMeta[key]);

/** Resolves a sub-pillar slug (as stored in `findings.subPillar`) to its display label. */
export function subPillarLabel(pillar: PillarKey, slug: string): string {
  return pillarMeta[pillar]?.subPillars.find((subPillar) => subPillar.id === slug)?.label ?? slug;
}

/** Derives a status enum + label from a real 0-100 score — no fixed per-pillar narrative to go stale. */
export function scoreToStatus(score: number): { status: ScoreStatus; statusLabel: string } {
  if (score >= 90) return { status: 'excellent', statusLabel: 'Excellent' };
  if (score >= 75) return { status: 'good', statusLabel: 'Good' };
  if (score >= 50) return { status: 'needs-work', statusLabel: 'Needs Work' };
  return { status: 'critical', statusLabel: 'Critical' };
}

export function describePillar(label: string, score: number, checksTotal: number, checksPassed: number): string {
  const { status } = scoreToStatus(score);
  if (status === 'excellent') return `${label} is performing excellently — ${checksPassed} of ${checksTotal} analyzed items are healthy.`;
  if (status === 'good') return `${label} is in good shape with room to improve — ${checksPassed} of ${checksTotal} analyzed items are healthy.`;
  if (status === 'needs-work') return `${label} needs attention — only ${checksPassed} of ${checksTotal} analyzed items are healthy.`;
  return `${label} requires immediate attention — just ${checksPassed} of ${checksTotal} analyzed items are healthy.`;
}
