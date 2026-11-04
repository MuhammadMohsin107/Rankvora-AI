// ─── AI fix planner (npm test) ───────────────────────────────────────
// The validation layer is the security boundary of this feature: the model returns text, and
// NOTHING downstream may trust it. These tests exercise that boundary directly — the field
// allow-list, the value rules, resource-reference parsing — plus the provider's planFix contract
// with a stubbed transport, so every OpenAI outcome is covered without a live key.

import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_RULES,
  fieldForSubPillar,
  isFixableResourceType,
  parseResourceRef,
  validateProposedValue,
} from '../lib/ai/fix-policy.js';
import { openAiProvider } from '../lib/ai/openai.provider.js';
import type { FixPlanContext } from '../lib/ai/provider.js';

/**
 * Installs a key before any test runs — see the identical note in ai-recommendation.test.ts.
 *
 * The header above promises these run "without a live key". They did not: without OPENAI_API_KEY
 * in the environment, planFix returned 'disabled' before sending anything, and every assertion
 * about the request it makes failed on an empty call log.
 */
/** The key the provider will actually send — assertions compare against this, not process.env. */
let apiKey = '';

before(async () => {
  const { env } = await import('../config/env.js');
  const mutable = env as unknown as { openaiApiKey?: string; aiRecommendationsEnabled: boolean };
  mutable.openaiApiKey ||= 'sk-test-not-a-real-key';
  mutable.aiRecommendationsEnabled = true;
  apiKey = mutable.openaiApiKey;
});

// ─── Field allow-list ────────────────────────────────────────────────

describe('fix policy — the allow-list', () => {
  it('maps only the sub-pillars that have a fixable field', () => {
    assert.equal(fieldForSubPillar('title-tags')?.field, 'seo.title');
    assert.equal(fieldForSubPillar('meta-descriptions')?.field, 'seo.description');
    // Alt text is writable too, and by a different route: a template built from the product's own
    // attributes rather than a model. Asserted alongside the other two so the allow-list cannot
    // grow a third entry without this test being read.
    assert.equal(fieldForSubPillar('image-alt-text')?.field, 'image.alt');
  });

  it('generates alt text from a template, never from the model', () => {
    // The distinction is the point: `generator` decides whether planAiFixes may send this field
    // to a provider at all. Alt text is derived from attributes Rankvora AI already holds, so a model
    // call would be spend with nothing to add — and a silent flip to 'ai' would be invisible
    // without this.
    assert.equal(fieldForSubPillar('image-alt-text')?.generator, 'template');
    assert.equal(fieldForSubPillar('title-tags')?.generator, 'ai');
    assert.equal(fieldForSubPillar('meta-descriptions')?.generator, 'ai');
  });

  it('refuses sub-pillars with no fixable field, so they can never be targeted', () => {
    // Body copy, theme weight and policies are all deliberately out of reach — an unlisted field
    // is unreachable by construction rather than by a rule someone remembered. The last two
    // entries matter as much as the rest: the lookup is by SUB-PILLAR, so a field name must never
    // resolve, and neither must an empty string.
    for (const subPillar of ['product-descriptions', 'theme-weight', 'returns', 'feed', '', 'seo.title']) {
      assert.equal(fieldForSubPillar(subPillar), null, `${subPillar} must not be fixable`);
    }
  });

  it('keeps its length bounds in step with the checks that score them', () => {
    // If these drift, an "approved" value would be one the next audit flags again.
    assert.equal(FIELD_RULES['seo.title'].minLength, 30);
    assert.equal(FIELD_RULES['seo.title'].maxLength, 60);
    assert.equal(FIELD_RULES['seo.description'].minLength, 70);
    assert.equal(FIELD_RULES['seo.description'].maxLength, 160);
  });
});

// ─── Resource references ─────────────────────────────────────────────

describe('fix policy — resource references', () => {
  it('parses the `type:id` refs the audit writes into its evidence rows', () => {
    assert.deepEqual(parseResourceRef('product:9009289527573'), { resourceType: 'product', resourceId: '9009289527573' });
    assert.deepEqual(parseResourceRef('collection:12'), { resourceType: 'collection', resourceId: '12' });
    assert.deepEqual(parseResourceRef('page:7'), { resourceType: 'page', resourceId: '7' });
    assert.deepEqual(parseResourceRef('article:3'), { resourceType: 'article', resourceId: '3' });
  });

  it('rejects anything that is not an allow-listed resource type', () => {
    for (const ref of ['order:1', 'customer:1', 'shop:1', 'metafield:1', ':1', 'product:', 'product', '', 'PRODUCT:1']) {
      assert.equal(parseResourceRef(ref), null, `${ref} must not parse`);
    }
  });

  it('rejects non-string ids rather than coercing them', () => {
    for (const ref of [null, undefined, 42, {}, []]) {
      assert.equal(parseResourceRef(ref), null);
    }
  });

  it('does not treat order or customer resources as fixable', () => {
    assert.equal(isFixableResourceType('order'), false);
    assert.equal(isFixableResourceType('customer'), false);
    assert.equal(isFixableResourceType('product'), true);
  });
});

