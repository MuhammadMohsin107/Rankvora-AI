import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { getCurrentStoreId } from '../services/store.service.js';
import { getPageSpeedStatus, runPageSpeedMeasurement } from '../services/pagespeed.service.js';

/**
 * ─── PageSpeed Insights endpoints ────────────────────────────────────
 *
 * Both handlers resolve the store with getCurrentStoreId(), which scopes to stores the caller
 * owns — so a storeId in a query string can never aim a measurement, or a stored result, at
 * somebody else's shop.
 *
 * THERE IS NO CONNECT AND NO CALLBACK HERE, and that is not an omission. PageSpeed Insights
 * measures a public url and asks for no merchant credential; there is nothing to authorise. The
 * url measured comes from the store record Shopify's install wrote, never from the request.
 */

export async function getPagespeedStatus(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await getPageSpeedStatus(storeId) });
}

/**
 * Runs a real measurement now and returns the connector's state with it in place.
 *
 * SLOW BY NATURE — Google loads the storefront in a headless browser on its own hardware, and
 * tens of seconds is the normal case for both strategies. The client is told that before it
 * waits rather than being left on a spinner that looks stuck.
 */
export async function postPagespeedRun(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await runPageSpeedMeasurement(storeId) });
}
