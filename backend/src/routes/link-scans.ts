import { Router } from 'express';
import { getExport, getLatest, getLinks, getScan, getSources, postCancel, postLinkScan } from '../controllers/link-scan.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';
import { linkScanIdParamSchema, linkScanLinksQuerySchema, linkScanUrlParamSchema } from '../schemas/link-scan.schema.js';

/**
 * The complete link scan: start one, follow it, read what it found.
 * Every route is the signed-in merchant's own store's (authenticate → getCurrentStoreId).
 */
export const linkScansRouter = Router();

linkScansRouter.use(authenticate);

// A scan requests a real website thousands of times, so starting one is limited per merchant even though
// the one-active-scan-per-store rule already stops them piling up.
linkScansRouter.post(
  '/',
  rateLimit({ name: 'link-scans:start', windowMs: 60 * 1000, max: 6, message: 'Too many scans started. Please wait a minute and try again.' }),
  validateRequest({ query: storeIdQuerySchema }),
  asyncHandler(postLinkScan),
);
// Declared before '/:id' so 'latest' is never read as a scan id.
linkScansRouter.get('/latest', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getLatest));
linkScansRouter.get('/:id', validateRequest({ params: linkScanIdParamSchema, query: storeIdQuerySchema }), asyncHandler(getScan));
linkScansRouter.get('/:id/links', validateRequest({ params: linkScanIdParamSchema, query: linkScanLinksQuerySchema }), asyncHandler(getLinks));
linkScansRouter.get('/:id/links/:urlId/sources', validateRequest({ params: linkScanUrlParamSchema, query: storeIdQuerySchema }), asyncHandler(getSources));
linkScansRouter.get('/:id/export', validateRequest({ params: linkScanIdParamSchema, query: storeIdQuerySchema }), asyncHandler(getExport));
linkScansRouter.post('/:id/cancel', validateRequest({ params: linkScanIdParamSchema, query: storeIdQuerySchema }), asyncHandler(postCancel));
