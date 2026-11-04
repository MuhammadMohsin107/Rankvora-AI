import type { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';
import { htmlToText } from '../audit-engine/checks/shared/html.js';

/**
 * ─── Product images in Shopify: read, upload, attach ─────────────────
 *
 * Every Shopify call the Missing images panel makes, and nothing else. Each function takes the
 * store's own ShopifyClient, so a product id can only ever be looked up in the store whose token
 * made the call — a product of another store simply is not found.
 *
 * Written against Admin API 2026-07 and validated against Shopify's schema:
 *
 *   find      products(...) { media(first: 1, query: "media_type:IMAGE") }   — read_products
 *   upload    stagedUploadsCreate(resource: IMAGE, httpMethod: POST), then a multipart POST of the
 *             bytes to the returned target with its parameters
 *   attach    productUpdate(product: { id }, media: [{ originalSource: resourceUrl,
 *             mediaContentType: IMAGE, alt }])                                  — write_products
 *   confirm   node(id: MediaImage) { status image { url } mediaErrors }        — read_products
 *
 * "Missing images" means exactly what the audit means (checks/content/media-richness.ts): no
 * MediaImage among the product's media. A product with only a video still has no image.
 *
 * SUCCESS IS SHOPIFY'S WORD, NOT OURS. An attach is reported as done only when Shopify says the
 * media is READY and gives its CDN URL. Processing that has not finished is reported as
 * processing, and a FAILED status is reported with Shopify's own reasons.
 */

export type FetchLike = (url: string, init: { method: string; body: FormData }) => Promise<Response>;

/** `gid://shopify/Product/123` from the numeric id the routes take. */
export const productGid = (productId: string) => `gid://shopify/Product/${productId}`;
export const mediaImageGid = (mediaId: string) => `gid://shopify/MediaImage/${mediaId}`;
/** The numeric tail of a gid — what the app's own pages use as an id. */
export const numericId = (gid: string) => gid.slice(gid.lastIndexOf('/') + 1);

// ─── Finding products with no image ──────────────────────────────────

export const MISSING_IMAGES_QUERY = `
  query ScoreloProductsMissingImages($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        productType
        vendor
        updatedAt
        images: media(first: 1, query: "media_type:IMAGE") { nodes { id } }
        mediaCount { count }
      }
    }
  }
`;

interface MissingImagesNode {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  productType: string | null;
  vendor: string | null;
  updatedAt: string | null;
  images: { nodes: Array<{ id: string }> } | null;
  mediaCount: { count: number } | null;
}

interface MissingImagesResponse {
  products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: MissingImagesNode[] } | null;
}

export interface MissingImageProduct {
  /** Numeric product id. */
  id: string;
  title: string;
  handle: string | null;
  /** ACTIVE, DRAFT, ARCHIVED or UNLISTED, as Shopify reports it. */
  status: string | null;
  productType: string | null;
  vendor: string | null;
  updatedAt: string | null;
  /** Videos and 3D models the product has. They are not images; the count is shown so the
   * merchant is not surprised to see "no image" on a product that has a video. */
  otherMedia: number;
}

export interface MissingImagesPage {
  products: MissingImageProduct[];
  /** Pass back as `after` to keep scanning. Null when every product has been looked at. */
  nextCursor: string | null;
  /** Products looked at by this call, with and without images. */
  scanned: number;
}

/** Products per page. Each costs about two query points, so a page stays far inside the bucket. */
const SCAN_PAGE_SIZE = 100;

/**
 * Turns the merchant's search words into Shopify search syntax.
 *
 * Only letters and digits survive — everything else separates words — so nothing typed can become a
 * filter on another field (`status:draft`) or break the query. Every word must begin a word of the
 * title (Shopify's prefix match), so "snow" finds "Snowboard".
 */
