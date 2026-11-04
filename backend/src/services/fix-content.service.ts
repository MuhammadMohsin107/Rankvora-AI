import { resolveShopifyClient } from '../audit-engine/store-data/index.js';
import { htmlToText } from '../audit-engine/checks/shared/html.js';
import type { SeoResourceType } from '../lib/ai/fix-policy.js';
import { describeError } from '../lib/logger.js';

/**
 * The GraphQL type behind each page-like resource. The same mapping fix-apply.service.ts writes
 * with; repeated here rather than imported because that module imports the fix planner, and the
 * planner imports this one — importing back would make the three a cycle.
 */
const GID_TYPE: Record<SeoResourceType, string> = { product: 'Product', collection: 'Collection', page: 'Page', article: 'Article' };

/** `gid://shopify/Product/123` from the numeric id the audit stores; a gid is passed through. */
function gidOf(resourceType: SeoResourceType, resourceId: string): string {
  const raw = resourceId.trim();
  return raw.startsWith('gid://') ? raw : `gid://shopify/${GID_TYPE[resourceType]}/${raw}`;
}

/**
 * ─── What a resource says TODAY, read from the store for the fix writer ──────────────────────
 *
 * The audit keeps one short row per resource — a name, the value it judged and, for a description,
 * a 160-character excerpt of the page's copy. That is enough to SCORE a page and far too little to
 * WRITE for one: a model handed an excerpt and a name writes from the excerpt and the name.
 *
 * So before a value is drafted, the resources it is for are read live from Shopify, in ONE request
 * (`nodes(ids:)`), and the model is given their own copy and their own catalogue facts — the
 * product's type, vendor and tags, the article's blog. Every word of it is the merchant's; nothing
 * is fetched from anywhere else and nothing is filled in where Shopify had nothing.
 *
 * READ-ONLY and best-effort. The scopes are the ones the audit already uses (read_products for
 * products and collections, read_content for pages and articles). If the read fails — no
 * connection, an expired token, a resource deleted since the audit — the caller falls back to what
 * the audit itself recorded, which is real data too, and says which one it used.
 */

/** What one resource's own content contributes to a draft. */
export interface ResourceContent {
  /** Its current name in Shopify. */
  title: string;
  /** Its own body copy as plain text — the description, page or article body. Empty when it has none. */
  text: string;
  /** Catalogue facts as "Label: value" lines, only those Shopify actually holds. */
  facts: string[];
}

const CONTENT_QUERY = `
  query ScoreloFixContent($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product { id title descriptionHtml productType vendor tags }
      ... on Collection { id title descriptionHtml }
      ... on Page { id title body }
      ... on Article { id title body blog { title } }
    }
  }
`;

export interface ContentNode {
  __typename?: string;
  id?: string;
  title?: string | null;
  descriptionHtml?: string | null;
  body?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[] | null;
  blog?: { title?: string | null } | null;
}

/** Tags are a merchant's own words, but a long list is noise to a copywriter. */
const MAX_TAGS = 12;

const clean = (value: string | null | undefined): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

export function toResourceContent(node: ContentNode): ResourceContent {
  const facts: string[] = [];
  const productType = clean(node.productType);
  const vendor = clean(node.vendor);
  const tags = (node.tags ?? []).map(clean).filter(Boolean).slice(0, MAX_TAGS);
  const blog = clean(node.blog?.title);
  if (productType) facts.push(`Product type: ${productType}`);
  if (vendor) facts.push(`Brand/vendor: ${vendor}`);
  if (tags.length > 0) facts.push(`Tags: ${tags.join(', ')}`);
  if (blog) facts.push(`Blog: ${blog}`);
  return {
    title: clean(node.title),
    text: htmlToText(node.descriptionHtml ?? node.body ?? ''),
    facts,
  };
}

/**
 * Reads the current content of the given resources, keyed by their ref (`product:123`).
 *
 * Returns an empty map, never throws, when the store cannot be read: drafting then goes ahead on
 * the audit's own record and says so. Only page-like resources are read; an image's alt text is
 * built from the merchant's template from fields the audit already holds.
 */
export async function readResourceContent(
  storeId: number,
  targets: Array<{ ref: string; resourceType: string; resourceId: string }>,
): Promise<Map<string, ResourceContent>> {
  const readable = targets.filter((target): target is typeof target & { resourceType: SeoResourceType } =>
    ['product', 'collection', 'page', 'article'].includes(target.resourceType));
  const found = new Map<string, ResourceContent>();
  if (readable.length === 0) return found;

  const byGid = new Map(readable.map((target) => [gidOf(target.resourceType, target.resourceId), target.ref]));

  try {
    const client = await resolveShopifyClient(storeId);
    const data = await client.graphql<{ nodes?: Array<ContentNode | null> }>(CONTENT_QUERY, { ids: [...byGid.keys()] });
    for (const node of data?.nodes ?? []) {
      // A resource deleted since the audit comes back as null and is simply not in the map.
      if (!node?.id) continue;
      const ref = byGid.get(node.id);
      if (ref) found.set(ref, toResourceContent(node));
    }
  } catch (error) {
    // Logged with the store, never with the request: the transport carries the access token.
    console.warn(`[scorelo-fix] could not read current content for store ${storeId}; drafting from the audit's record — ${describeError(error)}`);
  }

  return found;
}
