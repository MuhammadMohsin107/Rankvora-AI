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
 * ─── Google Gemini provider ──────────────────────────────────────────
 * The second implementation of AiProvider, added exactly as provider.ts anticipated: one file
 * beside openai.provider.ts, with no change to the audit engine, the services or the API.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The prompts, the validation and the JSON parsing live in
 * prompt.js and are used by BOTH providers — a recommendation must be held to the same rules
 * whichever vendor wrote it, and duplicating the system prompt would let the two drift into
 * giving different advice for the same finding. Only the transport differs, and that is all this
 * file contains.
 *
 * SECURITY: the key is read from the server environment at call time and travels only in the
 * `x-goog-api-key` header — never in the URL, where it would land in proxy and access logs. It is
 * never logged, never returned, and never reaches the browser.
 *
 * STRUCTURED OUTPUT: `responseMimeType: application/json` plus `responseSchema` is Gemini's
 * equivalent of OpenAI's strict json_schema. The response is still validated after parsing — a
 * provider promising a shape is not the same as receiving it.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini's schema dialect: uppercase type names, no `additionalProperties`, and `enum` carried on
 * the string type. Shapes match the OpenAI schemas field for field so both providers return the
 * same object.
 */
const RECOMMENDATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    recommendation: { type: 'STRING', description: 'The improved recommendation, 1-3 sentences.' },
    whyItMatters: { type: 'STRING', description: 'The business consequence, 1-2 sentences.' },
    suggestedAction: { type: 'STRING', description: 'One concrete next step the merchant can take.' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['recommendation', 'whyItMatters', 'suggestedAction', 'confidence'],
};

const FIX_SCHEMA = {
  type: 'OBJECT',
  properties: {
    proposals: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING', description: 'The resource ref, echoed back exactly.' },
          proposedValue: { type: 'STRING', description: 'The replacement value, plain text, within the stated character range.' },
          reason: { type: 'STRING', description: 'One short sentence explaining the change.' },
        },
        required: ['ref', 'proposedValue', 'reason'],
      },
    },
  },
  required: ['proposals'],
};

/**
 * Maps an upstream failure to the caller-facing reason. Mirrors the OpenAI provider's vocabulary
 * so both vendors produce the same operator-visible words.
 *
 * The 400 case is not cosmetic. Google answers a REJECTED API KEY with
 * `400 INVALID_ARGUMENT / API_KEY_INVALID`, not with 401 the way OpenAI does. Classifying that as
 * 'server' pointed operators at an outage when the real problem was a mistyped key.
 */
function reasonFor(status: number, detail: string): AiFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail)) return 'auth';
  if (status === 429) return 'rate_limit';
  // Google reports an exhausted free-tier quota as 429 too; 402 is included for completeness.
  if (status === 402) return 'quota';
  return 'server';
}

/**
 * Google's own words for why it refused, made safe to log.
 *
 * This body used to be discarded on the theory that an upstream error might echo request details.
 * The cost of that was concrete: an invalid key, an unknown model and a malformed schema all
 * arrive as the same "HTTP 400", so an operator had a status code and nothing to act on. Google
 * puts the reason in `error.message`, and the key is not in it — it travels in a header and is
 * never reflected. It is scrubbed anyway, and the message is capped, so neither a long body nor a
 * surprising one can flood the log.
 */
async function upstreamDetail(response: Response, apiKey: string): Promise<string> {
  let message = '';
  try {
    const body = (await response.json()) as { error?: { message?: unknown; status?: unknown } };
    const status = typeof body.error?.status === 'string' ? body.error.status : '';
    const text = typeof body.error?.message === 'string' ? body.error.message : '';
    message = [status, text].filter(Boolean).join(': ');
  } catch {
    // A non-JSON error body carries nothing an operator could use; the status still does.
  }
  const safe = message.replaceAll(apiKey, '[redacted]').slice(0, 300);
  return safe ? `HTTP ${response.status} — ${safe}` : `HTTP ${response.status}`;
}

/**
 * The single HTTP path to Gemini. Both capabilities go through it so the timeout, the abort
 * signal, the "never keep an upstream error body" rule and the failure classification exist once.
 */
async function generate(
  label: string,
  /** Null asks the model with no system instruction — see the provider's `ask`. */
  systemPrompt: string | null,
  userMessage: string,
  /** Null requests plain text instead of schema-constrained JSON. */
  responseSchema: unknown | null,
  maxTokens: number,
): Promise<{ ok: true; content: string } | { ok: false; reason: AiFailureReason; detail: string }> {
  const apiKey = env.geminiApiKey;
  if (!apiKey) return { ok: false, reason: 'disabled', detail: 'no API key configured' };

  const result = await withRetry(label, (attemptContext) => attemptGenerate(apiKey, attemptContext, systemPrompt, userMessage, responseSchema, maxTokens));
  return result.ok ? { ok: true, content: result.value } : result;
}

