import { Router } from 'express';
import { z } from 'zod';
import {
  getGa4Performance,
  getGa4Properties,
  getGa4Status,
  getGoogleAuthUrl,
  getGoogleCallback,
  getGooglePerformance,
  getGoogleSites,
  getGoogleStatus,
  postGa4Property,
  postGoogleDisconnect,
  postGoogleSite,
} from '../controllers/google.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

/**
 * Google Search Console.
 *
 * `authenticate` is applied per route rather than to the whole router, because /callback CANNOT be
 * authenticated: Google redirects a browser to it with no Rankvora AI session attached. Its identity
 * comes from the signed `state` instead. Every other route here is authenticated, and applying the
 * middleware individually makes that exception explicit rather than something a reader has to
 * notice from the absence of a `router.use`.
 */
export const googleRouter = Router();

/**
 * A Search Console property id, e.g. `sc-domain:example.com` or `https://example.com/`.
 *
 * Bounded and non-empty here; whether it is a property the connected account may actually read is
 * checked server-side against Google's own list, because that is the real authorization and it
 * cannot be decided from the string's shape.
 */
const siteSchema = z.object({
  siteUrl: z.string().trim().min(1).max(512),
}).strict();

/**
 * The connect link may name where the merchant started: the one word 'onboarding', and nothing
 * else — it is signed into the state and mapped to a fixed in-app path, never used as a URL.
 */
const googleAuthUrlQuerySchema = storeIdQuerySchema.extend({
  returnTo: z.literal('onboarding').optional(),
});

/** How far back to report. Bounded to Google's own 16-month retention. */
const performanceQuerySchema = storeIdQuerySchema.extend({
  days: z.coerce.number().int().min(1).max(480).optional(),
});

googleRouter.get('/auth-url', authenticate, validateRequest({ query: googleAuthUrlQuerySchema }), asyncHandler(getGoogleAuthUrl));

// UNAUTHENTICATED BY NECESSITY — see the router comment. Not validated by schema either: the query
// is Google's, and an unexpected shape is handled in the service as a failed connection rather
// than a 400 the merchant would see as a broken page.
googleRouter.get('/callback', asyncHandler(getGoogleCallback));

googleRouter.get('/status', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getGoogleStatus));
googleRouter.get('/sites', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getGoogleSites));

googleRouter.post(
  '/site',
  authenticate,
  validateRequest({ query: storeIdQuerySchema, body: siteSchema }),
  asyncHandler(postGoogleSite),
);

googleRouter.get(
  '/performance',
  authenticate,
  validateRequest({ query: performanceQuerySchema }),
  asyncHandler(getGooglePerformance),
);

googleRouter.post('/disconnect', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(postGoogleDisconnect));

/**
 * ─── Google Analytics 4 ──────────────────────────────────────────────
 *
 * Mounted under the same router because it is the same OAuth connection: /auth-url, /callback and
 * /disconnect above serve both. A parallel /api/analytics router would imply a second grant to
 * make and revoke, which is exactly the confusion to avoid.
 */

/**
 * A GA4 property id — the NUMERIC one, e.g. `498211037`.
 *
 * Digits only, because the alternative a merchant is likely to paste is the `G-XXXXXXXXXX`
 * measurement id, which the Data API rejects with an unhelpful 400. Catching the shape here means
 * the card can say which id is wanted instead of relaying Google's confusion. Whether the account
 * may actually read it is checked server-side against Google's own list.
 */
const ga4PropertySchema = z.object({
  propertyId: z.string().trim().regex(/^\d{1,20}$/, 'Use the numeric Property ID, not the G- measurement ID.'),
}).strict();

googleRouter.get('/ga4/status', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getGa4Status));
googleRouter.get('/ga4/properties', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getGa4Properties));

googleRouter.post(
  '/ga4/property',
  authenticate,
  validateRequest({ query: storeIdQuerySchema, body: ga4PropertySchema }),
  asyncHandler(postGa4Property),
);

googleRouter.get(
  '/ga4/performance',
  authenticate,
  validateRequest({ query: performanceQuerySchema }),
  asyncHandler(getGa4Performance),
);
