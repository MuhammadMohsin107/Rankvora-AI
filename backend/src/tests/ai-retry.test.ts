import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { withRetry, type AttemptContext, type AttemptResult } from '../lib/ai/retry.js';

// The retry has to be right about WHEN it retries, not just that it can. Retrying a revoked key
// spends the merchant's wait on a call that cannot succeed; not retrying a timeout wastes the one
// case that can. Both directions are asserted.

let budget = 0;
let perAttempt = 0;
let minRemaining = 0;

before(async () => {
  const { env } = await import('../config/env.js');
  const mutable = env as unknown as { aiTimeoutMs: number; aiTotalBudgetMs: number; aiRetryMinRemainingMs: number };
  // Pinned rather than inherited: the defaults are operator settings and a machine that changed
  // them would quietly stop testing the behaviour these assertions describe.
  mutable.aiTimeoutMs = 200;
  mutable.aiTotalBudgetMs = 500;
  mutable.aiRetryMinRemainingMs = 50;
  perAttempt = mutable.aiTimeoutMs;
  budget = mutable.aiTotalBudgetMs;
  minRemaining = mutable.aiRetryMinRemainingMs;
});

const fail = (reason: string): AttemptResult<string> => ({ ok: false, reason: reason as never, detail: reason });

describe('ai retry · when it tries again', () => {
  it('retries a timeout and returns the answer the second attempt produced', async () => {
    const seen: number[] = [];
    const result = await withRetry('test', async ({ attempt }) => {
      seen.push(attempt);
      return attempt === 1 ? fail('timeout') : { ok: true, value: 'rescued' };
    });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(result.ok && result.value, 'rescued');
  });

  it('retries a network failure', async () => {
    let attempts = 0;
    const result = await withRetry('test', async () => {
      attempts += 1;
      return attempts === 1 ? fail('network') : { ok: true, value: 'ok' };
    });
    assert.equal(attempts, 2);
    assert.equal(result.ok, true);
  });

  it('does not retry a failure a second call cannot fix', async () => {
    // A revoked key, an exhausted quota and a malformed completion are the same on any attempt.
    for (const reason of ['auth', 'rate_limit', 'quota', 'invalid_response', 'disabled', 'server']) {
      let attempts = 0;
      const result = await withRetry('test', async () => { attempts += 1; return fail(reason); });
      assert.equal(attempts, 1, `${reason} must not be retried`);
      assert.equal(result.ok, false);
    }
  });

  it('never makes a third attempt', async () => {
    let attempts = 0;
    await withRetry('test', async () => { attempts += 1; return fail('timeout'); });
    assert.equal(attempts, 2);
  });
});

describe('ai retry · the wait stays bounded', () => {
  it('gives the first attempt the per-attempt timeout, not the whole budget', async () => {
    let firstTimeout = 0;
    await withRetry('test', async ({ timeoutMs, attempt }) => {
      if (attempt === 1) firstTimeout = timeoutMs;
      return { ok: true, value: 'x' };
    });
    assert.equal(firstTimeout, perAttempt);
  });

  it('gives the retry only what is left of the budget', async () => {
    // Without this the merchant waits two full timeouts at a spinner.
    let retryTimeout = 0;
    await withRetry('test', async ({ timeoutMs, attempt }: AttemptContext) => {
      if (attempt === 2) { retryTimeout = timeoutMs; return { ok: true, value: 'x' }; }
      await new Promise((resolve) => setTimeout(resolve, perAttempt));
      return fail('timeout');
    });
    assert.ok(retryTimeout > 0, 'the retry must have run');
    assert.ok(retryTimeout <= budget - perAttempt + 20, `retry got ${retryTimeout}ms, which exceeds what the budget had left`);
  });

  it('skips the retry when too little budget remains to be worth it', async () => {
    let attempts = 0;
    await withRetry('test', async () => {
      attempts += 1;
      // Burn nearly the whole budget on the first attempt.
      await new Promise((resolve) => setTimeout(resolve, budget - minRemaining + 30));
      return fail('timeout');
    });
    assert.equal(attempts, 1, 'a retry with no time to finish is worse than none');
  });

  it('reports the first failure, not the retry\'s', async () => {
    // The retry's reason is usually "ran out of what was left", which describes the budget rather
    // than how the call behaved.
    const result = await withRetry('test', async ({ attempt }) => fail(attempt === 1 ? 'timeout' : 'network'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
  });
});
