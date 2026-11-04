import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopifyConnections } from '../db/schema.js';
import { aiConfigured, aiModelName } from '../config/env.js';
import { classifyFixability, type FixabilityVerdict } from '../lib/ai/fix-policy.js';

/**
 * ─── "What can Rankvora AI actually do about this finding?" ──────────────
 *
 * Answered once per request and attached to every finding, so the UI can tell a merchant what is
 * possible BEFORE they open anything. Without it the AI capability is invisible: a customer only
 * discovers that Rankvora AI can draft a value by opening a drawer and noticing a button, which means
 * most of them never discover it at all.
 *
 * Every input is a fact we hold:
 *   · the field allow-list           (fix-policy.ts)
 *   · the scopes the merchant granted (shopify_connections.scope — what they actually consented to)
 *   · whether a model is configured   (env)
 *
 * No model is consulted to produce this. Deciding what may be written to a live storefront is the
 * one question that must never depend on a generated answer.
 */

export interface FixContext {
  grantedScopes: string[];
  aiAvailable: boolean;
  /** The configured model, so the UI can name it. Never the key. */
  aiModel: string | null;
}

/**
 * Reads the store's live connection once.
 *
 * A store with no connection gets an empty scope list, which classifies every writable field as
 * `needs_access` — correct, and the reason the UI shows says "connect your store" rather than
 * offering an Apply button that would 401.
 */
export async function getFixContext(storeId: number): Promise<FixContext> {
  const [connection] = await db
    .select({ scope: shopifyConnections.scope })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);

  const grantedScopes = (connection?.scope ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    grantedScopes,
    aiAvailable: aiConfigured(),
    // Whichever vendor is configured. Reading env.openaiModel here hard-coded one of them into a
    // service that has no business knowing which is in use.
    aiModel: aiConfigured() ? aiModelName() : null,
  };
}

/** The verdict for one finding, given a context already loaded for its store. */
export function fixabilityFor(
  finding: { subPillar: string; resolutionType?: string | null },
  context: FixContext,
): FixabilityVerdict {
  return classifyFixability({
    subPillar: finding.subPillar,
    resolutionType: finding.resolutionType ?? null,
    grantedScopes: context.grantedScopes,
    aiAvailable: context.aiAvailable,
  });
}
