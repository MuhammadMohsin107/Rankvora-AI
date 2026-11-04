import type { StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { SchemaContextKind } from './types.js';

/**
 * ─── The Shopify field catalog ───────────────────────────────────────
 *
 * Every value a merchant can map a schema property to, and the code that reads it.
 *
 * THE READER AND THE LABEL LIVE TOGETHER ON PURPOSE. A catalog that only described the fields
 * would let the UI offer "Variant barcode (GTIN)" while the resolver looked somewhere else, and
 * the merchant would discover the mismatch as an empty property on a published page. Here a field
 * exists exactly when something can read it, so the list the UI shows IS the list that works.
 *
 * EVERY PATH BELOW IS A FIELD THAT ALREADY EXISTS IN StoreSnapshot. Nothing is aspirational: if
 * the audit cannot currently read it from Shopify, it is not offered. That is why there is no
 * `product.metafield.*` entry here — metafield KEYS are in the snapshot but their VALUES are not,
 * so metafields are a separate ValueSource kind that reports honestly until the provider reads
 * them (see resolver.ts).
 */

type Snapshot = StoreSnapshot;
type Product = Snapshot['products'][number];
type Collection = Snapshot['collections'][number];
type Page = Snapshot['pages'][number];
type Article = Snapshot['articles'][number];

/** The record a template is being rendered against, plus the shop it belongs to. */
export interface ResolutionContext {
  kind: SchemaContextKind;
  shop: Snapshot['shop'];
  product?: Product;
  collection?: Collection;
  page?: Page;
  article?: Article;
}

/**
 * A value read from Shopify.
 *
 * `null` and `''` are both absence. Shopify returns empty strings for fields a merchant left
 * blank, and emitting `"sku": ""` is worse than omitting the property: it asserts the product has
 * an SKU whose value is nothing.
 */
export type FieldValue = string | number | boolean | string[] | null;

export interface FieldDefinition {
  /** Stable identifier used in stored templates. Renaming one is a data migration. */
  path: string;
  /** What the merchant sees in the picker. */
  label: string;
  /** Which contexts offer it. `shop` fields are offered everywhere — every page has a shop. */
  contexts: SchemaContextKind[];
  /** One line of help, shown under the picker. */
  description?: string;
  read: (context: ResolutionContext) => FieldValue;
}

/** Strips HTML so a description never carries markup into JSON-LD, where it is not rendered and
 * only inflates the document. Entities are decoded so "&amp;" reads as "&". */
function plainText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** The variant a single-variant schema describes. Shopify products always have at least one. */
function firstVariant(product: Product | undefined) {
  return product?.variants?.[0];
}

const ALL_CONTEXTS: SchemaContextKind[] = ['product', 'collection', 'page', 'article', 'shop'];

/**
 * Schema.org's ItemAvailability vocabulary. Google matches these exact URLs, so the mapping is
 * from Shopify's boolean to the term — never an invented string like "in stock".
 */
export const IN_STOCK = 'https://schema.org/InStock';
export const OUT_OF_STOCK = 'https://schema.org/OutOfStock';

export const FIELD_CATALOG: FieldDefinition[] = [
  // ─── Shop ──────────────────────────────────────────────────────────
  { path: 'shop.name', label: 'Store name', contexts: ALL_CONTEXTS, read: (c) => c.shop.name || null },
  { path: 'shop.url', label: 'Store URL', contexts: ALL_CONTEXTS, read: (c) => c.shop.primaryUrl || null },
  { path: 'shop.domain', label: 'Store domain', contexts: ALL_CONTEXTS, read: (c) => c.shop.domain || null },
  { path: 'shop.email', label: 'Store contact email', contexts: ALL_CONTEXTS, read: (c) => c.shop.email },
  {
    path: 'shop.currency',
    label: 'Store currency code',
    contexts: ALL_CONTEXTS,
    description: 'The ISO code Shopify reports for this shop, e.g. PKR.',
    read: (c) => c.shop.currency,
  },
  { path: 'shop.country', label: 'Store country', contexts: ALL_CONTEXTS, read: (c) => c.shop.country },

  // ─── Product ───────────────────────────────────────────────────────
  { path: 'product.title', label: 'Product title', contexts: ['product'], read: (c) => c.product?.title || null },
  {
    path: 'product.description',
    label: 'Product description (plain text)',
    contexts: ['product'],
    description: 'The body copy with HTML removed — JSON-LD does not render markup.',
    read: (c) => plainText(c.product?.bodyHtml),
  },
  { path: 'product.url', label: 'Product URL', contexts: ['product'], read: (c) => c.product?.url || null },
  { path: 'product.handle', label: 'Product handle', contexts: ['product'], read: (c) => c.product?.handle || null },
  {
    path: 'product.vendor',
    label: 'Product vendor',
    contexts: ['product'],
    description: 'Shopify\'s vendor field — the usual source for Brand.',
    read: (c) => c.product?.vendor || null,
  },
  { path: 'product.type', label: 'Product type', contexts: ['product'], read: (c) => c.product?.productType || null },
  { path: 'product.tags', label: 'Product tags', contexts: ['product'], read: (c) => c.product?.tags ?? null },
  {
    path: 'product.featured_image',
    label: 'Featured image URL',
    contexts: ['product'],
    read: (c) => c.product?.images?.[0]?.src ?? null,
  },
  {
    path: 'product.images',
    label: 'All image URLs',
    contexts: ['product'],
    description: 'Google accepts several images per product and prefers more than one.',
    read: (c) => {
      const urls = (c.product?.images ?? []).map((image) => image.src).filter(Boolean);
      return urls.length > 0 ? urls : null;
    },
  },
  { path: 'product.seo_title', label: 'Product SEO title', contexts: ['product'], read: (c) => c.product?.seoTitle ?? null },
  { path: 'product.seo_description', label: 'Product SEO description', contexts: ['product'], read: (c) => c.product?.seoDescription ?? null },
  { path: 'product.published_at', label: 'Product published date', contexts: ['product'], read: (c) => c.product?.publishedAt ?? null },
  { path: 'product.updated_at', label: 'Product updated date', contexts: ['product'], read: (c) => c.product?.updatedAt ?? null },

  // ─── Variant ───────────────────────────────────────────────────────
  // The first variant. A multi-variant product is better described by ProductGroup, which the
  // library models separately — silently describing variant #1 as "the product" would misstate
  // price and availability for every other variant.
  {
    path: 'variant.sku',
    label: 'Variant SKU',
    contexts: ['product'],
    description: 'The merchant\'s own stock code. Google accepts it as `sku`.',
    read: (c) => firstVariant(c.product)?.sku ?? null,
  },
  {
    path: 'variant.barcode',
    label: 'Variant barcode (GTIN / EAN / UPC)',
    contexts: ['product'],
    description: 'Shopify stores GTIN-8/12/13/14 in the barcode field. This is what shopping feeds match on.',
    read: (c) => firstVariant(c.product)?.barcode ?? null,
  },
  {
    path: 'variant.price',
    label: 'Variant price',
    contexts: ['product'],
    description: 'A number, as Schema.org requires — not a formatted currency string.',
    read: (c) => firstVariant(c.product)?.price ?? null,
  },
  {
    path: 'variant.availability',
    label: 'Variant availability',
    contexts: ['product'],
    description: 'Resolves to a Schema.org ItemAvailability URL, which is what Google matches.',
    read: (c) => {
      const variant = firstVariant(c.product);
      if (!variant) return null;
      return variant.availableForSale ? IN_STOCK : OUT_OF_STOCK;
    },
  },

  // ─── Collection ────────────────────────────────────────────────────
  { path: 'collection.title', label: 'Collection title', contexts: ['collection'], read: (c) => c.collection?.title || null },
  { path: 'collection.description', label: 'Collection description (plain text)', contexts: ['collection'], read: (c) => plainText(c.collection?.bodyHtml) },
  { path: 'collection.url', label: 'Collection URL', contexts: ['collection'], read: (c) => c.collection?.url || null },

  // ─── Page ──────────────────────────────────────────────────────────
  { path: 'page.title', label: 'Page title', contexts: ['page'], read: (c) => c.page?.title || null },
  { path: 'page.description', label: 'Page content (plain text)', contexts: ['page'], read: (c) => plainText(c.page?.bodyHtml) },
  { path: 'page.url', label: 'Page URL', contexts: ['page'], read: (c) => c.page?.url || null },
  { path: 'page.published_at', label: 'Page published date', contexts: ['page'], read: (c) => c.page?.publishedAt ?? null },
  { path: 'page.updated_at', label: 'Page updated date', contexts: ['page'], read: (c) => c.page?.updatedAt ?? null },

  // ─── Article ───────────────────────────────────────────────────────
  { path: 'article.title', label: 'Article title', contexts: ['article'], read: (c) => c.article?.title || null },
  { path: 'article.description', label: 'Article body (plain text)', contexts: ['article'], read: (c) => plainText(c.article?.bodyHtml) },
  { path: 'article.url', label: 'Article URL', contexts: ['article'], read: (c) => c.article?.url || null },
  { path: 'article.image', label: 'Article image URL', contexts: ['article'], read: (c) => c.article?.image?.src ?? null },
  { path: 'article.published_at', label: 'Article published date', contexts: ['article'], read: (c) => c.article?.publishedAt ?? null },
  { path: 'article.updated_at', label: 'Article updated date', contexts: ['article'], read: (c) => c.article?.updatedAt ?? null },
];

const BY_PATH = new Map(FIELD_CATALOG.map((field) => [field.path, field]));

export function findField(path: string): FieldDefinition | null {
  return BY_PATH.get(path) ?? null;
}

/** The fields a picker should offer for one context. */
export function fieldsForContext(context: SchemaContextKind): FieldDefinition[] {
  return FIELD_CATALOG.filter((field) => field.contexts.includes(context));
}
