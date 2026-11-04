// ─── What Rankvora AI may WRITE, and how settings paths reach it ────────
//
// Two bugs found on staging, both of which let the UI promise something the backend cannot do.
//
// 1. Every non-SEO sub-pillar page offered "Generate fixes" on its evidence rows, because the
//    generic page hardcoded supportsBulkFix: true. On Catalog / Feed Readiness that meant a
//    merchant could select 73 products and reach a dialog offering to write a GTIN — a
//    manufacturer's identifier that cannot be derived from a product, and which a model asked to
//    produce would invent. The empty dialog was the safe outcome; the button should not exist.
//
// 2. Page settings were requested as one percent-encoded segment (ai-discovery%2Ffeed). Express
//    handles that correctly, but the edge proxy normalises %2F back to a real slash, so the
//    request arrived as two segments, matched no route, and 404'd on every generic sub-pillar.
//
// These tests pin both: the write allow-list is the single source of truth for what the UI may
// offer, and both path shapes resolve to the same stored slug.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELD_RULES, fieldForSubPillar } from '../lib/ai/fix-policy.js';
import { pageSettingsPathSchema, pageSettingsSlugSchema } from '../schemas/pageSettings.schema.js';

/** Exactly what the /audits/capabilities controller derives. Kept in step by this test. */
const fixableSubPillars = Object.values(FIELD_RULES).map((rule) => rule.subPillar);

describe('write allow-list', () => {
  it('covers only the three fields the fix engine can actually write', () => {
    assert.deepEqual(Object.keys(FIELD_RULES).sort(), ['image.alt', 'seo.description', 'seo.title']);
  });

  it('does not claim catalogue sub-pillars are fixable', () => {
    // A GTIN, a SKU, a price and a stock level are all facts about the physical product or the
    // merchant's business. None can be derived from what Rankvora AI reads, so none may be offered.
    for (const subPillar of ['feed', 'agentic-attrs', 'answerable-qa', 'indexnow', 'prompt-tracking', 'indexing-freshness']) {
      assert.equal(fieldForSubPillar(subPillar), null, `${subPillar} must not be fixable`);
      assert.ok(!fixableSubPillars.includes(subPillar), `${subPillar} must not be advertised as fixable`);
    }
  });

  it('still advertises the sub-pillars that genuinely are fixable', () => {
    for (const subPillar of ['title-tags', 'meta-descriptions', 'image-alt-text']) {
      assert.ok(fieldForSubPillar(subPillar), `${subPillar} should have a writable field`);
      assert.ok(fixableSubPillars.includes(subPillar), `${subPillar} should be advertised as fixable`);
    }
  });

  it('advertises every rule, so adding a writable field enables its UI automatically', () => {
    assert.equal(fixableSubPillars.length, Object.keys(FIELD_RULES).length);
  });
});

describe('page-settings path shapes', () => {
  /** Mirrors slugFrom() in the controller. */
  const slugFrom = (params: { pillar?: string; subPillar?: string; slug?: string }) =>
    params.pillar && params.subPillar ? `${params.pillar}/${params.subPillar}` : String(params.slug);

  it('joins the two-segment form back into the stored slug', () => {
    const parsed = pageSettingsPathSchema.parse({ pillar: 'ai-discovery', subPillar: 'feed' });
    assert.equal(slugFrom(parsed), 'ai-discovery/feed');
  });

  it('leaves the single-segment SEO form alone', () => {
    const parsed = pageSettingsSlugSchema.parse({ slug: 'title-tags' });
    assert.equal(slugFrom(parsed), 'title-tags');
  });

  it('resolves every new AI Discovery sub-pillar to its stored slug', () => {
    for (const subPillar of ['indexnow', 'indexing-freshness', 'prompt-tracking', 'answerable-qa']) {
      const parsed = pageSettingsPathSchema.parse({ pillar: 'ai-discovery', subPillar });
      assert.equal(slugFrom(parsed), `ai-discovery/${subPillar}`);
    }
  });

  it('refuses a segment that is not a slug', () => {
    // The joined value becomes a database key, so the path stops being arbitrary input here.
    assert.throws(() => pageSettingsPathSchema.parse({ pillar: '../../etc', subPillar: 'passwd' }));
    assert.throws(() => pageSettingsPathSchema.parse({ pillar: 'ai-discovery', subPillar: 'a/b' }));
    assert.throws(() => pageSettingsPathSchema.parse({ pillar: '', subPillar: 'feed' }));
  });
});
