import { resolveShopifyClient } from '../audit-engine/store-data/index.js';
import type { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';
import { generateProductImage, imageGenerationStatus, type ImageFailureCode } from '../lib/ai/image-provider.js';
import { checkProductImage, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, PRODUCT_IMAGE_TYPES, safeImageFilename } from '../lib/images/image-file.js';
import { signStagedImage, verifyStagedImage } from '../lib/images/staged-image-token.js';
import { ApiError } from '../middleware/error.js';
import { getFixContext } from './fixability.service.js';
import { automationConsentFor, writeIsPermitted } from './onboarding.service.js';
import { assertProductNotProtected } from './protected-paths.service.js';
import {
  attachImage,
  countProductImages,
  MediaUploadError,
  readMediaStatus,
  readProductForImages,
  scanProductsWithoutImages,
  stageImage,
  type MediaOutcome,
  type MissingImagesPage,
  type ProductImageSubject,
} from './shopify-media.service.js';
import { getCurrentStoreId } from './store.service.js';

/**
 * ─── Missing images: the service behind the panel ────────────────────
 *
 * The merchant picks a product that has no image and either uploads a photo from their computer or
 * has one drawn from the product's own title and description; whichever they choose is added to
 * that product in their Shopify store. Every product, title, description and image here is read
 * live from the store; nothing is cached, sampled from an old audit, or made up.
 *
 * THE STORE IS RESOLVED, NOT ACCEPTED — as for every other write (see postApplyFixes). The store id
 * comes from the signed-in user's own stores, and the product is looked up through that store's
 * token, so no request can reach another merchant's catalogue.
 *
 * THE SAME TWO GATES AS EVERY OTHER WRITE, checked before any Shopify call or AI spend:
 *   - the merchant's own setup answer ("Never change my store" means nothing is written), and
 *   - the write_products scope the store actually granted.
 */

export const IMAGE_LIMITS = {
  maxBytes: MAX_IMAGE_BYTES,
  maxSide: MAX_IMAGE_SIDE,
  maxPixels: MAX_IMAGE_PIXELS,
  types: [...PRODUCT_IMAGE_TYPES],
};

/** Shopify's limit on an image's alt text. */
export const MAX_ALT_LENGTH = 512;

export interface ProductImageCapabilities {
  write: { allowed: boolean; code: string | null; reason: string | null };
  ai: { configured: boolean; provider: string; model: string | null; reason: string | null };
  limits: typeof IMAGE_LIMITS;
}

type WriteGate = ProductImageCapabilities['write'];

async function writeGate(storeId: number): Promise<WriteGate> {
  const permission = writeIsPermitted(await automationConsentFor(storeId));
  if (!permission.allowed) return { allowed: false, code: 'AUTOMATION_NOT_PERMITTED', reason: permission.reason };
  const { grantedScopes } = await getFixContext(storeId);
  if (!grantedScopes.includes('write_products')) {
    return {
      allowed: false,
      code: 'MISSING_WRITE_SCOPE',
      reason: 'Rankvora AI does not have permission to change products in this store yet. Reconnect your Shopify store to grant it.',
    };
  }
  return { allowed: true, code: null, reason: null };
}

async function requireWritable(storeId: number): Promise<void> {
  const gate = await writeGate(storeId);
  if (!gate.allowed) throw new ApiError(403, gate.reason ?? 'Rankvora AI may not change this store.', gate.code ?? 'WRITE_NOT_PERMITTED');
}

/** Shopify-side failures as API errors the panel can show. The message never carries a token. */
function shopifyError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof MediaUploadError) throw new ApiError(502, error.message, `SHOPIFY_${error.stage.toUpperCase()}_FAILED`);
  if (error instanceof StoreDataError) {
    switch (error.code) {
      case 'NOT_CONNECTED':
        throw new ApiError(409, 'Connect your Shopify store first.', 'SHOPIFY_NOT_CONNECTED');
      case 'TOKEN_REVOKED':
        throw new ApiError(409, 'Shopify no longer accepts Rankvora AI’s access to this store. Reconnect it on the Integrations page.', 'SHOPIFY_RECONNECT_REQUIRED');
      case 'MISSING_SCOPES':
        throw new ApiError(403, 'Shopify refused: Rankvora AI is missing a permission for this. Reconnect your store to grant it.', 'MISSING_WRITE_SCOPE');
      case 'RATE_LIMITED':
        throw new ApiError(429, 'Shopify is rate-limiting requests from this store. Wait a moment and try again.', 'SHOPIFY_RATE_LIMITED');
      default:
        throw new ApiError(502, `Shopify could not be reached: ${error.message}`, 'SHOPIFY_UNAVAILABLE');
    }
  }
  throw error;
}

