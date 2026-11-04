import { Router } from 'express';
import { getJobById } from '../controllers/job.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { jobIdParamSchema } from '../schemas/job.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const jobsRouter = Router();

jobsRouter.use(authenticate);
jobsRouter.get('/:id', validateRequest({ params: jobIdParamSchema, query: storeIdQuerySchema }), asyncHandler(getJobById));
