import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';
import { MAX_ALT_LENGTH, MAX_DIRECTION_LENGTH } from '../services/product-image.service.js';

/** Shopify's numeric ids. Gids are rebuilt on the server from these, never taken from a caller. */
const numericId = z.string().regex(/^\d{1,20}$/, 'must be a numeric Shopify id');

export const productIdParamSchema = z.object({ productId: numericId }).strict();
export const productMediaParamSchema = z.object({ productId: numericId, mediaId: numericId }).strict();

export const missingImagesQuerySchema = z.object({
  ...storeIdQueryShape,
  /** Shopify's own cursor, from the previous page. */
  after: z.string().min(1).max(512).optional(),
  search: z.string().max(120).optional(),
}).strict();

/** The upload's own details travel in the query string; the body is the image's bytes. */
export const uploadImageQuerySchema = z.object({
  ...storeIdQueryShape,
  alt: z.string().max(MAX_ALT_LENGTH).optional(),
  filename: z.string().max(200).optional(),
}).strict();

export const generateImageBodySchema = z.object({
  direction: z.string().max(MAX_DIRECTION_LENGTH).optional(),
}).strict();

export const applyGeneratedImageBodySchema = z.object({
  token: z.string().min(10).max(4096),
  alt: z.string().max(MAX_ALT_LENGTH).optional(),
}).strict();
