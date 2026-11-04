import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toResourceContent } from '../services/fix-content.service.js';
import { aiFixStatus } from '../services/ai-fix.service.js';
import { FIELD_RULES, isLengthRejection, titleFieldRule, validateProposedValue } from '../lib/ai/fix-policy.js';
import { FIX_SYSTEM_PROMPT, SINGLE_SOURCE_TEXT_LIMIT, SOURCE_TEXT_LIMIT, aimWindow, buildFixMessage, sourceTextLimit } from '../lib/ai/prompt.js';
import { planAiFixesSchema } from '../schemas/finding.schema.js';
import type { FixPlanContext } from '../lib/ai/provider.js';

/**
 * ─── Writing a fix for ONE item, from what the item actually says ────
 *
 * The Investigate view drafts a replacement value for the item the merchant opened, through the
 * same planner and the same apply path as the bulk fix. What is pinned here is what changed for it:
 * the item's own content read from the store is turned into what the model is given — and nothing
 * Shopify did not hold is ever added — plus the request contract and the field bounds the editor
 * shows. The model itself is not called; its output is judged by fix-policy, tested elsewhere.
 */

describe('an item\'s own content, as the fix writer is given it', () => {
  it('turns a product into its name, its copy as plain text and its catalogue facts', () => {
    const content = toResourceContent({
      __typename: 'Product',
      id: 'gid://shopify/Product/1',
      title: '  Biotin Hair Strengthening Duo ',
      descriptionHtml: '<p>Biotin capsules &amp; shampoo.</p><ul><li>60 capsules</li></ul>',
      productType: 'Supplements',
      vendor: 'Herbiotics',
      tags: ['hair', ' biotin '],
    });
    assert.equal(content.title, 'Biotin Hair Strengthening Duo');
    assert.equal(content.text, 'Biotin capsules & shampoo. 60 capsules');
    assert.deepEqual(content.facts, ['Product type: Supplements', 'Brand/vendor: Herbiotics', 'Tags: hair, biotin']);
  });

  it('states no fact Shopify did not hold — an empty type or vendor is left out, not filled in', () => {
    const content = toResourceContent({ __typename: 'Product', id: 'gid://shopify/Product/2', title: 'Plain', descriptionHtml: '', productType: '', vendor: null, tags: [] });
    assert.deepEqual(content.facts, []);
    assert.equal(content.text, '');
  });

  it('reads a page or an article from its body, with the article\'s blog', () => {
    const page = toResourceContent({ __typename: 'Page', id: 'gid://shopify/Page/3', title: 'About us', body: '<h2>Our story</h2><p>Since 2019.</p>' });
    assert.equal(page.text, 'Our story Since 2019.');
    const article = toResourceContent({ __typename: 'Article', id: 'gid://shopify/Article/4', title: 'Hair care', body: '<p>Tips</p>', blog: { title: 'News' } });
    assert.deepEqual(article.facts, ['Blog: News']);
  });
});

describe('what the model is told', () => {
  const context: FixPlanContext = {
    findingTitle: 'Pages with no meta description',
    problem: '97 pages have no meta description set in Shopify.',
    field: 'seo.description',
    fieldLabel: 'SEO meta description',
    minLength: 70,
    maxLength: 160,
    guidance: 'A search-result description of 70-160 characters.',
    storeName: 'My Nutrition Store',
    targets: [{ ref: 'product:1', resourceType: 'product', title: 'Biotin Duo', currentValue: '', deterministicSuggestion: null, sourceText: 'Biotin capsules and shampoo.', facts: ['Product type: Supplements'] }],
  };

  it('carries the item\'s catalogue facts beside its copy', () => {
    const message = buildFixMessage(context);
    assert.match(message, /its catalogue facts: Product type: Supplements/);
    assert.match(message, /its own copy to draw from: Biotin capsules and shampoo\./);
  });

  it('says nothing about facts when none were read', () => {
    const message = buildFixMessage({ ...context, targets: [{ ...context.targets[0], facts: undefined }] });
    assert.doesNotMatch(message, /catalogue facts/);
  });

  it('asks for the item\'s own meaning kept, and forbids keyword stuffing and generic copy', () => {
    assert.match(FIX_SYSTEM_PROMPT, /Keep the meaning/);
    assert.match(FIX_SYSTEM_PROMPT, /No keyword stuffing/);
    assert.match(FIX_SYSTEM_PROMPT, /No generic copy/);
  });

  it('gives one item more of its copy than a batch gives each of fifteen', () => {
    assert.equal(sourceTextLimit(1), SINGLE_SOURCE_TEXT_LIMIT);
    assert.equal(sourceTextLimit(2), SOURCE_TEXT_LIMIT);
    assert.ok(SINGLE_SOURCE_TEXT_LIMIT > SOURCE_TEXT_LIMIT);
  });
});

describe('the drafting request', () => {
  const accepts = (ref: string) => planAiFixesSchema.safeParse({ resourceIds: [ref] }).success;

  it('accepts a page-like ref and one product image', () => {
    assert.equal(accepts('product:123'), true);
    assert.equal(accepts('productImage:123/456'), true, 'alt-text drafting was refused at the edge before');
  });

  it('refuses anything that is not a ref the audit writes', () => {
    assert.equal(accepts('productImage:abc/456'), false);
    assert.equal(accepts('productImage:1/2/3'), false);
    assert.equal(accepts('product:1;drop'), false);
    assert.equal(accepts('https://shop.example/products/a'), false);
  });
});

