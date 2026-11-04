import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles and descriptions only — every number comes from the audit. See liveOnly.ts. */
const cro = (key: string, title: string, description: string, analyzedLabel: string) =>
  liveOnlyConfig('cro', 'CRO', key, title, description, analyzedLabel);

export const croPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'cro/clarity': cro(
    'clarity',
    'Clarity / Behavior Readiness',
    'Remove hesitation by making the next action obvious across the storefront.',
    'Pages',
  ),
  // Reports `unavailable` in the engine: abandoned-checkout data needs read_orders, which is
  // Protected Customer Data and is deliberately not requested.
  'cro/cart-recovery': cro(
    'cart-recovery',
    'Cart Recovery',
    'Recover high-intent shoppers with complete, timely, and measurable recovery flows.',
    'Abandoned carts',
  ),
  'cro/trust': cro(
    'trust',
    'Trust & Social Proof',
    'Make confidence visible with reviews, trust signals, and evidence close to the buying decision.',
    'Pages',
  ),
  'cro/returns': cro(
    'returns',
    'Returns Flow',
    'Make returns easy to understand and complete without unnecessary support friction.',
    'Policies',
  ),
  // Also `unavailable` — fulfilment data needs read_orders.
  'cro/tracking': cro(
    'tracking',
    'Order Tracking',
    'Keep customers informed after checkout with reliable tracking and proactive updates.',
    'Orders',
  ),
  'cro/cod': cro(
    'cod',
    'COD Checkout Quality',
    'Reduce failed deliveries and fraud risk with a clearer, better-validated COD checkout.',
    'Checkouts',
  ),
  'cro/options': cro(
    'options',
    'Product Options & Add-ons',
    'Help shoppers choose confidently with complete variants, guides, and relevant add-ons.',
    'Products',
  ),
  'cro/subscription': cro(
    'subscription',
    'Subscription Opportunity',
    'Turn replenishment behavior into a clear, convenient recurring purchase option.',
    'Products',
  ),
  'cro/wishlist': cro(
    'wishlist',
    'Wishlist',
    'Capture save-for-later intent and bring high-intent shoppers back to the catalog.',
    'Pages',
  ),
  'cro/locator': cro(
    'locator',
    'Store Locator',
    'Make physical locations easy to find with complete, trustworthy location information.',
    'Pages',
  ),
  'cro/mobile-ux': cro(
    'mobile-ux',
    'Mobile UX',
    'Remove mobile friction from tap targets, layout, and mobile conversion paths.',
    'Pages',
  ),
};