export function titleSearchQuery(search: string | undefined): string | null {
  const words = (search ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return null;
  return words.map((word) => `title:${word}*`).join(' AND ');
}

/**
 * Walks the catalogue from `after` until it has collected `want` products with no image, has
 * looked at `maxScan` products, or reaches the end — whichever is first.
 *
 * Shopify's product search has no filter for "has no image", so every product is looked at; the
 * cursor lets the panel continue where the last call stopped instead of starting over.
 */
export async function scanProductsWithoutImages(
  client: ShopifyClient,
  options: { after?: string | null; search?: string; want?: number; maxScan?: number },
): Promise<MissingImagesPage> {
  const want = options.want ?? 25;
  const maxScan = options.maxScan ?? 1000;
  const query = titleSearchQuery(options.search);
  const products: MissingImageProduct[] = [];
  let cursor: string | null = options.after ?? null;
  let scanned = 0;

  for (;;) {
    const data: MissingImagesResponse = await client.graphql<MissingImagesResponse>(MISSING_IMAGES_QUERY, { first: SCAN_PAGE_SIZE, after: cursor, query });
    const connection = data.products;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new StoreDataError('MALFORMED_RESPONSE', 'Shopify did not return a product list', false);
    }

    for (const node of connection.nodes) {
      scanned += 1;
      if ((node.images?.nodes.length ?? 0) > 0) continue;
      products.push({
        id: numericId(node.id),
        title: node.title?.trim() || `Product ${numericId(node.id)}`,
        handle: node.handle ?? null,
        status: node.status ?? null,
        productType: node.productType?.trim() || null,
        vendor: node.vendor?.trim() || null,
        updatedAt: node.updatedAt ?? null,
        otherMedia: node.mediaCount?.count ?? 0,
      });
    }

    const next = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    // A cursor that does not advance would loop forever; treat it as the end.
    if (!next || next === cursor) return { products, nextCursor: null, scanned };
    cursor = next;
    if (products.length >= want || scanned >= maxScan) return { products, nextCursor: cursor, scanned };
  }
}

// ─── One product, as the panel shows it ──────────────────────────────

export const PRODUCT_FOR_IMAGES_QUERY = `
  query ScoreloProductForImages($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      descriptionHtml
      productType
      vendor
      tags
      onlineStoreUrl
      images: media(first: 12, query: "media_type:IMAGE") {
        pageInfo { hasNextPage }
        nodes { ... on MediaImage { id alt status image { url width height } } }
      }
    }
  }
`;

interface ProductForImagesResponse {
  product: {
    id: string;
    title: string | null;
    handle: string | null;
    status: string | null;
    descriptionHtml: string | null;
    productType: string | null;
    vendor: string | null;
    tags: string[] | null;
    onlineStoreUrl: string | null;
    images: {
      pageInfo: { hasNextPage: boolean } | null;
      nodes: Array<{ id?: string; alt?: string | null; status?: string | null; image?: { url?: string | null; width?: number | null; height?: number | null } | null }>;
    } | null;
  } | null;
}

export interface ProductImage {
  /** Numeric MediaImage id. */
  id: string;
  url: string | null;
  alt: string | null;
  status: string | null;
  width: number | null;
  height: number | null;
}

export interface ProductImageSubject {
  id: string;
  title: string;
  handle: string | null;
  status: string | null;
  /** The description as plain text — what an AI drawing is based on. Empty when there is none. */
  description: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  onlineStoreUrl: string | null;
  images: ProductImage[];
  /** True when the product has more images than were read. */
  moreImages: boolean;
}

/** The product as Shopify holds it now, or null when this store has no such product. */
export async function readProductForImages(client: ShopifyClient, productId: string): Promise<ProductImageSubject | null> {
  const data = await client.graphql<ProductForImagesResponse>(PRODUCT_FOR_IMAGES_QUERY, { id: productGid(productId) });
  const product = data.product;
  if (!product?.id) return null;
  return {
    id: numericId(product.id),
    title: product.title?.trim() || `Product ${numericId(product.id)}`,
    handle: product.handle ?? null,
    status: product.status ?? null,
    description: htmlToText(product.descriptionHtml ?? ''),
    productType: product.productType?.trim() || null,
    vendor: product.vendor?.trim() || null,
    tags: (product.tags ?? []).filter((tag) => typeof tag === 'string' && tag.trim() !== ''),
    onlineStoreUrl: product.onlineStoreUrl ?? null,
    images: (product.images?.nodes ?? [])
      .filter((node): node is typeof node & { id: string } => typeof node.id === 'string')
      .map((node) => ({
        id: numericId(node.id),
        url: node.image?.url ?? null,
        alt: node.alt ?? null,
        status: node.status ?? null,
        width: node.image?.width ?? null,
        height: node.image?.height ?? null,
      })),
    moreImages: Boolean(product.images?.pageInfo?.hasNextPage),
  };
}