describe('the field bounds an editor shows', () => {
  it('are the bounds the server validates against, one per fixable field', () => {
    const { fields } = aiFixStatus();
    assert.equal(fields.length, Object.keys(FIELD_RULES).length);
    for (const field of fields) {
      const rule = FIELD_RULES[field.field];
      assert.equal(field.subPillar, rule.subPillar);
      assert.equal(field.minLength, rule.minLength);
      assert.equal(field.maxLength, rule.maxLength);
      assert.equal(field.generator, rule.generator);
    }
  });
});

describe('the title field\'s range, behind a theme suffix', () => {
  const titleRule = FIELD_RULES['seo.title'];

  it('moves BOTH ends with the suffix, as the check scores the rendered title', () => {
    // A 30-character suffix: the audit passes any field of 1-30 characters (rendered 31-60), so the
    // field is written 10-30 — not 30-30, the one-value window that refused a 27-character title.
    const rule = titleFieldRule(titleRule, 30);
    assert.equal(rule.minLength, 10);
    assert.equal(rule.maxLength, 30);
    assert.equal(validateProposedValue(rule, 'Summer Hydration Benefits', 'Summer Hydration Benefits Guide').ok, true);
  });

  it('keeps the plain range with no suffix, and a short suffix only narrows it', () => {
    assert.deepEqual([titleFieldRule(titleRule, 0).minLength, titleFieldRule(titleRule, 0).maxLength], [30, 60]);
    const rule = titleFieldRule(titleRule, 12);
    assert.deepEqual([rule.minLength, rule.maxLength], [18, 48]);
  });

  it('tells the model the field\'s range, not the rendered one, and not to repeat the store name', () => {
    const rule = titleFieldRule(titleRule, 30);
    assert.match(rule.guidance, /10-30 characters/);
    assert.match(rule.guidance, /do not repeat the store name/);
    assert.doesNotMatch(rule.guidance, /30-60/);
  });

  it('never narrows to one length: a suffix that leaves less room than the floor gets the audit’s own range', () => {
    // A 54-character suffix leaves 6 characters; the rule asks for 3-6 — a real range, not 6-6.
    for (const suffix of [50, 54, 59]) {
      const rule = titleFieldRule(titleRule, suffix);
      assert.equal(rule.maxLength, 60 - suffix);
      assert.ok(rule.minLength < rule.maxLength || rule.maxLength === 1, `suffix ${suffix}: ${rule.minLength}-${rule.maxLength}`);
    }
    assert.deepEqual([titleFieldRule(titleRule, 54).minLength, titleFieldRule(titleRule, 54).maxLength], [3, 6]);
    assert.deepEqual([titleFieldRule(titleRule, 50).minLength, titleFieldRule(titleRule, 50).maxLength], [5, 10]);
    assert.deepEqual([titleFieldRule(titleRule, 27).minLength, titleFieldRule(titleRule, 27).maxLength], [10, 33]);
  });

  it('leaves the rule alone for a field that is not a title', () => {
    assert.equal(titleFieldRule(FIELD_RULES['seo.description'], 30), FIELD_RULES['seo.description']);
  });
});

describe('a draft that misses only on length', () => {
  const description = FIELD_RULES['seo.description'];

  it('is told apart from every other rejection — only length is retried', () => {
    assert.equal(isLengthRejection(validateProposedValue(description, 'x'.repeat(167), '')), true);
    assert.equal(isLengthRejection(validateProposedValue(description, 'short', '')), true);
    assert.equal(isLengthRejection(validateProposedValue(description, `<b>${'y'.repeat(100)}</b>`, '')), false);
    assert.equal(isLengthRejection(validateProposedValue(description, 'z'.repeat(100), 'z'.repeat(100))), false);
  });

  it('asks the model to aim inside the range, with room either side', () => {
    assert.deepEqual(aimWindow(70, 160), { from: 106, to: 151 });
    assert.deepEqual(aimWindow(10, 30), { from: 18, to: 28 });
    assert.deepEqual(aimWindow(30, 30), { from: 30, to: 30 });
  });

  it('sends the rejected value back once, with how far off it was', () => {
    const message = buildFixMessage({
      findingTitle: 'Pages with no meta description', problem: null, field: 'seo.description', fieldLabel: 'SEO meta description',
      minLength: 70, maxLength: 160, guidance: 'A description.', storeName: null,
      targets: [{ ref: 'article:5', resourceType: 'article', title: 'Summer hydration', currentValue: '', deterministicSuggestion: null, sourceText: 'Stay hydrated.',
        previousAttempt: { value: 'A value that ran long', problem: 'SEO meta description is 167 characters, over the 160 limit' } }],
    });
    assert.match(message, /REJECTED \(SEO meta description is 167 characters, over the 160 limit\): A value that ran long/);
    assert.match(message, /Aim for 106-151 characters/);
  });
});
