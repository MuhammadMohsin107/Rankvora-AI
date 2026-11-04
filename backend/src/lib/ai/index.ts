import { env } from '../../config/env.js';
import { geminiProvider } from './gemini.provider.js';
import { openAiProvider } from './openai.provider.js';
import type { AiProvider } from './provider.js';

/**
 * ─── Provider selection ──────────────────────────────────────────────
 * The one place that decides which vendor serves an AI request, chosen by AI_PROVIDER.
 *
 * Services import from HERE rather than reaching for a vendor file directly. That is what makes
 * the seam real: adding a third provider is a new file plus one line in the map below, and
 * ai-fix.service.ts / ai-recommendation.service.ts never learn that anything changed.
 *
 * Resolved per call rather than captured once at module load, so a deployment that changes
 * AI_PROVIDER takes effect on restart without any import-order subtlety, and so a test can point
 * env at a different vendor between cases.
 */
const PROVIDERS: Record<string, AiProvider> = {
  openai: openAiProvider,
  gemini: geminiProvider,
};

/**
 * The configured provider.
 *
 * An unrecognised AI_PROVIDER falls back to OpenAI rather than throwing at startup: a typo in one
 * environment variable must not take the whole API down, and every AI path already degrades to the
 * deterministic recommendation when a call cannot be made.
 */
export function aiProvider(): AiProvider {
  return PROVIDERS[env.aiProvider] ?? openAiProvider;
}

export type { AiProvider };