// ─── Uploading the bytes ─────────────────────────────────────────────

export const STAGED_UPLOAD_MUTATION = `
  mutation ScoreloStageProductImage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

interface StagedUploadResponse {
  stagedUploadsCreate: {
    stagedTargets: Array<{ url: string | null; resourceUrl: string | null; parameters: Array<{ name: string; value: string }> | null }> | null;
    userErrors: Array<{ field?: string[] | null; message?: string | null }> | null;
  } | null;
}

/** Shopify refused or could not take the file. The message is Shopify's or the storage's own. */
export class MediaUploadError extends Error {
  constructor(message: string, readonly stage: 'stage' | 'upload' | 'attach') {
    super(message);
    this.name = 'MediaUploadError';
  }
}

const userErrorText = (errors: Array<{ message?: string | null }> | null | undefined) =>
  (errors ?? []).map((error) => error?.message).filter(Boolean).join('; ').slice(0, 500);

/**
 * Puts the bytes in Shopify's staging storage and returns the `resourceUrl` an attach takes as its
 * `originalSource`. Nothing is attached to any product yet.
 *
 * The upload goes from this server to the target Shopify names, as a multipart POST: every
 * parameter Shopify returned, in order, then the file. The browser never talks to Shopify's storage
 * and never sees the target's signed parameters.
 */
export async function stageImage(
  client: ShopifyClient,
  file: { bytes: Buffer; mimeType: string; filename: string },
  uploadFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<{ resourceUrl: string }> {
  const data = await client.graphql<StagedUploadResponse>(STAGED_UPLOAD_MUTATION, {
    input: [{
      resource: 'IMAGE',
      filename: file.filename,
      mimeType: file.mimeType,
      httpMethod: 'POST',
      fileSize: String(file.bytes.length),
    }],
  });

  const errors = userErrorText(data.stagedUploadsCreate?.userErrors);
  if (errors) throw new MediaUploadError(`Shopify would not accept the file: ${errors}`, 'stage');
  const target = data.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) throw new MediaUploadError('Shopify did not return an upload address for the file.', 'stage');

  const form = new FormData();
  for (const parameter of target.parameters ?? []) form.append(parameter.name, parameter.value);
  // A copy into a plain ArrayBuffer: a Buffer can be a view into Node's shared pool, and the Blob
  // must hold exactly this file's bytes.
  const body = new Uint8Array(file.bytes.byteLength);
  body.set(file.bytes);
  form.append('file', new Blob([body], { type: file.mimeType }), file.filename);

  let response: Response;
  try {
    response = await uploadFetch(target.url, { method: 'POST', body: form });
  } catch (error) {
    throw new MediaUploadError(`The upload to Shopify's storage failed: ${error instanceof Error ? error.message : 'network error'}`, 'upload');
  }
  if (!response.ok) {
    // Google Cloud Storage answers with an XML error; its <Message> is the useful part.
    const text = await response.text().catch(() => '');
    const message = /<Message>([^<]{1,300})<\/Message>/.exec(text)?.[1];
    throw new MediaUploadError(`Shopify's storage refused the upload (HTTP ${response.status}${message ? `: ${message}` : ''}).`, 'upload');
  }

  return { resourceUrl: target.resourceUrl };
}

// ─── Attaching it to the product ─────────────────────────────────────

export const PRODUCT_MEDIA_IDS_QUERY = `
  query ScoreloProductMediaIds($id: ID!) {
    product(id: $id) { id media(first: 250) { nodes { id } } }
  }
`;

export const ATTACH_MEDIA_MUTATION = `
  mutation ScoreloAttachProductImage($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product { id media(first: 250) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

export const MEDIA_STATUS_QUERY = `
  query ScoreloMediaImageStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage { id status alt image { url width height } mediaErrors { code details message } }
    }
  }
