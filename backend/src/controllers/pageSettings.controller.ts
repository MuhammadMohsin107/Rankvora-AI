import type { Request, Response } from 'express';
import {
  getPageSettingsBySlug,
  upsertPageSettingsBySlug,
} from '../services/pageSettings.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

/**
 * The stored slug, from whichever route shape the request arrived on.
 *
 * SEO sub-pillars are one segment ('title-tags'); the generic pillars are two
 * ('ai-discovery' + 'feed') and are stored joined, exactly as they were when the client sent them
 * as a single percent-encoded segment. Only the transport changed — see routes/page-settings.ts
 * for why it had to.
 */
function slugFrom(req: Request): string {
  const { pillar, subPillar, slug } = req.params as { pillar?: string; subPillar?: string; slug?: string };
  return pillar && subPillar ? `${pillar}/${subPillar}` : String(slug);
}

export async function getPageSettings(req: Request, res: Response) {
  res.json({ data: await getPageSettingsBySlug(requireUserId(req), slugFrom(req), optionalStoreId(req)) });
}

export async function upsertPageSettings(req: Request, res: Response) {
  res.json({ data: await upsertPageSettingsBySlug(requireUserId(req), slugFrom(req), req.body, optionalStoreId(req)) });
}
