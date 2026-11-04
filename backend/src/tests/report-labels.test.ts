import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PILLAR_ORDER, pillarLabel, pillarRank, scoreStatus, severityRank, subPillarLabel } from '../lib/report-labels.js';

describe('report labels', () => {
  it('maps pillar slugs to the wording the UI uses', () => {
    assert.equal(pillarLabel('seo'), 'SEO');
    assert.equal(pillarLabel('ai-discovery'), 'AI Discovery');
  });

  it('maps sub-pillar slugs the customer would not recognise', () => {
    assert.equal(subPillarLabel('dup-templated'), 'Copy Uniqueness');
    assert.equal(subPillarLabel('agents-md'), 'agents.md / llms.txt');
  });

  // A check added to the engine tomorrow must export as readable text, not as a raw slug and
  // not as a crash — which is the whole reason the map is allowed to be non-exhaustive.
  it('falls back to a title-cased slug for anything unmapped', () => {
    assert.equal(subPillarLabel('brand-new-check'), 'Brand new check');
    assert.equal(pillarLabel('future-pillar'), 'Future pillar');
  });
});

describe('report ordering', () => {
  it('orders pillars the way the app presents them', () => {
    const shuffled = ['cro', 'seo', 'ai-discovery', 'content', 'speed'];
    assert.deepEqual([...shuffled].sort((a, b) => pillarRank(a) - pillarRank(b)), PILLAR_ORDER);
  });

  // Sorting a varchar severity alphabetically puts 'critical' last. An issue list that opens
  // with 'low' is not a priority list.
  it('ranks severity critical-first, not alphabetically', () => {
    const shuffled = ['low', 'critical', 'medium', 'high'];
    assert.deepEqual(
      [...shuffled].sort((a, b) => severityRank(a) - severityRank(b)),
      ['critical', 'high', 'medium', 'low'],
    );
  });

  it('sorts an unknown value last rather than first', () => {
    assert.ok(severityRank('unknown') > severityRank('low'));
    assert.ok(pillarRank('unknown') > pillarRank('ai-discovery'));
  });
});

describe('score bands', () => {
  it('matches the status wording used across the app', () => {
    assert.equal(scoreStatus(90), 'Excellent');
    assert.equal(scoreStatus(89), 'Good');
    assert.equal(scoreStatus(75), 'Good');
    assert.equal(scoreStatus(74), 'Needs Work');
    assert.equal(scoreStatus(50), 'Needs Work');
    assert.equal(scoreStatus(49), 'Critical');
    assert.equal(scoreStatus(0), 'Critical');
  });
});
