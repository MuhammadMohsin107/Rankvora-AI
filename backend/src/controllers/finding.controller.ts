import type { Request, Response } from 'express';
import { bulkUpdateFindingStatus, getFinding, listFindings, updateFindingStatus } from '../services/finding.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { aiRecommendationStatus, getAiRecommendation } from '../services/ai-recommendation.service.js';
import { aiFixStatus, decideFixProposal, decideFixProposals, listFixProposals, planAiFixes, planAiFixesForFindings } from '../services/ai-fix.service.js';
import { applyApprovedProposals } from '../services/fix-apply.service.js';
import { getCurrentStoreId } from '../services/store.service.js';
import { createAuditJob } from '../services/job.service.js';
import { ApiError } from '../middleware/error.js';

export async function getFindings(req: Request, res: Response) {
  res.json({ data: await listFindings(requireUserId(req), req.query as never, optionalStoreId(req)) });
}

export async function getFindingById(req: Request, res: Response) {
  res.json({ data: await getFinding(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function patchFindingStatus(req: Request, res: Response) {
  res.json({ data: await updateFindingStatus(requireUserId(req), Number(req.params.id), req.body, optionalStoreId(req)) });
}

export async function patchBulkFindingStatus(req: Request, res: Response) {
  res.json({ data: await bulkUpdateFindingStatus(requireUserId(req), req.body, optionalStoreId(req)) });
}

/**
 * AI enhancement for one finding. Always 200: an unavailable model is a normal outcome that
 * returns the deterministic recommendation, not an error the caller must handle.
 */
export async function postAiRecommendation(req: Request, res: Response) {
  const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
  res.json({
    data: await getAiRecommendation(requireUserId(req), Number(req.params.id), { force, storeId: optionalStoreId(req) }),
  });
}

/** Capability probe so the UI can hide the action when no model is configured. Never returns
 * the key — only whether one is usable, and which model would run. */
export function getAiStatus(_req: Request, res: Response) {
  res.json({ data: aiRecommendationStatus() });
}

// ─── AI fix planning ─────────────────────────────────────────────────

/**
 * Plans AI fixes for one finding. Always 200: "AI could not help with this" is a normal outcome
 * carrying an unavailableReason, not an error — the deterministic suggestions the audit already
 * produced remain on the evidence rows either way.
 */
export async function postAiFixPlan(req: Request, res: Response) {
  const body = (req.body ?? {}) as { resourceIds?: string[]; limit?: number };
  res.json({
    data: await planAiFixes(requireUserId(req), Number(req.params.id), {
      storeId: optionalStoreId(req),
      resourceIds: body.resourceIds,
      limit: body.limit,
    }),
  });
}

/** The preview: every proposal on record for a finding, current beside proposed. */
export async function getAiFixProposals(req: Request, res: Response) {
  res.json({ data: await listFixProposals(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

/** Plans fixes across several selected findings — what the bulk Fix Center flow calls. */
export async function postAiFixPlanBulk(req: Request, res: Response) {
  const { findingIds } = req.body as { findingIds: number[] };
  res.json({ data: await planAiFixesForFindings(requireUserId(req), findingIds, { storeId: optionalStoreId(req) }) });
}

/** One explicit human decision on one proposal. */
export async function postAiFixDecision(req: Request, res: Response) {
  const { decision } = req.body as { decision: 'approve' | 'reject' };
  res.json({
    data: await decideFixProposal(requireUserId(req), Number(req.params.id), decision, { storeId: optionalStoreId(req) }),
  });
}

/** The decisions taken on one preview screen, applied independently. */
export async function postAiFixDecisions(req: Request, res: Response) {
  const body = req.body as { approve?: number[]; reject?: number[] };
  res.json({ data: await decideFixProposals(requireUserId(req), body, { storeId: optionalStoreId(req) }) });
}

/**
 * Writes approved proposals to the merchant's Shopify store, then re-audits.
 *
 * THE STORE IS RESOLVED, NOT ACCEPTED. `getCurrentStoreId` scopes to stores this user owns, so a
 * storeId in the query cannot aim a write at another customer's catalogue.
 *
 * THE RE-AUDIT IS WHY THE SCORE MOVES. Applying changes the storefront; `audit_scores` is written
 * only by the audit runner, so without a fresh run the merchant would see "12 fixes applied" beside
 * an unchanged score and reasonably conclude the feature is broken.
 *
 * It is BEST-EFFORT and deliberately cannot fail the request: the writes have already happened and
 * are not undone by a queueing problem. A 409 here is the ordinary case of an audit already running
 * — that run will pick the changes up anyway — so it is reported as `reaudit: 'already-running'`
 * rather than raised. Nothing is queued when every proposal was skipped or failed, because there is
 * no change for an audit to find.
 */
export async function postApplyFixes(req: Request, res: Response) {
  const userId = requireUserId(req);
  const storeId = await getCurrentStoreId(userId, optionalStoreId(req));
  const summary = await applyApprovedProposals(storeId, req.body.fixes, userId);

  let reaudit: 'queued' | 'already-running' | 'not-needed' | 'failed' = 'not-needed';
  // The queued job's id, so the app can follow that run like one it started itself — show its
  // progress and reload the pages when it finishes. Null whenever no job was queued here.
  let reauditJobId: number | null = null;
  if (summary.applied > 0) {
    try {
      reauditJobId = (await createAuditJob(userId, storeId)).id;
      reaudit = 'queued';
    } catch (error) {
      reaudit = error instanceof ApiError && error.statusCode === 409 ? 'already-running' : 'failed';
      console.warn(`[scorelo-fix] re-audit not queued after apply (store ${storeId}): ${reaudit}`);
    }
  }

  res.json({ data: { ...summary, reaudit, reauditJobId } });
}

export async function getAiFixStatus(_req: Request, res: Response) {
  res.json({ data: aiFixStatus() });
}
