import type { Request, Response } from 'express';
import { getAuditScores, getLatestAudit, getSubPillarAnalysis, listAudits } from '../services/audit.service.js';
import { createAuditJob } from '../services/job.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { implementedSubPillars } from '../audit-engine/index.js';
import { FIELD_RULES } from '../lib/ai/fix-policy.js';

/**
 * What Rankvora AI can MEASURE and what it can WRITE. Two different questions, both store-independent.
 *
 * `implementedSubPillars` tells two empty states apart: "you have not run an audit yet" (offer to
 * run one) versus "Rankvora AI cannot measure this yet" (running an audit will not change anything).
 * Without it, every unimplemented sub-pillar shows a Run Audit button that provably cannot help.
 *
 * `fixableSubPillars` answers the second question, and exists because the UI was getting it wrong
 * in a way that mattered. Every non-SEO sub-pillar page offered "Generate fixes" on its evidence
 * rows, because the generic page hardcoded `supportsBulkFix: true`. But Rankvora AI can only write
 * three fields in total — seo.title, seo.description and image.alt — so on Catalog / Feed
 * Readiness a merchant could select 73 products, press Generate fixes, and reach a dialog offering
 * to write a GTIN.
 *
 * That is the worst possible place for a dead end. A GTIN is a manufacturer's identifier: it
 * cannot be derived from the product, and a model asked to produce one would return a plausible
 * 13-digit number that belongs to somebody else's product or to nothing at all — then write it to
 * a live storefront, where feeds and marketplaces would match on it. The empty dialog was in fact
 * the safe outcome; the button should never have been there.
 *
 * Derived from FIELD_RULES rather than hand-listed, so adding a writable field enables its bulk-fix
 * UI automatically and nothing can claim a capability the fix engine does not have.
 */
export function getCapabilities(_req: Request, res: Response) {
  const fixableSubPillars = Object.values(FIELD_RULES).map((rule) => rule.subPillar);
  res.json({ data: { implementedSubPillars, fixableSubPillars } });
}

export async function listAuditRuns(req: Request, res: Response) {
  res.json({ data: await listAudits(requireUserId(req), req.query as never, optionalStoreId(req)) });
}

export async function getLatestAuditRun(req: Request, res: Response) {
  res.json({ data: await getLatestAudit(requireUserId(req), req.query as never, optionalStoreId(req)) });
}

export async function getScores(req: Request, res: Response) {
  res.json({ data: await getAuditScores(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function getLatestSubPillarAnalysis(req: Request, res: Response) {
  res.json({ data: await getSubPillarAnalysis(requireUserId(req), String(req.params.pillar), String(req.params.subPillar), optionalStoreId(req)) });
}

export async function postRunAudit(req: Request, res: Response) {
  const job = await createAuditJob(requireUserId(req), optionalStoreId(req));
  res.status(202).json({ data: job });
}