async function clientFor(storeId: number): Promise<ShopifyClient> {
  try {
    return await resolveShopifyClient(storeId);
  } catch (error) {
    return shopifyError(error);
  }
}

async function subjectOrNotFound(client: ShopifyClient, productId: string): Promise<ProductImageSubject> {
  let subject: ProductImageSubject | null;
  try {
    subject = await readProductForImages(client, productId);
  } catch (error) {
    return shopifyError(error);
  }
  // Not found and not this store's are one answer, so the response cannot be used to probe ids.
  if (!subject) throw new ApiError(404, 'This product was not found in your store. It may have been deleted.', 'PRODUCT_NOT_FOUND');
  return subject;
}

const cleanAlt = (alt: string | undefined, fallback: string) => {
  const value = (alt ?? '').replace(/\s+/g, ' ').trim();
  return (value || fallback).slice(0, MAX_ALT_LENGTH);
};

// ─── Reads ───────────────────────────────────────────────────────────

export async function productImageCapabilities(userId: number, storeIdHint?: number): Promise<ProductImageCapabilities> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  const ai = imageGenerationStatus();
  return { write: await writeGate(storeId), ai, limits: IMAGE_LIMITS };
}

export async function listMissingImageProducts(
  userId: number,
  storeIdHint: number | undefined,
  options: { after?: string; search?: string },
): Promise<MissingImagesPage> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  const client = await clientFor(storeId);
  try {
    return await scanProductsWithoutImages(client, options);
  } catch (error) {
    return shopifyError(error);
  }
}

export async function getProductImageSubject(userId: number, storeIdHint: number | undefined, productId: string): Promise<ProductImageSubject> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  return subjectOrNotFound(await clientFor(storeId), productId);
}

export async function productMediaStatus(
  userId: number,
  storeIdHint: number | undefined,
  productId: string,
  mediaId: string,
): Promise<MediaOutcome & { imageCount: number | null }> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  const client = await clientFor(storeId);
  try {
    const outcome = await readMediaStatus(client, mediaId);
    if (!outcome) throw new ApiError(404, 'That image was not found in your store.', 'MEDIA_NOT_FOUND');
    const count = await countProductImages(client, productId);
    return { ...outcome, imageCount: count?.count ?? null };
  } catch (error) {
    return shopifyError(error);
  }
}

// ─── Writes ──────────────────────────────────────────────────────────

export interface AttachResult {
  productId: string;
  productTitle: string;
  media: MediaOutcome;
  /** Images the product has now, read back from Shopify after the change. */
  imageCount: number | null;
}

async function attachAndReport(
  client: ShopifyClient,
  storeId: number,
  subject: ProductImageSubject,
  resourceUrl: string,
  alt: string,
  source: 'upload' | 'ai',
): Promise<AttachResult> {
  try {
    const media = await attachImage(client, { productId: subject.id, resourceUrl, alt });
    const count = await countProductImages(client, subject.id).catch(() => null);
    // The product and the outcome, never the image or the alt text.
    console.log(`[scorelo-images] ${source} image added to product ${subject.id} (store ${storeId}): ${media.status}`);
    return { productId: subject.id, productTitle: subject.title, media, imageCount: count?.count ?? null };
  } catch (error) {
    console.warn(`[scorelo-images] ${source} image NOT added to product ${subject.id} (store ${storeId}): ${error instanceof Error ? error.message : 'unknown error'}`);
    return shopifyError(error);
  }
}

/**
 * Adds a photo the merchant uploaded from their computer to the product.
 *
 * The bytes are checked against Shopify's limits first, by their contents rather than their name,
 * then staged in Shopify's storage and attached. Nothing is kept on Rankvora AI's side.
 */
