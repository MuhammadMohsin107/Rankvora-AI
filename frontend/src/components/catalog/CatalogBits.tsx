import { useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, FolderOpen, ImageOff, Newspaper, Package, type LucideIcon } from 'lucide-react';
import type { CatalogCheckResult, CatalogItem } from '../../data/catalog.repository';
import Badge from '../polaris/Badge';
import { CATALOG_KINDS, type CatalogKind } from '../../data/catalogKinds';

/**
 * Pieces the catalog lists (Products, Collections, Blog articles) and an item's own page share: the
 * photo, the issue pills and the verdict styling. Presentation only — every value they show comes
 * from the catalog the audit recorded.
 */

/**
 * A small rendition of a Shopify CDN image. The URL is the one the audit recorded; `width` is
 * Shopify's own image-transform parameter, so a row loads a thumbnail rather than the
 * multi-megabyte original. Any other host is left exactly as recorded.
 */
function thumbnailUrl(src: string, width: number): string {
  try {
    const url = new URL(src);
    if (url.hostname.endsWith('cdn.shopify.com') || url.pathname.includes('/cdn/shop/')) url.searchParams.set('width', String(width));
    return url.toString();
  } catch {
    return src;
  }
}

const THUMB_SIZES = {
  xs: { box: 'h-9 w-9 rounded-md', px: 72, icon: 14 },
  sm: { box: 'h-10 w-10 rounded-lg', px: 80, icon: 15 },
  md: { box: 'h-12 w-12 rounded-lg', px: 96, icon: 16 },
  lg: { box: 'h-16 w-16 rounded-xl', px: 128, icon: 20 },
} as const;

/** What stands in for a photo the audit did not record: a plain icon for the kind, never a stock image. */
export const KIND_ICON: Record<CatalogKind, LucideIcon> = { product: Package, collection: FolderOpen, article: Newspaper };

/** The item's photo, or a plain placeholder when the audit recorded none. */
export function Thumbnail({ src, name, size = 'sm', kind = 'product' }: { src: string | null; name: string; size?: keyof typeof THUMB_SIZES; kind?: CatalogKind }) {
  const [failed, setFailed] = useState(false);
  const { box, px, icon } = THUMB_SIZES[size];
  const Placeholder = KIND_ICON[kind];
  return (
    <span className={`flex flex-shrink-0 items-center justify-center overflow-hidden border border-surface-200 bg-surface-0 ${box}`}>
      {src && !failed ? (
        <img src={thumbnailUrl(src, px)} alt={name} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span title={src ? 'The recorded image could not be loaded' : `No ${CATALOG_KINDS[kind].noun} image was recorded by the audit`}>
          {src ? <ImageOff size={icon} className="text-surface-300" aria-hidden="true" /> : <Placeholder size={icon} className="text-surface-300" aria-hidden="true" />}
        </span>
      )}
    </span>
  );
}

/** "4 Critical Issues · 4 Warnings · 3 Passing" — the counts as Polaris badges, zeros left out. */
export function IssueBadges({ item }: { item: Pick<CatalogItem, 'critical' | 'warnings' | 'passing'> }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {item.critical > 0 && (
        <Badge tone="critical">
          {item.critical} Critical {item.critical === 1 ? 'Issue' : 'Issues'}
        </Badge>
      )}
      {item.warnings > 0 && (
        <Badge tone="warning">
          {item.warnings} {item.warnings === 1 ? 'Warning' : 'Warnings'}
        </Badge>
      )}
      {item.passing > 0 && <Badge tone="success">{item.passing} Passing</Badge>}
    </span>
  );
}

export const verdictStyle: Record<CatalogCheckResult['verdict'], {
  icon: typeof CheckCircle2;
  text: string;
  label: string;
  /** The tinted box a check's result sits in on an item's page. */
  callout: string;
}> = {
  critical: { icon: AlertOctagon, text: 'text-critical-600', label: 'Critical', callout: 'bg-critical-50 ring-critical-100' },
  warning: { icon: AlertTriangle, text: 'text-warning-600', label: 'Warning', callout: 'bg-warning-50 ring-warning-100' },
  passing: { icon: CheckCircle2, text: 'text-success-600', label: 'Passed', callout: 'bg-success-50 ring-success-100' },
};

/** "Sep 12, 2026" for a recorded timestamp; null when there is none or it does not parse. */
export function formatCatalogDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
