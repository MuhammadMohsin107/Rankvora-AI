// ─── AI recommendation layer (npm test) ──────────────────────────────
// Covers the provider in isolation with a stubbed fetch, so every OpenAI outcome — success,
// auth failure, rate limit, quota, server error, malformed body, timeout, no key — is exercised
// deterministically without spending money or depending on a live key.
//
// The contract under test is the one the whole feature rests on: a provider NEVER throws, always
// returns a value, and never lets the API key reach a log, an error message, or a return value.

import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { openAiProvider } from '../lib/ai/openai.provider.js';
import type { RecommendationContext } from '../lib/ai/provider.js';

/**
 * Installs a key before any test runs, because the provider refuses to call out without one.
 *
 * These tests inherited whatever the developer's .env held, and stopped testing anything the
 * moment it held no OPENAI_API_KEY — which is the case on any machine configured for a different
 * provider. Every assertion about headers, prompts, schemas and failure mapping then fell through
 * the "no key" guard and failed on an empty call log, reporting a broken provider on a provider
 * nobody had exercised. The header above promises these run "without depending on a live key";
 * this is what makes that true.
 *
 * Nothing reaches OpenAI: fetch is replaced in every test below, and this value is not a key.
 * A real key already present is left alone, so such a machine exercises the identical paths.
 */
/** The key the provider will actually send, captured so assertions compare against the same
 * value it reads rather than against process.env — which it has never read. */
let apiKey = '';

before(async () => {
  const { env } = await import('../config/env.js');
  const mutable = env as unknown as { openaiApiKey?: string; aiRecommendationsEnabled: boolean };
  mutable.openaiApiKey ||= 'sk-test-not-a-real-key';
  mutable.aiRecommendationsEnabled = true;
  apiKey = mutable.openaiApiKey;
});

const CONTEXT: RecommendationContext = {
  pillar: 'SEO',
  subPillar: 'Meta & Titles',
  findingTitle: 'Product titles exceed the search snippet limit',
  severity: 'medium',
  problem: '18 product titles are longer than 60 characters.',
  why: 'Long titles are truncated in search results, hiding the differentiating words.',
  deterministicRecommendation: 'Shorten product titles to 60 characters or fewer.',
  affectedCount: 18,
  affectedLabel: 'products',
  evidence: ['18 of 42 titles over 60 characters', 'longest title: 94 characters'],
  storeName: 'Test Store',
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replaces fetch and records what the provider actually sent. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function completion(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID = {
  recommendation: 'Trim the 18 long product titles to 60 characters, keeping the product name first.',
  whyItMatters: 'Truncated titles hide the words that make a listing worth clicking.',
  suggestedAction: 'Start with the longest title and rewrite it front-loaded with the product name.',
  confidence: 'high' as const,
};

describe('openAiProvider.enhance — success path', () => {
  it('returns the validated recommendation and the model that produced it', async () => {
    stubFetch(() => completion(VALID));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.recommendation.recommendation, VALID.recommendation);
    assert.equal(result.recommendation.confidence, 'high');
    assert.ok(result.model.length > 0);
  });

  it('sends the key only in the Authorization header, and never in the request body', async () => {
    const calls = stubFetch(() => completion(VALID));
    await openAiProvider.enhance(CONTEXT);
    assert.equal(calls.length, 1);

    const { url, init } = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');

    const headers = init.headers as Record<string, string>;
    // Read from the resolved config, which is what the provider sends. This used to read
    // process.env.OPENAI_API_KEY — a value the provider never touches — so on a machine without
    // that variable `key` was '', the header comparison failed, and `body.includes('')` was
    // trivially true: the assertion that no key leaks into the body could not fail.
    assert.notEqual(apiKey, '', 'a key must be configured for this assertion to mean anything');
    assert.equal(headers.Authorization, `Bearer ${apiKey}`);
    // The body carries audit context only — a key echoed into it would be logged by any proxy.
    assert.equal(String(init.body).includes(apiKey), false);
  });

  it('sends audit context only — no credentials, tokens, domains or customer data', async () => {
    const calls = stubFetch(() => completion(VALID));
    await openAiProvider.enhance(CONTEXT);
    const sent = JSON.parse(String(calls[0].init.body));
    const prompt: string = sent.messages.map((m: { content: string }) => m.content).join('\n');

    for (const forbidden of ['password', 'accessToken', 'access_token', 'shpat_', 'shpss_', 'myshopify.com', 'Bearer ']) {
      assert.equal(prompt.includes(forbidden), false, `prompt must not contain ${forbidden}`);
    }
    assert.ok(prompt.includes(CONTEXT.deterministicRecommendation));
  });

  it('bounds the response so a single call cannot run away in cost', async () => {
    const calls = stubFetch(() => completion(VALID));
    await openAiProvider.enhance(CONTEXT);
    const sent = JSON.parse(String(calls[0].init.body));
    assert.ok(sent.max_completion_tokens > 0 && sent.max_completion_tokens <= 1000);
    assert.equal(sent.response_format.json_schema.strict, true);
  });
});

describe('openAiProvider.enhance — the model is not a trust boundary', () => {
  it('strips markup so AI text can never inject HTML or script into the UI', async () => {
    stubFetch(() => completion({
      ...VALID,
      recommendation: 'Shorten titles <script>alert(1)</script> to 60 chars <img src=x onerror=alert(1)>',
    }));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const text = result.recommendation.recommendation;
    // The security property is that nothing renderable as markup survives; the leftover words are
    // inert text, and the UI renders this through React as a text node regardless.
    assert.equal(/<[^>]*>/.test(text), false, 'no tags may survive sanitization');
    assert.equal(text.includes('<script'), false);
    assert.equal(text.includes('onerror='), false);
  });

  it('rejects a completion missing a required field rather than returning a half-answer', async () => {
    stubFetch(() => completion({ recommendation: 'Do the thing', confidence: 'high' }));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'invalid_response');
  });

  it('rejects an out-of-enum confidence value', async () => {
    stubFetch(() => completion({ ...VALID, confidence: 'extremely-high' }));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
  });

  it('rejects a completion that is not valid JSON', async () => {
    stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 }));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'invalid_response');
  });

  it('rejects an empty completion', async () => {
    stubFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
  });
});

