import type { Request, Response } from 'express';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { findCurrentStore, getCurrentStoreId } from '../services/store.service.js';
import {
  addPromptQuery,
  clearIndexNowKey,
  deletePromptQuery,
  getAiDiscoveryConfig,
  listPromptQueries,
  setIndexNowKey,
  setPromptQueryActive,
  MAX_PROMPT_QUERIES,
} from '../services/ai-discovery.service.js';
import { runPromptSweep } from '../services/prompt-tracking.service.js';
import { generateAgentFiles } from '../services/llms-txt.service.js';
import { resolveStoreDataProvider } from '../audit-engine/store-data/index.js';
import { aiConfigured, aiModelName } from '../config/env.js';
import { HEALTHY_RATE, MIN_SAMPLES } from '../audit-engine/checks/ai-discovery/prompt-tracking.js';
import { getAiReferralPerformance } from '../services/ai-referrals.service.js';
import { getIndexCoverage } from '../services/url-inspection.service.js';
import { listTestableBots, runBotTest } from '../services/bot-test.service.js';
import { getPromptHistory } from '../services/prompt-history.service.js';
import { getProductAiReadiness } from '../services/product-ai-readiness.service.js';
import { ApiError } from '../middleware/error.js';

/**
 * ─── AI Discovery settings API ───────────────────────────────────────
 * The two merchant-owned inputs the pillar needs, plus the file generator.
 *
 * Every response states what is really configured. Nothing here returns a placeholder, a sample
 * key or an example question — a store that has set nothing up gets nulls and empty lists, which
 * is what the UI renders an empty state from.
 */

/** Everything the AI Discovery settings page needs, in one request. */
export async function getSettings(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const [config, queries] = await Promise.all([getAiDiscoveryConfig(storeId), listPromptQueries(storeId)]);

  res.json({
    data: {
      indexNow: config,
      promptTracking: {
        queries,
        maxQueries: MAX_PROMPT_QUERIES,
        minSamples: MIN_SAMPLES,
        // The check's own band, so the list colours a rate by it rather than by a retyped copy.
        healthyRate: HEALTHY_RATE,
        // Stated so the page can explain WHY nothing is being checked, rather than showing an
        // empty result the merchant would read as "we are never mentioned".
        aiConfigured: aiConfigured(),
        model: aiConfigured() ? aiModelName() : null,
      },
    },
  });
}

export async function postIndexNowKey(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await setIndexNowKey(storeId, req.body?.key) });
}

export async function deleteIndexNowKey(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await clearIndexNowKey(storeId) });
}

export async function getPromptQueries(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await listPromptQueries(storeId) });
}

export async function postPromptQuery(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.status(201).json({ data: await addPromptQuery(storeId, req.body.query, req.body.brandTerm) });
}

export async function patchPromptQuery(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  await setPromptQueryActive(storeId, Number(req.params.id), req.body.active);
  res.json({ data: await listPromptQueries(storeId) });
}

export async function removePromptQuery(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  await deletePromptQuery(storeId, Number(req.params.id));
  res.json({ data: await listPromptQueries(storeId) });
}

/**
 * Asks every active question once, now.
 *
 * Synchronous because the merchant pressed a button and is watching. Bounded by the tracked-query
 * cap, and each answer is recorded as it arrives — a partial sweep leaves real rows for the
 * questions that succeeded rather than discarding them.
 */
export async function postPromptSweep(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const result = await runPromptSweep(storeId);
  res.json({ data: { ...result, queries: await listPromptQueries(storeId) } });
}

/**
 * Generates llms.txt, llms-full.txt and agents.md from the store as it is right now.
 *
 * Reads the store live rather than from the last audit, because a merchant generating these files
 * has usually just finished editing the catalogue — handing them a file built from a week-old
 * snapshot would publish stale claims at their own domain.
 *
 * This RETURNS the content. It does not publish: Rankvora AI has no app proxy and no theme extension,
 * so the merchant publishes it themselves, and the audit verifies by really requesting the URL.
 */
export async function getAgentFiles(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const provider = await resolveStoreDataProvider(storeId);
  const snapshot = await provider.buildSnapshot();
  res.json({ data: generateAgentFiles(snapshot) });
}

/**
 * The store's own storefront origin, as a bare `https://host` with no path.
 *
 * Everything that probes the storefront resolves through here so a caller-supplied path can never
 * redirect a request at a third-party host: the origin comes from the store record, not the body.
 * A store row without a usable URL is refused rather than defaulted — guessing the myshopify domain
 * would silently probe a host the merchant may not serve their canonical content from.
 */
async function requireStoreOrigin(req: Request): Promise<{ storeId: number; origin: string }> {
  const store = await findCurrentStore(requireUserId(req), optionalStoreId(req));
  const raw = store.url?.trim();
  if (!raw) {
    throw new ApiError(409, 'This store has no storefront URL saved, so nothing can be requested from it.', 'STORE_URL_MISSING');
  }
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { storeId: store.id, origin: url.origin };
  } catch {
    throw new ApiError(409, `“${raw}” is not a URL Rankvora AI can request.`, 'STORE_URL_INVALID');
  }
}

/**
 * Real AI referral traffic from the store's own GA4 property.
 *
 * The only OUTCOME measure in the pillar — every other check measures readiness. See
 * services/ai-referrals.service.ts for why the response always carries `isFloor`.
 */
export async function getAiReferrals(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const days = Number(req.query.days) || 28;
  res.json({ data: await getAiReferralPerformance(storeId, days) });
}

/**
 * What Google actually has indexed, sampled from the store's own sitemap.
 *
 * Reads through the `webmasters.readonly` grant every connection already carries — no re-consent.
 * The sample size is capped in the service because each inspection spends the merchant's own
 * Search Console quota.
 */
export async function getGoogleIndexCoverage(req: Request, res: Response) {
  const { storeId, origin } = await requireStoreOrigin(req);
  const sample = Number(req.query.sample) || undefined;
  res.json({ data: await getIndexCoverage(storeId, origin, sample) });
}

/** Every crawler the merchant can test, and whether a live probe is possible for it. */
export function getTestableBots(_req: Request, res: Response) {
  res.json({ data: { bots: listTestableBots() } });
}

/**
 * Really fetches one of the store's own URLs as one named crawler, right now.
 *
 * Synchronous because the merchant pressed a button and is watching — this is the check they run
 * straight after editing robots.txt, and a queued job would be useless for that.
 */
export async function postBotTest(req: Request, res: Response) {
  const { origin } = await requireStoreOrigin(req);
  const bot = String(req.body?.bot ?? '').trim();
  const path = String(req.body?.path ?? '/').trim() || '/';
  res.json({ data: await runBotTest(origin, bot, path) });
}

/** Recorded assistant observations over time. Gaps stay gaps; see the service header. */
export async function getPromptTrend(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const days = Number(req.query.days) || 90;
  res.json({ data: await getPromptHistory(storeId, days) });
}

/**
 * One row per product, ranked worst-first by AI readiness.
 *
 * The same three product-level checks an audit runs, inverted from "84% of products pass" into
 * "these products do not" — which is the only form a merchant can act on. Reads the store live
 * through the audit's own provider, so a catalogue edited a minute ago is reflected.
 */
export async function getProductReadiness(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await getProductAiReadiness(storeId) });
}
