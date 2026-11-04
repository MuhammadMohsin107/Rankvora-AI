import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { FREQUENCY_DAYS, isAnalysisDue } from '../services/auto-analysis.service.js';

// The scheduler's decision is pure and testable without a database: given when a store was last
// really analysed and the frequency the merchant chose, is it due again?

const NOW = new Date('2026-09-20T12:00:00Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe('auto-analysis · when a store is due', () => {
  it('waits out the full interval, then runs', () => {
    // Weekly = 7 days. Six days is not a week.
    assert.equal(isAnalysisDue(daysBefore(6), 'Weekly', NOW), false);
    assert.equal(isAnalysisDue(daysBefore(7), 'Weekly', NOW), true);
    assert.equal(isAnalysisDue(daysBefore(30), 'Weekly', NOW), true);
  });

  it('honours each frequency the merchant can actually choose', () => {
    assert.equal(isAnalysisDue(daysBefore(1), 'Daily', NOW), true);
    assert.equal(isAnalysisDue(daysBefore(0.5), 'Daily', NOW), false);
    assert.equal(isAnalysisDue(daysBefore(13), 'Fortnightly', NOW), false);
    assert.equal(isAnalysisDue(daysBefore(14), 'Fortnightly', NOW), true);
    assert.equal(isAnalysisDue(daysBefore(29), 'Monthly', NOW), false);
    assert.equal(isAnalysisDue(daysBefore(30), 'Monthly', NOW), true);
  });

  it('treats a store that has never been analysed as due now', () => {
    // It is connected and auto-analysis is on; there is no previous run to count from, and that
    // first audit is the whole reason the store was connected.
    assert.equal(isAnalysisDue(null, 'Monthly', NOW), true);
  });

  it('refuses to invent an interval for a frequency it does not know', () => {
    // Analysing on a guess would be worse than not analysing: the sweep logs and skips instead.
    assert.equal(isAnalysisDue(daysBefore(365), 'Hourly', NOW), false);
    assert.equal(isAnalysisDue(null, '', NOW), false);
  });

  it('counts from the last REAL analysis, so pressing Refresh postpones the automatic one', () => {
    // The scheduler reads audits.runAt rather than tracking its own clock, so a manual run and a
    // scheduled one cannot both fire in the same week.
    assert.equal(isAnalysisDue(daysBefore(0), 'Daily', NOW), false);
  });
});

describe('auto-analysis · frequencies stay in step with the API', () => {
  it('knows every frequency updateStoreSchema accepts', () => {
    // A value the API writes but the scheduler does not recognise would be saved happily in
    // Settings and then silently never run — the exact failure this whole feature is fixing.
    const schema = readFileSync(new URL('../schemas/store.schema.ts', import.meta.url), 'utf8');
    const match = /analysisFrequency: z\.enum\(\[([^\]]+)\]\)/.exec(schema);
    assert.ok(match, 'analysisFrequency is no longer a z.enum — update this test');

    const accepted = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    assert.ok(accepted.length > 0, 'no frequencies parsed out of the schema');
    for (const frequency of accepted) {
      assert.ok(
        FREQUENCY_DAYS[frequency],
        `the API accepts "${frequency}" but the scheduler has no interval for it`,
      );
    }
  });
});
