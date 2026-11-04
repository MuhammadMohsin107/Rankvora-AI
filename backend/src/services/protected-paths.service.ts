import { StoreDataError } from '../audit-engine/store-data/types.js';
import type { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { ApiError } from '../middleware/error.js';
import {
  findProtectedRule,
  readOnboardingPreferences,
} from './onboarding-preferences.service.js';

/**
 * ─── Pages the merchant said to leave alone ──────────────────────────
 *
 * Guided setup lets a merchant list storefront paths ("/collections/sale", "/pages/legal") that
 * Rankvora AI must never change. A promise like that is worth nothing as a display: it has to be a
 * hard stop at the one place a change leaves this product and reaches the store.
 *
 * FAILS CLOSED. If a store has protected paths and Rankvora AI cannot establish where a resource
 * lives, it does NOT write — an unverifiable page is treated as possibly protected, because the
 * cost of a refused fix is one click to retry, and the cost of an overwritten page the merchant
 * marked untouchable is the thing they asked us never to do.
 *
 * A store that protected nothing skips all of this and pays for no lookup.
 */

export type ProtectableKind = 'product' | 'collection' | 'page' | 'article';

/**
 * The storefront path a resource is served at.
 *
 * Shopify serves a product at /products/{handle}, a collection at /collections/{handle}, a page at
 * /pages/{handle} and an article at /blogs/{blog}/{handle}. Null when the handle needed to build it
 * is missing — and the caller then fails closed rather than guessing a path.
 */
export function storefrontPath(kind: ProtectableKind, handle: string | null, blogHandle?: string | null): string | null {
  if (!handle) return null;
  switch (kind) {
    case 'product':
      return `/products/${handle}`;
    case 'collection':
      return `/collections/${handle}`;
    case 'page':
      return `/pages/${handle}`;
    case 'article':
      return blogHandle ? `/blogs/${blogHandle}/${handle}` : null;
  }
}

const RESOURCE_PATH_QUERY = `
  query ScoreloResourcePath($id: ID!) {
    node(id: $id) {
      __typename
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on Article { handle blog { handle } }
    }
  }
`;

interface ResourcePathResponse {
  node?: {
    __typename?: string;
    handle?: string | null;
    blog?: { handle?: string | null } | null;
  } | null;
}

const KIND_BY_TYPENAME: Record<string, ProtectableKind> = {
  Product: 'product',
  Collection: 'collection',
  Page: 'page',
  Article: 'article',
};

/** Where a resource lives on the storefront, read from Shopify by its id. Null when it cannot be told. */
export async function readResourcePath(client: ShopifyClient, gid: string): Promise<string | null> {
  try {
    const data = await client.graphql<ResourcePathResponse>(RESOURCE_PATH_QUERY, { id: gid });
    const node = data.node;
    const kind = node?.__typename ? KIND_BY_TYPENAME[node.__typename] : undefined;
    if (!node || !kind) return null;
    return storefrontPath(kind, node.handle ?? null, node.blog?.handle ?? null);
  } catch (error) {
    if (error instanceof StoreDataError) return null;
    return null;
  }
}

export interface ProtectedVerdict {
  /** False means: do not write. */
  allowed: boolean;
  /** Why not, in words the merchant can act on. Empty when allowed. */
  reason: string;
}

const ALLOWED: ProtectedVerdict = { allowed: true, reason: '' };

/**
 * Whether a change to the resource at `path` may go ahead, given the store's protected paths.
 *
 * Pure — the caller supplies the rules and the path — so the decision itself is tested without a
 * database or a Shopify call. `path` null means the resource's location could not be established.
 */
export function judgeProtectedPath(protectedPaths: string[], path: string | null): ProtectedVerdict {
  if (protectedPaths.length === 0) return ALLOWED;
  if (path === null) {
    return {
      allowed: false,
      reason:
        'This was not changed because Rankvora AI could not confirm which page it belongs to, and you have pages marked as protected. Try again in a moment.',
    };
  }
  const rule = findProtectedRule(protectedPaths, path);
  if (rule === null) return ALLOWED;
  return {
    allowed: false,
    reason: `Protected: you asked Rankvora AI to leave ${rule} alone, so ${path} was not changed. Remove it from your protected pages in Guided setup to allow changes there.`,
  };
}

/** The store's protected paths. Empty for a store that never set any, which is almost every store. */
export async function protectedPathsFor(storeId: number): Promise<string[]> {
  return (await readOnboardingPreferences(storeId)).protectedPaths;
}

/**
 * Throws a 403 when a product's page is protected. For the image paths, which already hold the
 * product's handle from the read they did anyway — no extra lookup.
 */
export async function assertProductNotProtected(storeId: number, handle: string | null): Promise<void> {
  const protectedPaths = await protectedPathsFor(storeId);
  const verdict = judgeProtectedPath(protectedPaths, storefrontPath('product', handle));
  if (!verdict.allowed) throw new ApiError(403, verdict.reason, 'PAGE_PROTECTED');
}
