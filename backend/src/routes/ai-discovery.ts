import { Router } from 'express';
import {
  deleteIndexNowKey,
  getAgentFiles,
  getAiReferrals,
  getGoogleIndexCoverage,
  getProductReadiness,
  getPromptQueries,
  getPromptTrend,
  getSettings,
  getTestableBots,
  patchPromptQuery,
  postBotTest,
  postIndexNowKey,
  postPromptQuery,
  postPromptSweep,
  removePromptQuery,
} from '../controllers/aiDiscovery.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';
import {
  addPromptQuerySchema,
  botTestSchema,
  daysQuerySchema,
  indexCoverageQuerySchema,
  promptQueryParamsSchema,
  setIndexNowKeySchema,
  updatePromptQuerySchema,
} from '../schemas/aiDiscovery.schema.js';

export const aiDiscoveryRouter = Router();

aiDiscoveryRouter.use(authenticate);

// Everything the settings page needs, in one round trip.
aiDiscoveryRouter.get('/settings', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getSettings));

// ── IndexNow key ──
// POST with no body generates one; with a key adopts the merchant's existing one.
aiDiscoveryRouter.post(
  '/indexnow-key',
  validateRequest({ query: storeIdQuerySchema, body: setIndexNowKeySchema.optional() }),
  asyncHandler(postIndexNowKey),
);
aiDiscoveryRouter.delete('/indexnow-key', validateRequest({ query: storeIdQuerySchema }), asyncHandler(deleteIndexNowKey));

// ── Prompt tracking ──
aiDiscoveryRouter.get('/prompt-queries', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getPromptQueries));
aiDiscoveryRouter.post(
  '/prompt-queries',
  validateRequest({ query: storeIdQuerySchema, body: addPromptQuerySchema }),
  asyncHandler(postPromptQuery),
);

// Declared before '/:id' so 'run' is never parsed as a query id.
aiDiscoveryRouter.post('/prompt-queries/run', validateRequest({ query: storeIdQuerySchema }), asyncHandler(postPromptSweep));

aiDiscoveryRouter.patch(
  '/prompt-queries/:id',
  validateRequest({ params: promptQueryParamsSchema, query: storeIdQuerySchema, body: updatePromptQuerySchema }),
  asyncHandler(patchPromptQuery),
);
aiDiscoveryRouter.delete(
  '/prompt-queries/:id',
  validateRequest({ params: promptQueryParamsSchema, query: storeIdQuerySchema }),
  asyncHandler(removePromptQuery),
);

// Recorded observations over time. Separate from '/prompt-queries' because it aggregates across
// every query and carries its own window, which the list endpoint has no business growing.
aiDiscoveryRouter.get('/prompt-history', validateRequest({ query: daysQuerySchema }), asyncHandler(getPromptTrend));

// ── Generated agent files ──
// Reads the store live, returns the file content, publishes nothing.
aiDiscoveryRouter.get('/agent-files', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getAgentFiles));

// ── AI referral traffic ──
// Real GA4 sessions from AI assistants. The pillar's only outcome measure; everything else is
// readiness. Reads through the analytics.readonly grant the store already has.
aiDiscoveryRouter.get('/referrals', validateRequest({ query: daysQuerySchema }), asyncHandler(getAiReferrals));

// ── Google index coverage ──
// Real URL Inspection results for a sample of the store's own sitemap. Reads through
// webmasters.readonly — no re-consent. Each inspection spends the merchant's Search Console quota,
// which is why the sample is capped by indexCoverageQuerySchema as well as in the service.
aiDiscoveryRouter.get(
  '/index-coverage',
  validateRequest({ query: indexCoverageQuerySchema }),
  asyncHandler(getGoogleIndexCoverage),
);

// ── Per-product AI readiness ──
// The three product-level sub-pillar checks, inverted into one row per product so the merchant has
// a work queue instead of a percentage. Reads the store live through the audit's own provider.
aiDiscoveryRouter.get(
  '/product-readiness',
  validateRequest({ query: storeIdQuerySchema }),
  asyncHandler(getProductReadiness),
);

// ── Test as a bot ──
// The list is static and store-independent, so it needs no query validation; the probe is a POST
// because it performs a real outbound request, and its path is resolved against the store's own
// origin inside the controller.
aiDiscoveryRouter.get('/bots', getTestableBots);
aiDiscoveryRouter.post(
  '/bot-test',
  validateRequest({ query: storeIdQuerySchema, body: botTestSchema }),
  asyncHandler(postBotTest),
);