describe('openAiProvider.enhance — every failure is a value, never a throw', () => {
  const statuses: Array<[number, string]> = [
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [402, 'quota'],
    [500, 'server'],
    [503, 'server'],
  ];

  for (const [status, reason] of statuses) {
    it(`maps HTTP ${status} to "${reason}" without leaking the upstream body`, async () => {
      stubFetch(() => new Response(JSON.stringify({
        error: { message: `Incorrect API key provided: ${process.env.OPENAI_API_KEY ?? 'sk-leak'}` },
      }), { status }));

      const result = await openAiProvider.enhance(CONTEXT);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, reason);
      // The upstream error echoed the key back; none of it may survive into our result.
      assert.equal(result.detail, `HTTP ${status}`);
      assert.equal(result.detail.includes('sk-'), false);
      const key = process.env.OPENAI_API_KEY;
      if (key) assert.equal(JSON.stringify(result).includes(key), false);
    });
  }

  it('returns a network failure instead of throwing when the request rejects', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED api.openai.com'); });
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'network');
    assert.equal(result.detail, 'request failed');
  });

  it('returns a timeout when the call is aborted', async () => {
    stubFetch(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    const result = await openAiProvider.enhance(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'timeout');
  });

  it('passes an abort signal so a hung model can never hold the request open', async () => {
    const calls = stubFetch(() => completion(VALID));
    await openAiProvider.enhance(CONTEXT);
    assert.ok(calls[0].init.signal, 'fetch must receive an AbortSignal');
  });
});

describe('openAiProvider.enhance — disabled without a key', () => {
  it('makes no network call at all when no key is configured', async () => {
    // env reads process.env once at import, so the key is cleared on the resolved config object
    // rather than on process.env — this is exactly the value the provider reads at call time.
    const { env } = await import('../config/env.js');
    const mutable = env as unknown as { openaiApiKey?: string };
    const saved = mutable.openaiApiKey;
    mutable.openaiApiKey = undefined;

    const calls = stubFetch(() => completion(VALID));
    try {
      const result = await openAiProvider.enhance(CONTEXT);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'disabled');
      assert.equal(calls.length, 0, 'no provider call may be made without a key');
    } finally {
      mutable.openaiApiKey = saved;
    }
  });

  it('aiConfigured() is false when the feature flag is off even with a key present', async () => {
    const { env, aiConfigured } = await import('../config/env.js');
    const mutable = env as unknown as { aiProvider: string; openaiApiKey?: string; aiRecommendationsEnabled: boolean };
    const savedProvider = mutable.aiProvider;
    const savedKey = mutable.openaiApiKey;
    const savedFlag = mutable.aiRecommendationsEnabled;
    try {
      // aiConfigured() reads the SELECTED provider's key, so the provider is pinned rather than
      // inherited from whichever one .env chose. Without this the final assertion asked "is it
      // unconfigured with no OpenAI key?" on a machine running Gemini — where the Gemini key was
      // still present and the answer was, correctly, no.
      mutable.aiProvider = 'openai';
      mutable.openaiApiKey = 'sk-test-not-a-real-key';
      mutable.aiRecommendationsEnabled = false;
      assert.equal(aiConfigured(), false, 'the flag must override a present key');

      mutable.aiRecommendationsEnabled = true;
      assert.equal(aiConfigured(), true);

      mutable.openaiApiKey = undefined;
      assert.equal(aiConfigured(), false, 'no key means not configured');
    } finally {
      mutable.aiProvider = savedProvider;
      mutable.openaiApiKey = savedKey;
      mutable.aiRecommendationsEnabled = savedFlag;
    }
  });
});
