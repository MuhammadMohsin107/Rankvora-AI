import { api } from '../lib/api';

/**
 * ─── Missing images: the client side of /api/product-images ──────────
 *
 * Every value here is Shopify's, read live by the server when asked: which products have no image,
 * a product's own title and description, the media status of an image that was just added. Nothing
 * is cached in the browser, derived from an old audit, or filled in when Shopify says nothing.
 */

export interface ImageLimits {
  maxBytes: number;
  maxSide: number;
  maxPixels: number;
  types: string[];
}

export interface ProductImageCapabilities {
  /** Whether Rankvora AI may change this store's products, and why not when it may not. */
  write: { allowed: boolean; code: string | null; reason: string | null };
  /** Whether an AI key that can draw images is set on the server. Never the key itself. */
  ai: { configured: boolean; provider: string; model: string | null; reason: string | null };
  limits: ImageLimits;
}

export interface MissingImageProduct {
  id: string;
  title: string;
  handle: string | null;
  status: string | null;
  productType: string | null;
  vendor: string | null;
  updatedAt: string | null;
  /** Videos or 3D models the product has — not images, but not nothing. */
  otherMedia: number;
}

export interface MissingImagesPage {
  products: MissingImageProduct[];
  nextCursor: string | null;
  scanned: number;
}

export interface ProductImage {
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
  description: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  onlineStoreUrl: string | null;
  images: ProductImage[];
  moreImages: boolean;
}

export type MediaState = 'READY' | 'PROCESSING' | 'UPLOADED' | 'FAILED';

export interface MediaOutcome {
  mediaId: string;
  status: MediaState;
  url: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  errors: string[];
}

export interface AttachResult {
  productId: string;
  productTitle: string;
  media: MediaOutcome;
  imageCount: number | null;
  reaudit: 'queued' | 'already-running' | 'not-needed' | 'failed';
  reauditJobId: number | null;
}

export interface GeneratedImageDraft {
  image: { dataUrl: string; mimeType: string; width: number; height: number; bytes: number };
  /** The server's signed receipt for the copy it staged at Shopify. Opaque here. */
  token: string;
  expiresAt: string;
  provider: string;
  model: string;
  basedOn: { title: string; description: boolean; productType: string | null; vendor: string | null; tags: number; direction: boolean };
}

const base = '/product-images';

export const fetchImageCapabilities = () => api.get<ProductImageCapabilities>(`${base}/capabilities`);

export function fetchMissingImageProducts(options: { after?: string | null; search?: string } = {}): Promise<MissingImagesPage> {
  const query = new URLSearchParams();
  if (options.after) query.set('after', options.after);
  if (options.search?.trim()) query.set('search', options.search.trim());
  const suffix = query.toString();
  return api.get<MissingImagesPage>(`${base}/missing${suffix ? `?${suffix}` : ''}`);
}

export const fetchProductForImages = (productId: string) => api.get<ProductImageSubject>(`${base}/products/${encodeURIComponent(productId)}`);

export const fetchMediaStatus = (productId: string, mediaId: string) =>
  api.get<MediaOutcome & { imageCount: number | null }>(`${base}/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(mediaId)}`);

/** Uploads the chosen file and adds it to the product. `onProgress` is 0–1, for the bytes sent. */
export function uploadProductImage(
  productId: string,
  file: File,
  options: { alt: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<AttachResult> {
  const query = new URLSearchParams({ filename: file.name });
  if (options.alt.trim()) query.set('alt', options.alt.trim());
  return api.upload<AttachResult>(`${base}/products/${encodeURIComponent(productId)}/upload?${query.toString()}`, file, {
    contentType: file.type,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}

export const generateProductImage = (productId: string, direction: string) =>
  api.post<GeneratedImageDraft>(`${base}/products/${encodeURIComponent(productId)}/generate`, direction.trim() ? { direction: direction.trim() } : {});

export const applyGeneratedImage = (productId: string, token: string, alt: string) =>
  api.post<AttachResult>(`${base}/products/${encodeURIComponent(productId)}/apply-generated`, { token, ...(alt.trim() ? { alt: alt.trim() } : {}) });

/** Error codes whose fix is a new AI key — the panel says "update the AI key" for exactly these. */
export const AI_KEY_ERROR_CODES = new Set(['AI_IMAGE_NOT_CONFIGURED', 'AI_IMAGE_KEY_REJECTED', 'AI_IMAGE_QUOTA', 'AI_IMAGE_MODEL_UNAVAILABLE']);

/** Error codes that mean Rankvora AI may not write to the store, so the panel offers a reconnect. */
export const WRITE_ERROR_CODES = new Set(['MISSING_WRITE_SCOPE', 'AUTOMATION_NOT_PERMITTED', 'SHOPIFY_RECONNECT_REQUIRED', 'SHOPIFY_NOT_CONNECTED']);