export async function uploadProductImage(
  userId: number,
  storeIdHint: number | undefined,
  productId: string,
  file: { bytes: Buffer; contentType: string | undefined; filename?: string; alt?: string },
): Promise<AttachResult> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  const check = checkProductImage(file.bytes, file.contentType);
  if (!check.ok) throw new ApiError(check.code === 'IMAGE_TOO_LARGE' ? 413 : 415, check.message, check.code);
  await requireWritable(storeId);

  const client = await clientFor(storeId);
  const subject = await subjectOrNotFound(client, productId);
  // A page the merchant protected is left alone — checked before anything is staged or uploaded.
  await assertProductNotProtected(storeId, subject.handle);

  let staged: { resourceUrl: string };
  try {
    staged = await stageImage(client, {
      bytes: file.bytes,
      mimeType: check.facts.mimeType,
      filename: safeImageFilename(file.filename, check.facts.mimeType, subject.handle ?? subject.title),
    });
  } catch (error) {
    return shopifyError(error);
  }
  return attachAndReport(client, storeId, subject, staged.resourceUrl, cleanAlt(file.alt, subject.title), 'upload');
}

/**
 * The HTTP status and code for each way a drawing can fail. The first four are fixed by changing
 * the AI key, and the panel says "update the AI key" for exactly those codes.
 */
const AI_ERROR: Record<ImageFailureCode, { status: number; code: string }> = {
  not_configured: { status: 503, code: 'AI_IMAGE_NOT_CONFIGURED' },
  key_rejected: { status: 502, code: 'AI_IMAGE_KEY_REJECTED' },
  quota: { status: 502, code: 'AI_IMAGE_QUOTA' },
  model_unavailable: { status: 502, code: 'AI_IMAGE_MODEL_UNAVAILABLE' },
  rate_limited: { status: 429, code: 'AI_IMAGE_RATE_LIMITED' },
  refused: { status: 422, code: 'AI_IMAGE_REFUSED' },
  timeout: { status: 504, code: 'AI_IMAGE_TIMEOUT' },
  failed: { status: 502, code: 'AI_IMAGE_FAILED' },
};

/** What the panel says for each way a drawing can fail. Provider wording is appended as detail. */
export function aiImageFailureMessage(code: ImageFailureCode, provider: string, model: string, detail: string): string {
  const vendor = provider === 'gemini' ? 'Google Gemini' : provider === 'openai' ? 'OpenAI' : provider;
  switch (code) {
    case 'not_configured':
      return `AI image generation is not set up on this server. Update the AI key to one that can generate images. (${detail})`;
    case 'key_rejected':
      return `${vendor} rejected the AI key. Update the AI key on the server and try again. (${detail})`;
    case 'quota':
      return `The AI key has no image-generation quota for ${model}. Update the AI key, or turn on billing for it, then try again. (${detail})`;
    case 'model_unavailable':
      return `The AI key cannot use the image model ${model}. Update the AI key, or set AI_IMAGE_MODEL to a model it can use. (${detail})`;
    case 'rate_limited':
      return `${vendor} is limiting how fast images can be made. Wait a minute and try again.`;
    case 'refused':
      return `${vendor} declined to draw this product under its content rules. Change the direction text and try again.`;
    case 'timeout':
      return `${vendor} did not finish the image in time. Try again.`;
    default:
      return `${vendor} could not make the image: ${detail}`;
  }
}

export interface GeneratedImageDraft {
  /** The drawing itself, to preview. Held only by the browser; never stored by Rankvora AI. */
  image: { dataUrl: string; mimeType: string; width: number; height: number; bytes: number };
  /** Signed receipt for the copy already uploaded to Shopify's staging storage. */
  token: string;
  expiresAt: string;
  provider: string;
  model: string;
  /** What the drawing was based on, as read from the product just now. */
  basedOn: { title: string; description: boolean; productType: string | null; vendor: string | null; tags: number; direction: boolean };
}

/** The merchant's own words for one drawing. */
export const MAX_DIRECTION_LENGTH = 300;

/**
 * Draws a product photo from the product's own title and description, and uploads it to Shopify's
 * staging storage ready to apply. Nothing is attached to the product here.
 */
