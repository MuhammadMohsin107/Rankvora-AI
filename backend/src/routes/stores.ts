import { Router } from 'express';
import { getCurrentStore, getStoreProfileOptions, getStores, refreshStoreFromShopify, updateStore } from '../controllers/store.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { updateStoreSchema } from '../schemas/store.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const storesRouter = Router();

storesRouter.use(authenticate);
storesRouter.get('/', asyncHandler(getStores));
storesRouter.get('/current', validateRequest({ query: storeIdQuerySchema }), asyncHandler(getCurrentStore));
storesRouter.put('/current', validateRequest({ query: storeIdQuerySchema, body: updateStoreSchema }), asyncHandler(updateStore));
// Workspace & store: fill from the connected shop now, and the industry vocabulary guided setup uses.
storesRouter.post('/current/refresh-from-shopify', validateRequest({ query: storeIdQuerySchema }), asyncHandler(refreshStoreFromShopify));
storesRouter.get('/profile-options', asyncHandler(getStoreProfileOptions));
