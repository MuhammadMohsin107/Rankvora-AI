import { Router } from 'express';
import { exportReport, getComparison, getTrend } from '../controllers/report.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { reportExportQuerySchema, reportTrendQuerySchema } from '../schemas/report.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const reportsRouter = Router();

reportsRouter.use(authenticate);
reportsRouter.get('/trend', validateRequest({ query: reportTrendQuerySchema }), asyncHandler(getTrend));
reportsRouter.get('/comparison', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getComparison));
reportsRouter.get('/export', validateRequest({ query: reportExportQuerySchema }), asyncHandler(exportReport));
