import { Router } from 'express';
import { getPagespeedStatus, postPagespeedRun } from '../controllers/pagespeed.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

/**
 * PageSpeed Insights.
 *
 * Two routes and no OAuth: the API measures a public url and asks for no merchant credential, so
 * there is no consent screen, no callback and no token. Every route is authenticated — the store
 * whose storefront is measured, and whose stored results are read, is always the caller's own.
 *
 * NO BODY SCHEMA ON /run, deliberately. The url is NOT a parameter: it is read from the store
 * record the Shopify install wrote. Accepting one would let a request point a number presented as
 * "your store's performance" at any site on the internet.
 */
export const pagespeedRouter = Router();

pagespeedRouter.get('/status', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getPagespeedStatus));
pagespeedRouter.post('/run', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(postPagespeedRun));
