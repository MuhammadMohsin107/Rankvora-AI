import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreOverall, scorePillar, scoreSubPillar, worstSeverity } from '../audit-engine/scoring.js';
import { unavailableResult, type SubPillarFindingResult, type SubPillarResult } from '../audit-engine/types.js';

function finding(severity: SubPillarFindingResult['severity']): SubPillarFindingResult {
  return {
    title: 't',
    severity,
    affectedCount: 1,
    affectedLabel: 'items',
    scoreLift: 1,
    problem: 'p',
    why: 'w',
    recommendation: 'r',
    evidence: [],
    details: { issueType: 'x' },
  };
}

function ok(subPillar: string, score: number): SubPillarResult {
  return {
    subPillar,
    status: 'ok',
    score,
    analyzedCount: 10,
    healthyCount: 10,
    details: { status: 'ok', summary: '', healthChip: '', contextLabel: '', contextValue: '', evidenceRows: [] },
    findings: [],
  };
}

describe('scoreSubPillar', () => {
  it('is the healthy ratio when no findings cap it', () => {
    assert.equal(scoreSubPillar(10, 10, []), 100);
    assert.equal(scoreSubPillar(10, 5, []), 50);
    assert.equal(scoreSubPillar(3, 1, []), 33);
  });

  it('treats "nothing to analyze" as a pass, not a zero', () => {
    assert.equal(scoreSubPillar(0, 0, []), 100);
  });

  it('caps the score by the worst finding severity', () => {
    // 100% healthy ratio must not hide a critical defect.
    assert.equal(scoreSubPillar(10, 10, [finding('critical')]), 60);
    assert.equal(scoreSubPillar(10, 10, [finding('high')]), 80);
    assert.equal(scoreSubPillar(10, 10, [finding('medium')]), 95);
    assert.equal(scoreSubPillar(10, 10, [finding('low')]), 100);
  });

  it('uses the worst severity present, not the first', () => {
    assert.equal(scoreSubPillar(10, 10, [finding('low'), finding('critical'), finding('medium')]), 60);
  });

  it('never exceeds the measured ratio just because the cap is higher', () => {
    assert.equal(scoreSubPillar(10, 2, [finding('low')]), 20);
  });

  it('stays bounded on nonsensical inputs', () => {
    assert.equal(scoreSubPillar(10, 999, []), 100);
    assert.equal(scoreSubPillar(10, -5, []), 0);
  });

  it('is deterministic across repeated calls', () => {
    const runs = Array.from({ length: 5 }, () => scoreSubPillar(7, 3, [finding('high')]));
    assert.deepEqual(new Set(runs).size, 1);
  });
});

describe('worstSeverity', () => {
  it('returns null when there are no findings', () => {
    assert.equal(worstSeverity([]), null);
  });

  it('orders critical above high above medium above low', () => {
    assert.equal(worstSeverity([finding('medium'), finding('high')]), 'high');
    assert.equal(worstSeverity([finding('low')]), 'low');
  });
});

describe('scorePillar', () => {
  it('averages measured sub-pillars', () => {
    assert.equal(scorePillar([ok('a', 80), ok('b', 60)]), 70);
  });

  it('EXCLUDES unavailable sub-pillars instead of scoring them as zero', () => {
    const results = [ok('a', 80), unavailableResult('b', 'no data')];
    // Averaging in a zero would report 40 and invent a bad score out of missing data.
    assert.equal(scorePillar(results), 80);
  });

  it('returns null when nothing in the pillar was measurable', () => {
    assert.equal(scorePillar([unavailableResult('a', 'no data')]), null);
    assert.equal(scorePillar([]), null);
  });
});

describe('scoreOverall', () => {
  it('averages measured pillar scores', () => {
    assert.equal(scoreOverall([90, 70]), 80);
  });

  it('ignores unavailable pillars rather than counting them as zero', () => {
    assert.equal(scoreOverall([90, null]), 90);
  });

  it('returns null when no pillar was measurable', () => {
    assert.equal(scoreOverall([null, null]), null);
    assert.equal(scoreOverall([]), null);
  });
});

describe('unavailableResult', () => {
  it('is distinguishable from a genuine score and carries a reason', () => {
    const result = unavailableResult('title-tags', 'Shopify products could not be read');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.details.status, 'unavailable');
    assert.equal(result.details.unavailableReason, 'Shopify products could not be read');
    assert.equal(result.analyzedCount, 0);
    assert.deepEqual(result.findings, []);
  });
});