`;

interface MediaIdsResponse { product: { id: string; media: { nodes: Array<{ id: string }> } | null } | null }

interface AttachResponse {
  productUpdate: {
    product: { id: string; media: { nodes: Array<{ id: string }> } | null } | null;
    userErrors: Array<{ field?: string[] | null; message?: string | null }> | null;
  } | null;
}

interface MediaStatusResponse {
  node: {
    id?: string;
    status?: string | null;
    alt?: string | null;
    image?: { url?: string | null; width?: number | null; height?: number | null } | null;
    mediaErrors?: Array<{ code?: string | null; details?: string | null; message?: string | null }> | null;
  } | null;
}

export type MediaState = 'READY' | 'PROCESSING' | 'UPLOADED' | 'FAILED';

export interface MediaOutcome {
  /** Numeric MediaImage id. */
  mediaId: string;
  status: MediaState;
  url: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  /** Shopify's reasons, when processing FAILED. */
  errors: string[];
}

/** Shopify's media status, or null when this store has no such media. */
export async function readMediaStatus(client: ShopifyClient, mediaId: string): Promise<MediaOutcome | null> {
  const data = await client.graphql<MediaStatusResponse>(MEDIA_STATUS_QUERY, { id: mediaImageGid(mediaId) });
  const node = data.node;
  if (!node?.id) return null;
  const status = (['READY', 'PROCESSING', 'UPLOADED', 'FAILED'] as const).find((value) => value === node.status) ?? 'PROCESSING';
  return {
    mediaId: numericId(node.id),
    status,
    url: node.image?.url ?? null,
    width: node.image?.width ?? null,
    height: node.image?.height ?? null,
    alt: node.alt ?? null,
    errors: (node.mediaErrors ?? [])
      .map((error) => [error?.message, error?.details].filter(Boolean).join(' — '))
      .filter(Boolean),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Adds the staged file to the product as a new image, then waits — briefly — for Shopify to finish
 * processing it.
 *
 * Which media is the new one is worked out by comparing the product's media ids before and after,
 * not by position, so it holds wherever Shopify places it. Waiting stops at READY, FAILED or
 * `waitMs`, whichever is first; anything still processing is returned as PROCESSING for the panel
 * to keep checking.
 */
export async function attachImage(
  client: ShopifyClient,
  input: { productId: string; resourceUrl: string; alt: string },
  options: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MediaOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 1_500;

  const before = await client.graphql<MediaIdsResponse>(PRODUCT_MEDIA_IDS_QUERY, { id: productGid(input.productId) });
  if (!before.product) throw new MediaUploadError('This product no longer exists in your store.', 'attach');
  const existing = new Set((before.product.media?.nodes ?? []).map((node) => node.id));

  const data = await client.graphql<AttachResponse>(ATTACH_MEDIA_MUTATION, {
    product: { id: productGid(input.productId) },
    media: [{ originalSource: input.resourceUrl, mediaContentType: 'IMAGE', alt: input.alt }],
  });
  const errors = userErrorText(data.productUpdate?.userErrors);
  if (errors) throw new MediaUploadError(`Shopify did not add the image: ${errors}`, 'attach');

  const added = (data.productUpdate?.product?.media?.nodes ?? []).find((node) => !existing.has(node.id));
  if (!added) throw new MediaUploadError('Shopify accepted the request but did not list a new image on the product.', 'attach');
  const mediaId = numericId(added.id);

  const deadline = Date.now() + waitMs;
  for (;;) {
    const outcome = await readMediaStatus(client, mediaId);
    if (!outcome) throw new MediaUploadError('Shopify did not return the new image.', 'attach');
    if (outcome.status === 'READY' || outcome.status === 'FAILED' || Date.now() + pollMs > deadline) return outcome;
    await sleep(pollMs);
  }
}

/** How many images the product has now, read from Shopify after a change. */
export async function countProductImages(client: ShopifyClient, productId: string): Promise<{ count: number; more: boolean } | null> {
  const subject = await readProductForImages(client, productId);
  return subject ? { count: subject.images.length, more: subject.moreImages } : null;
}
