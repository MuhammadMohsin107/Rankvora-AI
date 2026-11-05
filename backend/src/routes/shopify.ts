import { Router } from 'express';
import {
  getCallback,
  getInstall,
  getStatus,
  postDisconnect,
  postOpen,
  postSync,
  postWebhookAppScopesUpdate,
  postWebhookAppUninstalled,
  postWebhookCustomersDataRequest,
  postWebhookCustomersRedact,
  postWebhookShopRedact,
} from '../controllers/shopify.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { installQuerySchema, openBodySchema } from '../schemas/shopify.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const shopifyRouter = Router();

// The bare site's "which store?" form. Anonymous and session-free: it only turns a store address into the
// Shopify address to go to (the app in their admin, or Shopify's install screen), so Shopify does the
// authenticating. Limited like the other anonymous endpoint, since it reads the database.
shopifyRouter.post(
  '/open',
  rateLimit({ name: 'shopify:open', windowMs: 60 * 1000, max: 20, message: 'Too many attempts. Please wait a moment and try again.' }),
  validateRequest({ body: openBodySchema }),
  asyncHandler(postOpen),
);

// Install must be authenticated (it signs the caller's user id into the OAuth state).
shopifyRouter.get('/install', authenticate, validateRequest({ query: installQuerySchema }), asyncHandler(getInstall));

// Callback is hit directly by Shopify's redirect — no Rankvora AI session exists yet; the signed
// state param (not a cookie/header) is what proves which Rankvora AI user is connecting.
//
// It deliberately does NOT use validateRequest: this endpoint receives a browser, so a malformed
// or declined callback has to end in a redirect back to the app rather than a JSON 400. The
// controller validates with the same schema and redirects on failure.
shopifyRouter.get('/callback', asyncHandler(getCallback));

// Connection state, real sync and disconnect — all scoped to the caller's own store.
shopifyRouter.get('/status', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(getStatus));
shopifyRouter.post('/sync', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(postSync));
shopifyRouter.post('/disconnect', authenticate, validateRequest({ query: storeIdQuerySchema }), asyncHandler(postDisconnect));

// Webhooks are authenticated via per-request HMAC (verifyWebhookOrThrow), not a user session.
shopifyRouter.post('/webhooks/app-uninstalled', asyncHandler(postWebhookAppUninstalled));
shopifyRouter.post('/webhooks/app-scopes-update', asyncHandler(postWebhookAppScopesUpdate));
shopifyRouter.post('/webhooks/customers-data-request', asyncHandler(postWebhookCustomersDataRequest));
shopifyRouter.post('/webhooks/customers-redact', asyncHandler(postWebhookCustomersRedact));
shopifyRouter.post('/webhooks/shop-redact', asyncHandler(postWebhookShopRedact));
