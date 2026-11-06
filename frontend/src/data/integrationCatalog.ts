// ─── Integration structural metadata ─────────────────────────────────
// Provider names and "data received" chips are a static
// catalog — the backend schema deliberately only persists connection
// STATE (status/accountDetail/lastSyncedAt/notice), see
// backend/src/db/schema.ts's integrations table comment. Same pattern
// as pillarMeta.ts.

export interface IntegrationCatalogEntry {
  provider: string;
  group: string;
  name: string;
  data: string[];
  /**
   * Whether a real connector exists for this provider today.
   *
   * Only Shopify has one. The rest are listed so the roadmap is visible, but they must not offer
   * a Connect button: there is nothing behind it, and a button that flips a status column without
   * authorizing anything is a false claim about the merchant's data.
   */
  available: boolean;
}

export const integrationCatalog: Record<string, IntegrationCatalogEntry> = {
  shopify: {
    provider: 'shopify',
    group: 'Store',
    name: 'Shopify',
    // Must describe what the granted scopes actually permit. This previously advertised "Orders
    // and inventory", which Rankvora AI neither requests nor reads — read_orders is protected
    // customer data and is deliberately not part of the scope set.
    data: ['Products and collections', 'Pages, blogs and policies', 'SEO fields and metafields'],
    available: true,
  },
  'search-console': {
    provider: 'search-console',
    group: 'Analytics',
    name: 'Google Search Console',
    // Narrowed to what the read-only scope actually returns. "Index coverage" was advertised and is
    // a different API surface Rankvora AI does not read — the same overclaiming the Shopify entry was
    // corrected for.
    data: ['Search queries', 'Clicks and impressions', 'CTR and average position'],
    available: true,
  },
  analytics: {
    provider: 'analytics',
    group: 'Analytics',
    name: 'Google Analytics',
    // Narrowed to what the read-only GA4 scope and the three queries behind this connector
    // actually return. The earlier wording promised "acquisition context" in general, which is a
    // much larger surface than sessions grouped by default channel — the same overclaiming the
    // Shopify and Search Console entries were corrected for.
    data: ['Sessions and engagement', 'Top landing pages', 'Channels and conversions'],
    available: true,
  },
  pagespeed: {
    provider: 'pagespeed',
    group: 'Performance',
    name: 'PageSpeed Insights',
    // Narrowed to what a run actually returns. "Template performance" was advertised and is not
    // measured — the connector measures the storefront home page on two devices, not one report
    // per template — the same overclaiming the Shopify and Search Console entries were corrected
    // for. LCP and CLS come from both halves; INP is field-only, because there is no lab INP.
    data: ['LCP, INP and CLS from real visitors', 'Lighthouse lab test', 'Mobile and desktop'],
    available: true,
  },
  clarity: {
    provider: 'clarity',
    group: 'Analytics',
    name: 'Microsoft Clarity',
    data: ['Session recordings', 'Heatmaps', 'Rage-click signals'],
    available: false,
  },
  'merchant-center': {
    provider: 'merchant-center',
    group: 'AI / Discovery',
    name: 'Google Merchant Center',
    data: ['Product feed status', 'Availability and price', 'Identifier coverage'],
    available: false,
  },
};

export function catalogEntryFor(provider: string): IntegrationCatalogEntry {
  return integrationCatalog[provider] ?? {
    provider, group: 'Other', name: provider, data: [], available: false,
  };
}
