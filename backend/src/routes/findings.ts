import { Router } from 'express';
import { getAiFixProposals, getAiFixStatus, getAiStatus, getFindingById, getFindings, patchBulkFindingStatus, patchFindingStatus, postAiFixPlan, postAiRecommendation } from '../controllers/finding.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { aiRecommendationSchema, bulkFindingStatusSchema, findingIdParamSchema, findingListQuerySchema, planAiFixesSchema, updateFindingStatusSchema } from '../schemas/finding.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const findingsRouter = Router();

findingsRouter.use(authenticate);
findingsRouter.get('/', validateRequest({ query: findingListQuerySchema }), asyncHandler(getFindings));
// Declared before '/:id' so 'ai-status' is never parsed as a finding id.
findingsRouter.get('/ai-status', getAiStatus);
findingsRouter.get('/ai-fix-status', getAiFixStatus);
findingsRouter.get('/:id', validateRequest({ params: findingIdParamSchema, query: storeIdQuerySchema }), asyncHandler(getFindingById));
findingsRouter.patch('/:id/status', validateRequest({ params: findingIdParamSchema, query: storeIdQuerySchema, body: updateFindingStatusSchema }), asyncHandler(patchFindingStatus));
findingsRouter.post('/:id/ai-recommendation', validateRequest({ params: findingIdParamSchema, query: storeIdQuerySchema, body: aiRecommendationSchema }), asyncHandler(postAiRecommendation));
findingsRouter.post('/bulk-status', validateRequest({ query: storeIdQuerySchema, body: bulkFindingStatusSchema }), asyncHandler(patchBulkFindingStatus));
findingsRouter.post('/:id/ai-fix-plan', validateRequest({ params: findingIdParamSchema, query: storeIdQuerySchema, body: planAiFixesSchema }), asyncHandler(postAiFixPlan));
findingsRouter.get('/:id/ai-fix-proposals', validateRequest({ params: findingIdParamSchema, query: storeIdQuerySchema }), asyncHandler(getAiFixProposals));
