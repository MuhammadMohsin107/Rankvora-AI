import type { GenericSubPillarConfig } from './genericTypes';
import { liveOnlyConfig } from './liveOnly';

/** Titles only — every number comes from the audit. See liveOnly.ts. */
const cro = (key: string, title: string, analyzedLabel: string) =>
  liveOnlyConfig('cro', 'CRO', key, title, analyzedLabel);

export const croPillarCatalog: Record<string, GenericSubPillarConfig> = {
  'cro/clarity': cro(
    'clarity',
    'Clarity / Behavior Readiness',
    'Pages',
  ),
  // Reports `unavailable` in the engine: abandoned-checkout data needs read_orders, which is
  // Protected Customer Data and is deliberately not requested.
  'cro/cart-recovery': cro(
    'cart-recovery',
    'Cart Recovery',
    'Abandoned carts',
  ),
  'cro/trust': cro(
    'trust',
    'Trust & Social Proof',
    'Pages',
  ),
  'cro/returns': cro(
    'returns',
    'Returns Flow',
    'Policies',
  ),
  // Also `unavailable` — fulfilment data needs read_orders.
  'cro/tracking': cro(
    'tracking',
    'Order Tracking',
    'Orders',
  ),
  'cro/cod': cro(
    'cod',
    'COD Checkout Quality',
    'Checkouts',
  ),
  'cro/options': cro(
    'options',
    'Product Options & Add-ons',
    'Products',
  ),
  'cro/subscription': cro(
    'subscription',
    'Subscription Opportunity',
    'Products',
  ),
  'cro/wishlist': cro(
    'wishlist',
    'Wishlist',
    'Pages',
  ),
  'cro/locator': cro(
    'locator',
    'Store Locator',
    'Pages',
  ),
  'cro/mobile-ux': cro(
    'mobile-ux',
    'Mobile UX',
    'Pages',
  ),
};