/** One HTTP attempt. The retry wrapper decides whether there is a second. */
async function attemptGenerate(
  apiKey: string,
  { timeoutMs }: AttemptContext,
  systemPrompt: string | null,
  userMessage: string,
  responseSchema: unknown | null,
  maxTokens: number,
): Promise<{ ok: true; value: string } | { ok: false; reason: AiFailureReason; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}/${encodeURIComponent(env.geminiModel)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        // Gemini carries the system prompt in its own field rather than as a message role.
        // Omitted entirely when there is none — sending an empty instruction is not the same as
        // sending no instruction, and `ask` depends on the model being genuinely unsteered.
        ...(systemPrompt === null ? {} : { systemInstruction: { parts: [{ text: systemPrompt }] } }),
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          ...(responseSchema === null
            ? { responseMimeType: 'text/plain' }
            : { responseMimeType: 'application/json', responseSchema }),
          maxOutputTokens: maxTokens,
          // Low but non-zero: consistent phrasing across runs without being robotic.
          temperature: 0.3,
        },
      }),
    });

    if (!response.ok) {
      const detail = await upstreamDetail(response, apiKey);
      return { ok: false, reason: reasonFor(response.status, detail), detail };
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };

    // A safety block returns 200 with no candidate. Reported as its own case rather than as an
    // empty completion, because the fix for it is different.
    if (payload.promptFeedback?.blockReason) {
      return { ok: false, reason: 'invalid_response', detail: `blocked: ${payload.promptFeedback.blockReason}` };
    }

    const candidate = payload.candidates?.[0];
    const content = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

    // MAX_TOKENS with an empty body is the failure mode a thinking-heavy model produces: the
    // budget is spent before any answer is written. Named explicitly so an operator sees the
    // cause instead of a mystery empty completion.
    if (!content) {
      const detail = candidate?.finishReason === 'MAX_TOKENS'
        ? 'output token budget was exhausted before any content was produced'
        : 'empty completion';
      return { ok: false, reason: 'invalid_response', detail };
    }

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

export const geminiProvider: AiProvider = {
  name: 'gemini',

  async enhance(context: RecommendationContext): Promise<AiResult> {
    const response = await generate('enhance', SYSTEM_PROMPT, buildUserMessage(context), RECOMMENDATION_SCHEMA, MAX_OUTPUT_TOKENS);
    if (!response.ok) return response;

    const parsed = parseJson(response.content);
    if (parsed === null) return { ok: false, reason: 'invalid_response', detail: 'completion was not valid JSON' };

    const recommendation: AiRecommendation | null = validateRecommendation(parsed);
    if (!recommendation) return { ok: false, reason: 'invalid_response', detail: 'completion failed validation' };

    return { ok: true, recommendation, model: env.geminiModel };
  },

  async planFix(context: FixPlanContext): Promise<AiFixResult> {
    if (context.targets.length === 0) {
      return { ok: false, reason: 'invalid_response', detail: 'no targets supplied' };
    }

    const message = buildFixMessage({
      ...context,
      targets: context.targets.map((target) => ({ ...target, sourceText: target.sourceText.slice(0, sourceTextLimit(context.targets.length)) })),
    });

    const response = await generate('planFix', FIX_SYSTEM_PROMPT, message, FIX_SCHEMA, fixOutputTokens(context.targets.length));
    if (!response.ok) return response;

    const parsed = parseJson(response.content);
    if (parsed === null) return { ok: false, reason: 'invalid_response', detail: 'completion was not valid JSON' };

    const proposals = validateProposals(parsed);
    if (!proposals) return { ok: false, reason: 'invalid_response', detail: 'completion did not contain a proposals array' };
    if (proposals.length === 0) return { ok: false, reason: 'invalid_response', detail: 'completion contained no usable proposals' };

    return { ok: true, proposals, model: env.geminiModel };
  },

  async ask(question: string): Promise<AiAskResult> {
    // No system instruction and no schema: the reply IS the measurement, so it must be what the
    // model says unprompted, returned verbatim. Steering it toward the merchant would manufacture
    // the mention being counted.
    const response = await generate('ask', null, question, null, ASK_OUTPUT_TOKENS);
    if (!response.ok) return response;

    const text = response.content.trim();
    if (!text) return { ok: false, reason: 'invalid_response', detail: 'the model returned an empty answer' };
    return { ok: true, text, model: env.geminiModel };
  },
};
