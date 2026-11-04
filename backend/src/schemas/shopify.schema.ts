import { z } from 'zod';

const shopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'Must be a *.myshopify.com domain');

export const installQuerySchema = z.object({
  shop: shopDomainSchema,
}).strict();

// Shopify's OAuth callback appends its own query params (hmac, timestamp, host, etc.) — this
// schema intentionally does NOT use .strict() since HMAC verification needs the raw, complete
// query object exactly as Shopify sent it (stripping unknown keys first would break the check).
export const callbackQuerySchema = z.object({
  shop: shopDomainSchema,
  code: z.string().min(1),
  state: z.string().min(1),
  hmac: z.string().min(1),
  timestamp: z.string().min(1),
}).passthrough();

/**
 * A random value the browser generates and keeps in sessionStorage for the length of one sign-in.
 * Only its hash leaves for Shopify; the raw value is presented once, at completion. Bounded so the
 * field cannot carry anything but a base64url token.
 */
const loginNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Invalid sign-in nonce');

/** "Sign in with Shopify" from Rankvora AI's own login page: the merchant typed their store address. */
export const shopifyLoginStartSchema = z.object({
  shop: shopDomainSchema,
  nonce: loginNonceSchema,
}).strict();

/**
 * Shopify opened Rankvora AI — from the App Store install or the Apps list in the admin — and appended
 * a signed query. It is forwarded VERBATIM: the HMAC is computed over the exact strings Shopify
 * sent, so nothing here may trim, lowercase or drop a key. The service verifies it.
 */
export const shopifyLoginLaunchSchema = z.object({
  launch: z
    .record(z.string().max(64), z.string().max(2048))
    .refine((query) => Object.keys(query).length <= 20, 'Too many launch parameters'),
  nonce: loginNonceSchema,
}).strict();

export const shopifyLoginCompleteSchema = z.object({
  grant: z.string().min(1).max(2048),
  nonce: loginNonceSchema,
}).strict();

export type InstallQuery = z.infer<typeof installQuerySchema>;
export type CallbackQuery = z.infer<typeof callbackQuerySchema>;
