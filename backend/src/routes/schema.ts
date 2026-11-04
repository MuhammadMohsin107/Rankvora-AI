import { Router } from 'express';
import { z } from 'zod';
import { getCatalog, getTemplate, getTemplates, postPreview, putTemplate } from '../controllers/schema.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { storeIdQueryShape, storeIdQuerySchema } from '../schemas/common.schema.js';
import {
  schemaContextSchema,
  schemaTemplateParamsSchema,
  upsertSchemaTemplateSchema,
} from '../schemas/schemaTemplate.schema.js';

export const schemaRouter = Router();

schemaRouter.use(authenticate);

// The library and field picker. Declared before '/:type/:context' so 'catalog' is never parsed as
// a Schema.org type name.
schemaRouter.get(
  '/catalog',
  validateRequest({ query: z.object({ context: schemaContextSchema.optional(), ...storeIdQueryShape }).strict() }),
  getCatalog,
);

schemaRouter.get('/templates', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getTemplates));

schemaRouter.get(
  '/templates/:type/:context',
  validateRequest({ params: schemaTemplateParamsSchema, query: storeIdQuerySchema }),
  asyncHandler(getTemplate),
);

schemaRouter.put(
  '/templates/:type/:context',
  validateRequest({ params: schemaTemplateParamsSchema, query: storeIdQuerySchema, body: upsertSchemaTemplateSchema }),
  asyncHandler(putTemplate),
);

// Body is the unsaved draft and is optional — an empty body previews what is stored.
schemaRouter.post(
  '/templates/:type/:context/preview',
  validateRequest({ params: schemaTemplateParamsSchema, query: storeIdQuerySchema, body: upsertSchemaTemplateSchema.partial().optional() }),
  asyncHandler(postPreview),
);
