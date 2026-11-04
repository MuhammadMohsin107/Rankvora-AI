import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { ApiError } from '../middleware/error.js';
import { createAuditJob } from '../services/job.service.js';
import {
  applyGeneratedProductImage,
  type AttachResult,
  generateProductImageDraft,
  getProductImageSubject,
  listMissingImageProducts,
  productImageCapabilities,
  productMediaStatus,
  uploadProductImage,
} from '../services/product-image.service.js';

/**
 * Queues a re-audit after an image was added, so the Media richness numbers, the Products list and
 * the product's own page move to what the store now holds — the same follow-up an applied fix gets
 * (postApplyFixes). BEST-EFFORT, and it cannot fail the request: the image is already on the
 * product. A 409 is the ordinary case of an audit already running. Nothing is queued when Shopify
 * reported the image as FAILED, because nothing was added for an audit to find.
 */
async function withReaudit(userId: number, storeId: number | undefined, result: AttachResult) {
  let reaudit: 'queued' | 'already-running' | 'not-needed' | 'failed' = 'not-needed';
  let reauditJobId: number | null = null;
  if (result.media.status !== 'FAILED') {
    try {
      reauditJobId = (await createAuditJob(userId, storeId)).id;
      reaudit = 'queued';
    } catch (error) {
      reaudit = error instanceof ApiError && error.statusCode === 409 ? 'already-running' : 'failed';
      console.warn(`[scorelo-images] re-audit not queued after adding an image (product ${result.productId}): ${reaudit}`);
    }
  }
  return { ...result, reaudit, reauditJobId };
}

const queryString = (req: Request, key: string): string | undefined => {
  const value = (req.query as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

export async function getProductImageCapabilities(req: Request, res: Response) {
  res.json({ data: await productImageCapabilities(requireUserId(req), optionalStoreId(req)) });
}

export async function getMissingImageProducts(req: Request, res: Response) {
  res.json({
    data: await listMissingImageProducts(requireUserId(req), optionalStoreId(req), {
      after: queryString(req, 'after'),
      search: queryString(req, 'search'),
    }),
  });
}

export async function getProductForImages(req: Request, res: Response) {
  res.json({ data: await getProductImageSubject(requireUserId(req), optionalStoreId(req), String(req.params.productId)) });
}

export async function getProductMediaStatus(req: Request, res: Response) {
  res.json({
    data: await productMediaStatus(requireUserId(req), optionalStoreId(req), String(req.params.productId), String(req.params.mediaId)),
  });
}

export async function postProductImageUpload(req: Request, res: Response) {
  const userId = requireUserId(req);
  const storeId = optionalStoreId(req);
  const result = await uploadProductImage(userId, storeId, String(req.params.productId), {
    bytes: req.body as Buffer,
    contentType: req.headers['content-type'],
    filename: queryString(req, 'filename'),
    alt: queryString(req, 'alt'),
  });
  res.json({ data: await withReaudit(userId, storeId, result) });
}

export async function postGenerateProductImage(req: Request, res: Response) {
  const body = req.body as { direction?: string };
  res.json({
    data: await generateProductImageDraft(requireUserId(req), optionalStoreId(req), String(req.params.productId), { direction: body.direction }),
  });
}

export async function postApplyGeneratedProductImage(req: Request, res: Response) {
  const userId = requireUserId(req);
  const storeId = optionalStoreId(req);
  const body = req.body as { token: string; alt?: string };
  const result = await applyGeneratedProductImage(userId, storeId, String(req.params.productId), body);
  res.json({ data: await withReaudit(userId, storeId, result) });
}
