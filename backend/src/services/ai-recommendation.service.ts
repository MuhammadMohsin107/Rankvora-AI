import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chunkForD1 } from '../db/limits.js';
import { updateReturning } from '../db/returning.js';
import { audits, findings, stores } from '../db/schema.js';
import { aiConfigured, aiModelName, env } from '../config/env.js';
import { aiProvider } from '../lib/ai/index.js';
import type { AiProvider, RecommendationContext } from '../lib/ai/provider.js';
import { getFinding } from './finding.service.js';

/**
 * ─── AI recommendation service ───────────────────────────────────────
 * Enhances ONE finding's recommendation on explicit request.
 *
 * The deterministic recommendation produced by the audit check is the source of truth and is
 * never modified. AI output is stored alongside it and is always advisory. Every failure path —
 * no key, flag off, timeout, auth, rate limit, quota, malformed output — resolves to the same
 * outcome: the deterministic text, and `enhanced: false`. An audit or a page load can never break
 * because a model was unavailable.
 *
 * COST CONTROL: results are cached on the finding row. A repeat request returns the cached text
 * without calling the provider, so rendering a dashboard, reopening a drawer, or refreshing a
 * page costs nothing. Regeneration is opt-in via `force`.
 */

/** Swappable for tests and for a future second vendor; the service knows only the interface. */
// Resolved per call from AI_PROVIDER, so the vendor is a deployment choice rather than an import.
const provider = (): AiProvider => aiProvider();

export interface AiRecommendationResult {
  findingId: number;
  /** Always present — the deterministic recommendation, whatever happened with AI. */
  recommendation: string;
  /** True only when AI text is being returned. */
  enhanced: boolean;
  ai: {
    recommendation: string;
    whyItMatters: string;
    suggestedAction: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  model: string | null;
  generatedAt: string | null;
  /** True when the response came from cache rather than a fresh provider call. */
  cached: boolean;
  /**
   * Present only when enhancement did not happen. Deliberately coarse and non-technical: raw
   * provider errors are logged server-side, never returned.
   */
  unavailableReason?: 'disabled' | 'unavailable';
}

/**
 * Builds the model's input. Only audit facts — no tokens, no credentials, no shop domain, no
 * customer or order data. `storeName` is the merchant's own display name, included because
 * "add the brand to the title" is a materially better recommendation when the model knows it.
 */
function buildContext(
  finding: typeof findings.$inferSelect,
  storeName: string | null,
): RecommendationContext {
  return {
    pillar: finding.pillar,
    subPillar: finding.subPillar,
    findingTitle: finding.title,
    severity: finding.severity,
    problem: finding.problem,
    why: finding.why,
    deterministicRecommendation: finding.recommendation,
    affectedCount: finding.affectedCount,
    affectedLabel: finding.affectedLabel,
    evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 6) : [],
    storeName,
  };
}

function toResult(finding: typeof findings.$inferSelect, cached: boolean): AiRecommendationResult {
  return {
    findingId: finding.id,
    recommendation: finding.recommendation,
    enhanced: Boolean(finding.aiRecommendation),
    ai: finding.aiRecommendation ?? null,
    model: finding.aiModel ?? null,
    generatedAt: finding.aiGeneratedAt ? finding.aiGeneratedAt.toISOString() : null,
    cached,
  };
}

/**
 * Returns the AI-enhanced recommendation for a finding, generating it if needed.
 *
 * Tenancy is enforced by delegating the lookup to `getFinding`, which resolves the caller's own
 * store and 404s otherwise — so one account's audit data can never be sent to another account's
 * AI request.
 */
export async function getAiRecommendation(
  userId: number,
  findingId: number,
  options: { force?: boolean; storeId?: number } = {},
): Promise<AiRecommendationResult> {
  // Throws 404 unless this finding belongs to a store the caller owns.
  const finding = await getFinding(userId, findingId, options.storeId);

  // Cache hit — no provider call, no spend.
  if (finding.aiRecommendation && !options.force) {
    return toResult(finding, true);
  }

  if (!aiConfigured()) {
    return {
      ...toResult(finding, false),
      enhanced: false,
      ai: null,
      unavailableReason: !env.aiRecommendationsEnabled ? 'disabled' : 'unavailable',
    };
  }

  // Store name only, resolved through the finding's own audit — never a domain or token.
  const [row] = await db
    .select({ name: stores.name })
    .from(findings)
    .innerJoin(audits, eq(findings.auditId, audits.id))
    .innerJoin(stores, eq(audits.storeId, stores.id))
    .where(eq(findings.id, finding.id))
    .limit(1);

  // Empty means not known yet — sent as null, never as a blank name.
  const result = await provider().enhance(buildContext(finding, row?.name?.trim() || null));

  if (!result.ok) {
    // Reason is recorded for operators; the customer is told only that AI was unavailable.
    console.warn(`[scorelo-ai] enhancement unavailable for finding ${finding.id}: ${result.reason} (${result.detail})`);
    return { ...toResult(finding, false), enhanced: false, ai: null, unavailableReason: 'unavailable' };
  }

  const generatedAt = new Date();
  const [updated] = await updateReturning(
    findings,
    { aiRecommendation: result.recommendation, aiModel: result.model, aiGeneratedAt: generatedAt },
    eq(findings.id, finding.id),
  );

  console.log(`[scorelo-ai] enhanced finding ${finding.id} with ${result.model} (confidence ${result.recommendation.confidence})`);
  return toResult(updated ?? { ...finding, aiRecommendation: result.recommendation, aiModel: result.model, aiGeneratedAt: generatedAt }, false);
}

/** Whether the server can attempt AI at all — lets the UI hide the action instead of offering
 * something guaranteed to fail. Exposes capability only, never the key. */
export function aiRecommendationStatus(): { enabled: boolean; model: string | null } {
  return { enabled: aiConfigured(), model: aiConfigured() ? aiModelName() : null };
}

/** Re-exported for the audit runner should it ever want to clear stale AI text in bulk. */
export async function clearAiRecommendations(findingIds: number[]): Promise<void> {
  for (const piece of chunkForD1(findingIds)) {
    await db
      .update(findings)
      .set({ aiRecommendation: null, aiModel: null, aiGeneratedAt: null })
      .where(and(inArray(findings.id, piece)));
  }
}
