import { ChevronRight, Home } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { hiddenPillarKeys } from '../config/modules';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

const routeLabels: Record<string, string> = {
  seo: 'SEO',
  content: 'Content',
  speed: 'Speed',
  cro: 'CRO',
  'ai-discovery': 'AI Discovery',
  'title-tags': 'Title Tags',
  'meta-descriptions': 'Meta Descriptions',
  schema: 'Schema / JSON-LD',
  'image-alt-text': 'Image Alt Text',
  canonicals: 'Canonicals & Duplicates',
  'handles-redirects': 'Handles & Redirects',
  sitemap: 'Sitemap & Indexability',
  'internal-links': 'Internal Links & 404s',
  'product-descriptions': 'Product Descriptions',
  'collection-descriptions': 'Collection Descriptions',
  // The fallback title-cases an unmapped slug to the same string, so this changes nothing on
  // screen — it is here because every other sub-pillar is, and a map with one hole is the kind of
  // gap that is only noticed once a slug stops title-casing cleanly.
  metafields: 'Metafields',
  'dup-templated': 'Copy Uniqueness',
  'blog-freshness': 'Blog Freshness',
  'media-richness': 'Media Richness',
  cwv: 'Core Web Vitals',
  'image-weight': 'Image Optimization',
  'app-bloat': 'App & Script Bloat',
  'theme-weight': 'Theme Weight / Fonts / Lazy-load',
  clarity: 'Clarity / Behavior Readiness',
  'cart-recovery': 'Cart Recovery',
  trust: 'Trust & Social Proof',
  returns: 'Returns Flow',
  tracking: 'Order Tracking',
  cod: 'COD Checkout Quality',
  options: 'Product Options / Add-ons',
  subscription: 'Subscription Opportunity',
  wishlist: 'Wishlist',
  locator: 'Store Locator',
  'mobile-ux': 'Mobile UX',
  'agents-md': 'agents.md / llms.txt',
  'agentic-attrs': 'Agentic Commerce Attributes',
  'answerable-qa': 'Answerable Q&A + FAQ Schema',
  feed: 'Catalog / Feed Readiness',
  products: 'Products',
  collections: 'Collections',
  'blog-articles': 'Blog articles',
  integrations: 'Integrations',
};

/** What one item's page is called in the trail, by the list it belongs to. */
const itemCrumb: Record<string, string> = { products: 'Product', collections: 'Collection', 'blog-articles': 'Article' };

function labelFor(segment: string) {
  return routeLabels[segment] ?? segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface BreadcrumbsProps {
  compact?: boolean;
}

export default function Breadcrumbs({ compact = false }: BreadcrumbsProps) {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  // An address under a pillar switched off in config/modules.ts is not a page of this app, so its
  // trail names nothing — the pillar's name is never written out.
  const underHiddenPillar = hiddenPillarKeys().some((key) => key === segments[0]);
  const items: BreadcrumbItem[] = (underHiddenPillar ? [] : segments).map((segment, index) => ({
    // /products/8123456789 is one item's page: its Shopify id means nothing as a crumb.
    label: /^\d+$/.test(segment) && itemCrumb[segments[index - 1]] ? itemCrumb[segments[index - 1]] : labelFor(segment),
    href: index === segments.length - 1 ? undefined : `/${segments.slice(0, index + 1).join('/')}`,
  }));

  return (
    <nav aria-label="Breadcrumb" className={compact ? 'min-w-0' : 'page-shell pb-0'}>
      {/* Tight by design: a location indicator in a 48px bar, not navigation the eye should stop
          on. Two things were making a three-level trail read as a long strip of chrome:

          1. The word "Dashboard" as the root crumb — roughly 60px to repeat what the sidebar's
             always-visible Dashboard item and the logo both already offer. It is a HOME ICON now:
             same link, same destination, a fifth of the width.
          2. Padding on every crumb plus wide separator margins. The separators now sit directly
             against the labels.

          Nothing was removed — home is still one click, and still announced to screen readers. */}
      <ol className="flex min-w-0 items-center overflow-hidden text-[11px] leading-none text-surface-500">
        <li className="flex flex-shrink-0 items-center">
          <Link
            to="/"
            aria-label="Dashboard"
            title="Dashboard"
            className="flex items-center rounded p-0.5 text-surface-400 transition-colors hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Home size={12} aria-hidden="true" />
          </Link>
        </li>
        {items.map((item) => (
          <li key={item.href ?? item.label} className="flex min-w-0 items-center">
            <ChevronRight size={10} className="mx-px flex-shrink-0 text-surface-300" aria-hidden="true" />
            {item.href ? (
              <Link to={item.href} className="truncate rounded transition-colors hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {item.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-surface-800" aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}