// ─── Proposed values ─────────────────────────────────────────────────

describe('fix policy — proposed values', () => {
  const titleRule = FIELD_RULES['seo.title'];
  const CURRENT = 'Shirt';
  const GOOD = 'Light Blue Organic Cotton Oxford Shirt';

  it('accepts a value inside the range and normalises its whitespace', () => {
    const result = validateProposedValue(titleRule, `  ${GOOD}   `, CURRENT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value, GOOD);
  });

  it('rejects a value that would still fail the audit', () => {
    const short = validateProposedValue(titleRule, 'Blue Shirt', CURRENT);
    assert.equal(short.ok, false);
    if (short.ok) return;
    assert.equal(short.reason, 'too_short');

    const long = validateProposedValue(titleRule, 'Light Blue Organic Cotton Oxford Shirt For Men In Regular Fit', CURRENT);
    assert.equal(long.ok, false);
    if (long.ok) return;
    assert.equal(long.reason, 'too_long');
  });

  it('rejects markup so an approved value can never carry HTML onto a storefront', () => {
    for (const value of [
      '<script>alert(1)</script> Light Blue Cotton Oxford Shirt For Men',
      'Light Blue <b>Organic</b> Cotton Oxford Shirt For Men',
      'Light Blue &amp; White Organic Cotton Oxford Shirt For Men',
    ]) {
      const result = validateProposedValue(titleRule, value, CURRENT);
      assert.equal(result.ok, false, `${value} must be rejected`);
      if (result.ok) continue;
      assert.equal(result.reason, 'contains_markup');
    }
  });

  it('rejects a multi-line value, which no meta tag can carry', () => {
    const result = validateProposedValue(titleRule, 'Light Blue Organic Cotton\nOxford Shirt For Men', CURRENT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'multiline');
  });

  it('rejects placeholder wording rather than showing it for approval', () => {
    for (const value of [
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed',
      'Light Blue Cotton Oxford Shirt | Your Brand Name Here Today',
      'Light Blue Cotton Oxford Shirt [PRODUCT NAME] For Men Today',
      'Light Blue Cotton Oxford Shirt {{ shop.name }} For Men Today',
    ]) {
      const result = validateProposedValue(titleRule, value, CURRENT);
      assert.equal(result.ok, false, `${value} must be rejected`);
      if (result.ok) continue;
      assert.equal(result.reason, 'placeholder');
    }
  });

  it('rejects a value identical to the current one — that is not a fix', () => {
    const result = validateProposedValue(titleRule, `  ${GOOD}  `, GOOD);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unchanged');
  });

  it('rejects a non-string, however the model formatted its answer', () => {
    for (const value of [null, undefined, 42, { value: GOOD }, [GOOD]]) {
      const result = validateProposedValue(titleRule, value, CURRENT);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.reason, 'not_a_string');
    }
  });

  it('applies the description rule\'s own wider bounds', () => {
    const rule = FIELD_RULES['seo.description'];
    const good = 'A light blue organic cotton oxford shirt cut for a relaxed fit, machine washable at thirty degrees and made in Portugal.';
    assert.equal(validateProposedValue(rule, good, 'Shirt').ok, true);
    assert.equal(validateProposedValue(rule, 'Too short for a description.', 'Shirt').ok, false);
  });
});

// ─── Provider contract ───────────────────────────────────────────────

const CONTEXT: FixPlanContext = {
  findingTitle: 'Product titles exceed the search snippet limit',
  problem: '18 product titles are longer than 60 characters.',
  field: 'seo.title',
  fieldLabel: 'SEO title',
  minLength: 30,
  maxLength: 60,
  guidance: 'A search-result title of 30-60 characters.',
  storeName: 'Test Store',
  targets: [
    { ref: 'product:1', resourceType: 'product', title: 'Shirt', currentValue: 'Shirt', deterministicSuggestion: null, sourceText: 'A cotton shirt.' },
    { ref: 'product:2', resourceType: 'product', title: 'Dress', currentValue: 'Dress', deterministicSuggestion: 'Dress | Test Store', sourceText: 'A purple dress.' },
  ],
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return calls;
}

function completion(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
}

const VALID_PROPOSALS = {
  proposals: [
    { ref: 'product:1', proposedValue: 'Light Blue Organic Cotton Oxford Shirt', reason: 'Added material and colour.' },
    { ref: 'product:2', proposedValue: 'Purple Long-Sleeved Midi Dress in Crepe', reason: 'Added colour and cut.' },
  ],
};

