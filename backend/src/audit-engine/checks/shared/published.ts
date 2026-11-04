import type { SnapshotProduct } from '../../store-data/types.js';

// ─── What a shopper — and so an AI assistant — can actually reach ────
// The snapshot carries EVERY product the Admin API returns: active, draft and archived alike. That
// is right for checks about the merchant's catalogue records, and wrong for anything that claims to
// describe what an assistant can find. A draft product's storefront URL answers 404, so counting it
// in an AI Discovery figure measures a page nobody can see, and listing it in llms.txt publishes a
// link to it.
//
// One definition, shared, so the crawler, the checks and the generated files cannot disagree about
// which products are live. It matches the crawler's own rule (storefront/targets.ts): an ACTIVE
// product with a publication date on the online store.

/** True when the product is active and published to the online store. */
export function isPublishedProduct(product: Pick<SnapshotProduct, 'status' | 'publishedAt'>): boolean {
  return product.status.trim().toLowerCase() === 'active' && product.publishedAt !== null;
}

/** The products an assistant can reach, and how many were left out because it cannot. */
export function splitByPublication<T extends Pick<SnapshotProduct, 'status' | 'publishedAt'>>(
  products: T[],
): { published: T[]; unpublished: number } {
  const published = products.filter(isPublishedProduct);
  return { published, unpublished: products.length - published.length };
}

/**
 * The sentence that says products were left out, or '' when none were.
 *
 * Stated wherever the exclusion changes a count, so "12 products" beside a Shopify admin showing
 * 17 is explained on the page rather than looking like Rankvora AI lost five.
 */
export function unpublishedNote(unpublished: number): string {
  if (unpublished <= 0) return '';
  return ` ${unpublished} draft, archived or unpublished ${unpublished === 1 ? 'product was' : 'products were'} left out — no shopper or assistant can reach ${unpublished === 1 ? 'it' : 'them'}.`;
}

/**
 * True when a page or article is published now.
 *
 * A null date is unpublished; a future date is scheduled, and is not visible until it arrives.
 * `now` is the snapshot's capture time, so a check reads the store as it was when it was read.
 */
export function isLiveAt(publishedAt: string | null, now: Date): boolean {
  if (publishedAt === null) return false;
  const time = Date.parse(publishedAt);
  return Number.isFinite(time) && time <= now.getTime();
}
