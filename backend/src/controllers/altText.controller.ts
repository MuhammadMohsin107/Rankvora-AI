import type { Request, Response } from 'express';
import { getAltTextConfig, saveAltTextConfig } from '../services/altText.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

/**
 * Image alt-text template configuration.
 *
 * Both handlers are store-scoped through the services, which resolve the caller's own store —
 * no storeId from the body is ever treated as identity. NONE of these write to Shopify: saving a
 * template is configuration, and applying alt text to a store is a separate act the merchant has
 * to take explicitly.
 */

export async function getAltTextSettings(req: Request, res: Response) {
  res.json({ data: await getAltTextConfig(requireUserId(req), optionalStoreId(req)) });
}

export async function putAltTextSettings(req: Request, res: Response) {
  res.json({ data: await saveAltTextConfig(requireUserId(req), req.body.config, optionalStoreId(req)) });
}
