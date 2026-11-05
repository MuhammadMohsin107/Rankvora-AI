import { z } from 'zod';

const shopDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'Must be a *.myshopify.com domain');

export const installQuerySchema = z.object({
  shop: shopDomainSchema,
}).strict();

// What a visitor types on the bare site. Deliberately loose: parseShopHandle (lib/shopify-shop.ts)
// decides what it means, so the same mistakes get the same plain-language answer wherever they come from.
export const openBodySchema = z.object({
  shop: z.string().max(300),
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

export type OpenBody = z.infer<typeof openBodySchema>;
export type InstallQuery = z.infer<typeof installQuerySchema>;
export type CallbackQuery = z.infer<typeof callbackQuerySchema>;
