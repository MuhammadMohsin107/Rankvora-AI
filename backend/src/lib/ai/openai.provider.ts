import { env } from '../../config/env.js';
import { withRetry, type AttemptContext } from './retry.js';
import type {
  AiAskResult,
  AiFixResult,
  AiFailureReason,
  AiProvider,
  AiRecommendation,
  AiResult,
  FixPlanContext,
  RecommendationContext,
} from './provider.js';
import {
  ASK_OUTPUT_TOKENS,
  FIX_SYSTEM_PROMPT,
  fixOutputTokens,
  MAX_OUTPUT_TOKENS,
  sourceTextLimit,
  SYSTEM_PROMPT,
  buildFixMessage,
  buildUserMessage,
  parseJson,
  validateProposals,
  validateRecommendation,
} from './prompt.js';

/**
 * ─── OpenAI provider ─────────────────────────────────────────────────
 * Hand-rolled over fetch, matching how ShopifyClient talks to Shopify — no SDK dependency, and
 * full control over the timeout, which matters because this call sits in a request path.
 *
 * SECURITY: the key is read from the server environment at call time and travels only in the
 * Authorization header. It is never logged, never returned, never placed in an error message,
 * and never reaches the browser (the frontend calls Rankvora AI, Rankvora AI calls OpenAI).
 *
 * STRUCTURED OUTPUT: `json_schema` with `strict: true` makes the model return exactly the four
 * fields, so parsing cannot drift. The response is still validated after parsing — a provider
 * promising a shape is not the same as receiving it.
 *
 * The PROMPTS and the VALIDATION are not here: they live in prompt.ts, shared with the Gemini
 * provider, because what Rankvora AI asks for and what it accepts must not depend on the vendor.
 */

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';


const RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'scorelo_recommendation',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['recommendation', 'whyItMatters', 'suggestedAction', 'confidence'],
      properties: {
        recommendation: { type: 'string', description: 'The improved recommendation, 1-3 sentences.' },
        whyItMatters: { type: 'string', description: 'The business consequence, 1-2 sentences.' },
        suggestedAction: { type: 'string', description: 'One concrete next step the merchant can take.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
  },
};


/** Maps an HTTP status to the caller-facing reason. All of them end in the same place —
 * deterministic fallback — but the distinction matters in logs and for quota alerting. */
function reasonFor(status: number): AiFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota';
  return 'server';
}


// ─── Fix planning ────────────────────────────────────────────────────



const FIX_RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'scorelo_fix_proposals',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['proposals'],
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'proposedValue', 'reason'],
            properties: {
              ref: { type: 'string', description: 'The resource ref, echoed back exactly.' },
              proposedValue: { type: 'string', description: 'The replacement value, plain text, within the stated character range.' },
              reason: { type: 'string', description: 'One short sentence explaining the change.' },
            },
          },
        },
      },
    },
  },
};



/**
 * The single HTTP path to OpenAI. Both capabilities go through it so the timeout, the abort
 * signal, the "never keep an upstream error body" rule and the failure classification exist once
 * — a second copy is a second place for the key handling to be got wrong.
 */
async function chatCompletion(
  label: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  responseFormat: unknown,
  maxTokens: number,
): Promise<{ ok: true; content: string } | { ok: false; reason: AiFailureReason; detail: string }> {
  const apiKey = env.openaiApiKey;
  if (!apiKey) return { ok: false, reason: 'disabled', detail: 'no API key configured' };

  const result = await withRetry(label, (attemptContext) => attemptCompletion(apiKey, attemptContext, messages, responseFormat, maxTokens));
  return result.ok ? { ok: true, content: result.value } : result;
}

/** One HTTP attempt. The retry wrapper decides whether there is a second. */
async function attemptCompletion(
  apiKey: string,
  { timeoutMs }: AttemptContext,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  responseFormat: unknown,
  maxTokens: number,
): Promise<{ ok: true; value: string } | { ok: false; reason: AiFailureReason; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.openaiModel,
        max_completion_tokens: maxTokens,
        // Low but non-zero: consistent phrasing across runs without being robotic.
        temperature: 0.3,
        response_format: responseFormat,
        messages,
      }),
    });

    if (!response.ok) {
      // The body may echo request details; only the status is kept, never the response text,
      // so nothing from an upstream error can leak into logs or to a customer.
      return { ok: false, reason: reasonFor(response.status), detail: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, reason: 'invalid_response', detail: 'empty completion' };
    return { ok: true, value: content };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      detail: aborted ? `timed out after ${timeoutMs}ms` : 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export const openAiProvider: AiProvider = {
  name: 'openai',

  async enhance(context: RecommendationContext): Promise<AiResult> {
    const response = await chatCompletion(
      'enhance',
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(context) },
      ],
      RESPONSE_SCHEMA,
      MAX_OUTPUT_TOKENS,
    );
    if (!response.ok) return response;

    const parsed = parseJson(response.content);
    if (parsed === null) return { ok: false, reason: 'invalid_response', detail: 'completion was not valid JSON' };

    const recommendation: AiRecommendation | null = validateRecommendation(parsed);
    if (!recommendation) return { ok: false, reason: 'invalid_response', detail: 'completion failed validation' };

    return { ok: true, recommendation, model: env.openaiModel };
  },

  async planFix(context: FixPlanContext): Promise<AiFixResult> {
    if (context.targets.length === 0) {
      return { ok: false, reason: 'invalid_response', detail: 'no targets supplied' };
    }

    const response = await chatCompletion(
      'planFix',
      [
        { role: 'system', content: FIX_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildFixMessage({
            ...context,
            targets: context.targets.map((target) => ({ ...target, sourceText: target.sourceText.slice(0, sourceTextLimit(context.targets.length)) })),
          }),
        },
      ],
      FIX_RESPONSE_SCHEMA,
      fixOutputTokens(context.targets.length),
    );
    if (!response.ok) return response;

    const parsed = parseJson(response.content);
    if (parsed === null) return { ok: false, reason: 'invalid_response', detail: 'completion was not valid JSON' };

    const proposals = validateProposals(parsed);
    if (!proposals) return { ok: false, reason: 'invalid_response', detail: 'completion did not contain a proposals array' };
    if (proposals.length === 0) return { ok: false, reason: 'invalid_response', detail: 'completion contained no usable proposals' };

    return { ok: true, proposals, model: env.openaiModel };
  },

  async ask(question: string): Promise<AiAskResult> {
    const response = await chatCompletion(
      'ask',
      // No system message. Every other capability here supplies one; this must not, because the
      // measurement is what the model says on its own. A system prompt mentioning the store, the
      // shop, or even "be helpful to shoppers" would bias the very answer being observed.
      [{ role: 'user', content: question }],
      // Plain text, not a schema: the reply IS the evidence and is searched verbatim.
      { type: 'text' },
      ASK_OUTPUT_TOKENS,
    );
    if (!response.ok) return response;

    const text = response.content.trim();
    if (!text) return { ok: false, reason: 'invalid_response', detail: 'the model returned an empty answer' };
    return { ok: true, text, model: env.openaiModel };
  },
};
