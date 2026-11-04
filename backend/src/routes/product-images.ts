import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  getMissingImageProducts,
  getProductForImages,
  getProductImageCapabilities,
  getProductMediaStatus,
  postApplyGeneratedProductImage,
  postGenerateProductImage,
  postProductImageUpload,
} from '../controllers/product-image.controller.js';
import { MAX_IMAGE_BYTES, PRODUCT_IMAGE_TYPES } from '../lib/images/image-file.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { ApiError } from '../middleware/error.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';
import {
  applyGeneratedImageBodySchema,
  generateImageBodySchema,
  missingImagesQuerySchema,
  productIdParamSchema,
  productMediaParamSchema,
  uploadImageQuerySchema,
} from '../schemas/product-image.schema.js';

/**
 * ─── /api/product-images — the Missing images panel ──────────────────
 * Every route is authenticated, and every write resolves the store from the signed-in user rather
 * than from the request (services/product-image.service.ts).
 */
export const productImagesRouter = Router();

productImagesRouter.use(authenticate);

/** Per signed-in user, so one merchant's limit is never spent by another's traffic. */
const perUser = (req: Request) => `user:${req.user?.id ?? req.ip ?? 'unknown'}`;

/**
 * The image bytes, read only on the upload route and only for the four accepted types, up to
 * Shopify's 20 MB. body-parser's own errors would otherwise reach the error handler as a 500;
 * they are named here instead.
 */
const readImage = express.raw({ type: [...PRODUCT_IMAGE_TYPES], limit: MAX_IMAGE_BYTES });
function imageBody(req: Request, res: Response, next: NextFunction) {
  readImage(req, res, (error?: unknown) => {
    if (error) {
      const type = (error as { type?: unknown }).type;
      if (type === 'entity.too.large') {
        next(new ApiError(413, 'Shopify accepts product images up to 20 MB. Choose a smaller file.', 'IMAGE_TOO_LARGE'));
        return;
      }
      next(new ApiError(400, 'The image could not be received. Try again.', 'IMAGE_UNREADABLE'));
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      next(new ApiError(415, 'Send a JPEG, PNG, WebP or GIF image.', 'IMAGE_TYPE_UNSUPPORTED'));
      return;
    }
    next();
  });
}

productImagesRouter.get('/capabilities', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getProductImageCapabilities));

productImagesRouter.get('/missing', validateRequest({ query: missingImagesQuerySchema }), asyncHandler(getMissingImageProducts));

productImagesRouter.get(
  '/products/:productId',
  validateRequest({ params: productIdParamSchema, query: storeIdQuerySchema }),
  asyncHandler(getProductForImages),
);

productImagesRouter.get(
  '/products/:productId/media/:mediaId',
  validateRequest({ params: productMediaParamSchema, query: storeIdQuerySchema }),
  asyncHandler(getProductMediaStatus),
);

// Writes to the live store. Limited like /ai-fixes/apply: generous for a person working through a
// list, far below a loop.
productImagesRouter.post(
  '/products/:productId/upload',
  rateLimit({ name: 'product-images:upload', windowMs: 15 * 60 * 1000, max: 60, keyFor: perUser, message: 'Too many image uploads. Please wait a few minutes and try again.' }),
  validateRequest({ params: productIdParamSchema, query: uploadImageQuerySchema }),
  imageBody,
  asyncHandler(postProductImageUpload),
);

// Each drawing is paid for on the AI account, so this is the tightest limit here.
productImagesRouter.post(
  '/products/:productId/generate',
  rateLimit({ name: 'product-images:generate', windowMs: 60 * 60 * 1000, max: 40, keyFor: perUser, message: 'Too many AI images this hour. Please wait and try again later.' }),
  validateRequest({ params: productIdParamSchema, query: storeIdQuerySchema, body: generateImageBodySchema }),
  asyncHandler(postGenerateProductImage),
);

productImagesRouter.post(
  '/products/:productId/apply-generated',
  rateLimit({ name: 'product-images:apply-generated', windowMs: 15 * 60 * 1000, max: 60, keyFor: perUser, message: 'Too many image changes. Please wait a few minutes and try again.' }),
  validateRequest({ params: productIdParamSchema, query: storeIdQuerySchema, body: applyGeneratedImageBodySchema }),
  asyncHandler(postApplyGeneratedProductImage),
);
