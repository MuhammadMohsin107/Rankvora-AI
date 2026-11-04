import { Router } from 'express';
import {
  postLogout,
  postRefresh,
  postShopifyComplete,
  postShopifyEmbedded,
  postShopifyLaunch,
  postShopifyStart,
} from '../controllers/auth.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { refreshSchema, logoutSchema } from '../schemas/auth.schema.js';
import { shopifyLoginCompleteSchema, shopifyLoginLaunchSchema, shopifyLoginStartSchema } from '../schemas/shopify.schema.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * SIGN-IN IS SHOPIFY ONLY. There is no email sign-up, email-and-password sign-in, password reset
 * or email-verification route: an account is opened and entered only after Shopify has
 * authenticated its store (see shopify-login.service.ts), and refresh() ends any session whose
 * account no longer has an installed store.
 */
export const authRouter = Router();

// ─── Sign in with Shopify ────────────────────────────────────────────
// Unauthenticated by necessity. Starting only builds an authorization URL — Shopify, not Rankvora AI,
// authenticates the merchant — so the limit there is about abuse, not guessing. Completion redeems
// a grant and is limited like the other credential-redeeming endpoints.
const shopifyStartLimit = rateLimit({ name: 'auth:shopify-start', windowMs: 15 * 60 * 1000, max: 20, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });

authRouter.post('/shopify/start', shopifyStartLimit, validateRequest({ body: shopifyLoginStartSchema }), asyncHandler(postShopifyStart));
authRouter.post('/shopify/launch', shopifyStartLimit, validateRequest({ body: shopifyLoginLaunchSchema }), asyncHandler(postShopifyLaunch));
authRouter.post(
  '/shopify/complete',
  rateLimit({ name: 'auth:shopify-complete', windowMs: 15 * 60 * 1000, max: 10, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' }),
  validateRequest({ body: shopifyLoginCompleteSchema }),
  asyncHandler(postShopifyComplete),
);

// The embedded app's entry: proves itself with the ID token App Bridge puts in the Authorization
// header. It can call Shopify's token endpoint, so it is limited like the other endpoints that can.
authRouter.post(
  '/shopify/embedded',
  rateLimit({ name: 'auth:shopify-embedded', windowMs: 60 * 1000, max: 30, message: 'Too many requests. Please wait a moment and try again.' }),
  asyncHandler(postShopifyEmbedded),
);

authRouter.post('/refresh', validateRequest({ body: refreshSchema }), asyncHandler(postRefresh));
authRouter.post('/logout', authenticate, validateRequest({ body: logoutSchema }), asyncHandler(postLogout));
