import { Router } from 'express';
import { getIntegrations, patchIntegration } from '../controllers/integration.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { integrationProviderSchema, updateIntegrationSchema } from '../schemas/integration.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const integrationsRouter = Router();

integrationsRouter.use(authenticate);
integrationsRouter.get('/', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getIntegrations));
integrationsRouter.patch('/:provider', validateRequest({ params: integrationProviderSchema, query: storeIdQuerySchema, body: updateIntegrationSchema }), asyncHandler(patchIntegration));