describe('openAiProvider.planFix', () => {
  it('returns one proposal per target with the model that produced them', async () => {
    stubFetch(() => completion(VALID_PROPOSALS));
    const result = await openAiProvider.planFix(CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.proposals.length, 2);
    assert.equal(result.proposals[0]?.ref, 'product:1');
    assert.ok(result.model.length > 0);
  });

  it('sends the key only in the Authorization header, never in the prompt', async () => {
    const calls = stubFetch(() => completion(VALID_PROPOSALS));
    await openAiProvider.planFix(CONTEXT);
    const { init } = calls[0];
    // The resolved config, not process.env — see the same note in ai-recommendation.test.ts.
    // With an empty key this assertion could never fail: every string contains ''.
    assert.notEqual(apiKey, '', 'a key must be configured for this assertion to mean anything');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${apiKey}`);
    assert.equal(String(init.body).includes(apiKey), false);
  });

  it('sends no store domain, token or resource URL to the model', async () => {
    const calls = stubFetch(() => completion(VALID_PROPOSALS));
    await openAiProvider.planFix(CONTEXT);
    const prompt = JSON.parse(String(calls[0].init.body)).messages.map((message: { content: string }) => message.content).join('\n');
    for (const forbidden of ['myshopify.com', 'shpat_', 'shpss_', 'password', 'access_token', 'Bearer ']) {
      assert.equal(prompt.includes(forbidden), false, `prompt must not contain ${forbidden}`);
    }
  });

  it('constrains the request with a strict schema and a bounded completion', async () => {
    const calls = stubFetch(() => completion(VALID_PROPOSALS));
    await openAiProvider.planFix(CONTEXT);
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.ok(sent.max_completion_tokens > 0 && sent.max_completion_tokens <= 2000);
    assert.ok(calls[0].init.signal, 'a hung model must not hold the request open');
  });

  it('makes no call at all when there is nothing to plan', async () => {
    const calls = stubFetch(() => completion(VALID_PROPOSALS));
    const result = await openAiProvider.planFix({ ...CONTEXT, targets: [] });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0, 'an empty batch must not be billed');
  });

  it('drops malformed entries instead of failing the whole batch', async () => {
    stubFetch(() => completion({
      proposals: [
        { ref: 'product:1', proposedValue: 'Light Blue Organic Cotton Oxford Shirt', reason: 'ok' },
        { ref: '', proposedValue: 'no ref', reason: 'x' },
        { ref: 'product:2' },
        null,
        'nonsense',
      ],
    }));
    const result = await openAiProvider.planFix(CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.proposals.length, 1);
  });

  it('reports a completion with no proposals array as invalid rather than empty success', async () => {
    stubFetch(() => completion({ suggestions: [] }));
    const result = await openAiProvider.planFix(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'invalid_response');
  });

  it('maps upstream failures to values, never throws, and keeps the key out of the result', async () => {
    for (const [status, reason] of [[401, 'auth'], [429, 'rate_limit'], [402, 'quota'], [500, 'server']] as const) {
      stubFetch(() => new Response(JSON.stringify({
        error: { message: `Incorrect API key provided: ${process.env.OPENAI_API_KEY ?? 'sk-leak'}` },
      }), { status }));
      const result = await openAiProvider.planFix(CONTEXT);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.reason, reason);
      assert.equal(result.detail, `HTTP ${status}`);
      const key = process.env.OPENAI_API_KEY;
      if (key) assert.equal(JSON.stringify(result).includes(key), false);
    }
  });

  it('returns a timeout rather than throwing when the call is aborted', async () => {
    stubFetch(() => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; });
    const result = await openAiProvider.planFix(CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'timeout');
  });

  it('is disabled, and silent, without a key', async () => {
    const { env } = await import('../config/env.js');
    const mutable = env as unknown as { openaiApiKey?: string };
    const saved = mutable.openaiApiKey;
    mutable.openaiApiKey = undefined;
    const calls = stubFetch(() => completion(VALID_PROPOSALS));
    try {
      const result = await openAiProvider.planFix(CONTEXT);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'disabled');
      assert.equal(calls.length, 0);
    } finally {
      mutable.openaiApiKey = saved;
    }
  });
});

// ─── End-to-end validation of a model response ───────────────────────

describe('a model response is filtered by the policy, not by the model', () => {
  it('accepts only the proposals that survive validation', () => {
    const rule = FIELD_RULES['seo.title'];
    const targets = new Map([
      ['product:1', 'Shirt'],
      ['product:2', 'Dress'],
      ['product:3', 'Socks'],
    ]);

    // What a real, imperfect completion looks like: one good, one too short, one for a resource
    // that was never sent, one carrying markup.
    const modelOutput = [
      { ref: 'product:1', proposedValue: 'Light Blue Organic Cotton Oxford Shirt', reason: 'ok' },
      { ref: 'product:2', proposedValue: 'Dress', reason: 'ok' },
      { ref: 'product:99', proposedValue: 'Some Other Store Product Title Goes Here', reason: 'ok' },
      { ref: 'product:3', proposedValue: '<b>Merino Wool Ribbed Crew Socks</b> Two Pack', reason: 'ok' },
    ];

    const accepted = modelOutput.filter((proposal) => {
      const current = targets.get(proposal.ref);
      if (current === undefined) return false;
      return validateProposedValue(rule, proposal.proposedValue, current).ok;
    });

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.ref, 'product:1');
  });
});
