import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { onboardingState } from '../db/schema.js';
import { EMPTY_BUSINESS_CONTEXT, type BusinessContext } from '../lib/ai/businessContext.js';
import { readOnboardingPreferences } from './onboarding-preferences.service.js';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

/**
 * What this store's merchant said about their business in guided setup, for the AI drafting
 * prompts. Two small indexed reads; no network call. A store that never opened setup returns the
 * empty context, so its prompts are unchanged.
 *
 * NEVER THROWS. This runs inside a request that is about to ask a model for a draft, and a failure
 * to read optional context must cost the draft its extra detail, not the merchant their draft.
 */
export async function readBusinessContext(storeId: number): Promise<BusinessContext> {
  try {
    const [row] = await db
      .select({
        brandName: onboardingState.brandName,
        industries: onboardingState.industries,
        sellsDescription: onboardingState.sellsDescription,
      })
      .from(onboardingState)
      .where(eq(onboardingState.storeId, storeId))
      .limit(1);
    if (!row) return { ...EMPTY_BUSINESS_CONTEXT };

    const preferences = await readOnboardingPreferences(storeId);
    return {
      brandName: row.brandName?.trim() || null,
      industries: strings(row.industries),
      sells: row.sellsDescription?.trim() || null,
      contentLanguage: preferences.contentLanguage,
    };
  } catch {
    return { ...EMPTY_BUSINESS_CONTEXT };
  }
}
