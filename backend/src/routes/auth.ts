import { Router } from 'express';
import { postShopifyEmbedded } from '../controllers/auth.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * SIGN-IN IS SHOPIFY ONLY, and it is this one route. There is no email sign-up, email-and-password
 * sign-in, password reset, email verification or second factor, no sign-in page, no refresh token and
 * no stored session: an account is opened only for a shop whose Shopify ID token checks out (see
 * lib/shopify-id-token.ts and shopify-embedded.service.ts), and every later request proves itself the
 * same way. A test fails the build if another route appears here.
 */
export const authRouter = Router();

// The embedded app's entry. It proves itself with the ID token App Bridge puts in the Authorization
// header, and it can call Shopify's token endpoint, so it is limited like the other endpoints that can.
authRouter.post(
  '/shopify/embedded',
  rateLimit({ name: 'auth:shopify-embedded', windowMs: 60 * 1000, max: 30, message: 'Too many requests. Please wait a moment and try again.' }),
  asyncHandler(postShopifyEmbedded),
);
