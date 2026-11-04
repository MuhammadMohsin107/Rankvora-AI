import type { GenericSubPillarDetails } from './genericTypes';
import { liveOnlyDetails } from './liveOnly';

/**
 * ─── CRO · evidence table config ─────────────────────────────────────
 *
 * COLUMN DEFINITIONS ONLY — see liveOnly.ts for why every row list here is empty.
 *
 * Each entry previously carried three worked example rows ("Product pages · Primary add-to-cart
 * action visible above the fold · 77%") describing a store that does not exist. The repository
 * replaces `evidence.rows` with the audit's own, so none of it was ever displayed — which is
 * precisely what made it easy to mistake for real data when reading the source.
 */

const details = (
  title: string,
  subtitle: string,
  searchPlaceholder: string,
  opportunity: { title: string; description: string },
) => liveOnlyDetails(title, subtitle, searchPlaceholder, 'Surface', opportunity);

export const croTables: Record<string, GenericSubPillarDetails> = {
  'cro/clarity': details(
    'CTA Clarity by Surface',
    'Pages where the next action is clear, weak, or missing.',
    'Search by page or CTA…',
    {
      title: 'Make the next action obvious on flagged pages',
      description: 'A shopper who cannot see what to do next does not hunt for it — they leave.',
    },
  ),
  'cro/cart-recovery': details(
    'Cart Recovery Flow Coverage',
    'Recovery journeys available for abandoned-cart shoppers.',
    'Search by flow…',
    {
      title: 'Abandoned-cart data needs an extra Shopify permission',
      description: 'This reads abandoned checkouts, which requires read_orders — Protected Customer Data that Rankvora AI deliberately does not request.',
    },
  ),
  'cro/trust': details(
    'Trust Signal Coverage',
    'Review widgets, badges and policy links as they actually render on the storefront.',
    'Search by trust signal…',
    {
      title: 'Put confidence signals near the buying decision',
      description: 'Reviews and policy links matter most where the shopper is deciding, not on a separate page.',
    },
  ),
  'cro/returns': details(
    'Returns Journey Readiness',
    'How much of the returns journey the published policy actually explains.',
    'Search by returns step…',
    {
      title: 'Answer the returns questions shoppers ask before buying',
      description: 'An unclear returns policy is a reason not to buy, not just a support cost afterwards.',
    },
  ),
  'cro/tracking': details(
    'Order Tracking Coverage',
    'Tracking and proactive delivery visibility after checkout.',
    'Search by tracking signal…',
    {
      title: 'Fulfilment data needs an extra Shopify permission',
      description: 'This reads order fulfilment, which requires read_orders — Protected Customer Data that Rankvora AI deliberately does not request.',
    },
  ),
  'cro/cod': details(
    'COD Checkout Quality',
    'Cash-on-delivery configuration, which lives in checkout settings Rankvora AI cannot inspect.',
    'Search by checkout signal…',
    {
      title: 'Checkout payment configuration is not readable',
      description: 'No current permission exposes it, and page copy is not proof of how checkout is configured — so this reports "not measured" rather than a guess.',
    },
  ),
  'cro/options': details(
    'Product Option Coverage',
    'Variants and option structure, read from real product data.',
    'Search by product option…',
    {
      title: 'Give shoppers something to choose between',
      description: 'Several variants with no named option leaves both shoppers and agents guessing which is which.',
    },
  ),
  'cro/subscription': details(
    'Subscription Opportunity',
    'Selling-plan enrolment across the catalog.',
    'Search by subscription status…',
    {
      title: 'Offer recurring purchase where it fits',
      description: 'Replenishable products left off a subscription plan make shoppers re-buy manually, or not at all.',
    },
  ),
  'cro/wishlist': details(
    'Wishlist Intent Coverage',
    'Wishlist capability as it renders on the storefront.',
    'Search by wishlist signal…',
    {
      title: 'Capture save-for-later intent',
      description: 'Without somewhere to save a product, a shopper who is not ready to buy simply leaves.',
    },
  ),
  'cro/locator': details(
    'Store Locator Data Quality',
    'Store-locator presence as it renders on the storefront.',
    'Search by location…',
    {
      title: 'Make physical locations findable',
      description: 'Shoppers checking whether they can collect locally need to find that answer on the site.',
    },
  ),
  'cro/mobile-ux': details(
    'Mobile UX by Page',
    'Tap targets, layout stability and conversion-path readiness at a phone viewport.',
    'Search by page or issue…',
    {
      title: 'Mobile behaviour needs a rendering browser',
      description: 'Rankvora AI fetches pages, it does not render them, so viewport behaviour reports "not measured" rather than an inference from markup.',
    },
  ),
};
