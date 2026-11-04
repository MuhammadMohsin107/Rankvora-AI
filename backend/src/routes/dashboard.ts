import { Router } from 'express';
import { getSignals, getSummary } from '../controllers/dashboard.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);
dashboardRouter.get('/summary', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getSummary));
dashboardRouter.get('/signals', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getSignals));