export async function generateProductImageDraft(
  userId: number,
  storeIdHint: number | undefined,
  productId: string,
  options: { direction?: string },
): Promise<GeneratedImageDraft> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  // Before any spend: an image the store will not take is not worth drawing.
  await requireWritable(storeId);

  const status = imageGenerationStatus();
  if (!status.configured) {
    const failure = AI_ERROR.not_configured;
    throw new ApiError(failure.status, aiImageFailureMessage('not_configured', status.provider, status.model ?? '', status.reason ?? 'not configured'), failure.code);
  }

  const client = await clientFor(storeId);
  const subject = await subjectOrNotFound(client, productId);
  // Before the drawing, which is the part that costs money.
  await assertProductNotProtected(storeId, subject.handle);
  const direction = (options.direction ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTION_LENGTH);

  const startedAt = Date.now();
  const drawn = await generateProductImage({
    title: subject.title,
    description: subject.description,
    productType: subject.productType ?? '',
    vendor: subject.vendor ?? '',
    tags: subject.tags,
    direction,
  });
  if (!drawn.ok) {
    const failure = AI_ERROR[drawn.code];
    console.warn(`[scorelo-images] AI image failed for product ${subject.id} (store ${storeId}) via ${drawn.provider}/${drawn.model}: ${drawn.code} — ${drawn.detail}`);
    throw new ApiError(failure.status, aiImageFailureMessage(drawn.code, drawn.provider, drawn.model, drawn.detail), failure.code);
  }

  // What came back is checked like any upload: a model's output is not trusted to be a valid image.
  const check = checkProductImage(drawn.bytes);
  if (!check.ok) {
    throw new ApiError(502, `The AI returned a file Shopify would not accept: ${check.message}`, 'AI_IMAGE_FAILED');
  }
  console.log(`[scorelo-images] AI image drawn for product ${subject.id} (store ${storeId}) via ${drawn.provider}/${drawn.model} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  let staged: { resourceUrl: string };
  try {
    staged = await stageImage(client, {
      bytes: drawn.bytes,
      mimeType: check.facts.mimeType,
      filename: safeImageFilename(undefined, check.facts.mimeType, `${subject.handle ?? subject.title}-ai`),
    });
  } catch (error) {
    return shopifyError(error);
  }

  const signed = signStagedImage({
    storeId,
    productId: subject.id,
    resourceUrl: staged.resourceUrl,
    mimeType: check.facts.mimeType,
    width: check.facts.width,
    height: check.facts.height,
  });

  return {
    image: {
      dataUrl: `data:${check.facts.mimeType};base64,${drawn.bytes.toString('base64')}`,
      mimeType: check.facts.mimeType,
      width: check.facts.width,
      height: check.facts.height,
      bytes: check.facts.bytes,
    },
    token: signed.token,
    expiresAt: new Date(signed.expiresAt * 1000).toISOString(),
    provider: drawn.provider,
    model: drawn.model,
    basedOn: {
      title: subject.title,
      description: subject.description.trim() !== '',
      productType: subject.productType,
      vendor: subject.vendor,
      tags: subject.tags.length,
      direction: direction !== '',
    },
  };
}

/** Adds an AI drawing the merchant chose to the product it was drawn for. */
export async function applyGeneratedProductImage(
  userId: number,
  storeIdHint: number | undefined,
  productId: string,
  input: { token: string; alt?: string },
): Promise<AttachResult> {
  const storeId = await getCurrentStoreId(userId, storeIdHint);
  const verdict = verifyStagedImage(input.token, { storeId, productId });
  if (!verdict.ok) {
    console.warn(`[scorelo-images] refused a staged image for product ${productId} (store ${storeId}): ${verdict.reason}`);
    throw new ApiError(
      verdict.reason === 'expired' ? 410 : 400,
      verdict.reason === 'expired'
        ? 'This drawing is more than an hour old and is no longer held by Shopify. Generate it again.'
        : 'This drawing cannot be applied to this product. Generate it again.',
      verdict.reason === 'expired' ? 'STAGED_IMAGE_EXPIRED' : 'STAGED_IMAGE_INVALID',
    );
  }
  await requireWritable(storeId);

  const client = await clientFor(storeId);
  const subject = await subjectOrNotFound(client, productId);
  await assertProductNotProtected(storeId, subject.handle);
  return attachAndReport(client, storeId, subject, verdict.claims.resourceUrl, cleanAlt(input.alt, subject.title), 'ai');
}
