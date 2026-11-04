import { Router } from 'express';
import { postAiFixDecision, postAiFixDecisions, postAiFixPlanBulk, postApplyFixes } from '../controllers/finding.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  applyFixProposalsSchema,
  bulkDecideFixProposalsSchema,
  bulkPlanAiFixesSchema,
  decideFixProposalSchema,
  fixProposalIdParamSchema,
} from '../schemas/finding.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

/**
 * Proposal-level operations, keyed by proposal id rather than finding id — which is why they live
 * here and not on the findings router. Generation stays under /findings/:id, because a proposal
 * only exists in the context of the finding it resolves.
 */
export const aiFixesRouter = Router();

aiFixesRouter.use(authenticate);

// Plan across several selected findings — the bulk Fix Center entry point.
aiFixesRouter.post('/plan', validateRequest({ query: storeIdQuerySchema, body: bulkPlanAiFixesSchema }), asyncHandler(postAiFixPlanBulk));

// Writes approved proposals to the merchant's live Shopify store, then queues a re-audit.
//
// Declared before '/:id/...' so 'apply' is never parsed as a proposal id.
//
// RATE LIMITED, unlike the read and decision endpoints. This is the only route in the app that
// mutates a merchant's storefront: each call can write up to 100 resources against Shopify's cost
// budget, and a retry loop here would be a self-inflicted outage on someone's live catalogue.
// Twenty per fifteen minutes is far more than a person clicking Apply, and far less than a loop.
aiFixesRouter.post(
  '/apply',
  rateLimit({ name: 'ai-fixes:apply', windowMs: 15 * 60 * 1000, max: 20, message: 'Too many apply requests. Please wait a few minutes and try again.' }),
  validateRequest({ query: storeIdQuerySchema, body: applyFixProposalsSchema }),
  asyncHandler(postApplyFixes),
);

// The decisions taken on one preview screen. Declared before '/:id/...' so 'decisions' is never
// parsed as a proposal id.
aiFixesRouter.post('/decisions', validateRequest({ query: storeIdQuerySchema, body: bulkDecideFixProposalsSchema }), asyncHandler(postAiFixDecisions));

aiFixesRouter.post(
  '/:id/decision',
  validateRequest({ params: fixProposalIdParamSchema, query: storeIdQuerySchema, body: decideFixProposalSchema }),
  asyncHandler(postAiFixDecision),
);
