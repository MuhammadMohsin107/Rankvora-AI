import { env } from '../../config/env.js';
import type { AiFailureReason } from './provider.js';

/**
 * ─── One retry, inside a bounded total wait ──────────────────────────
 *
 * Shared by both providers so they cannot develop different patience.
 *
 * WHY A RETRY AT ALL, AND WHY ONLY ONE. Measured against the live Gemini endpoint, latency is
 * sharply bimodal: most calls answer in about 1-2 seconds, and a minority stall for 25-45 seconds
 * before returning a perfectly good answer. The stall is not caused by payload size — a 1-target
 * request stalled for 28s while a 25-target one answered in 34s — so it is upstream queueing, not
 * anything this code controls.
 *
 * That measurement is also why the retry is modest rather than eager. A short timeout with an
 * aggressive retry was tried and is WORSE: at a 6-second ceiling only 4 of 12 calls answered
 * first time, a retry rescued 2 more, and 6 failed outright — because stalls cluster, so the
 * second attempt lands in the same stall, and because a short ceiling kills the calls that would
 * have succeeded at 30 seconds. A generous per-attempt timeout is what actually raises the
 * success rate; the retry only covers the tail beyond it.
 *
 * THE TOTAL BUDGET IS THE POINT. Without it, two 45-second attempts make a merchant wait a minute
 * and a half at a spinner. The second attempt therefore runs only if enough of the budget is left
 * to be worth making — a typical answer needs a couple of seconds, so a sliver of remaining time
 * would spend the merchant's patience on a call that cannot finish.
 */

/** Failures where trying again could plausibly produce a different outcome. A revoked key, an
 * exhausted quota or a response the model malformed will not change on a second attempt, and
 * retrying them spends the merchant's time and the account's tokens for nothing. */
const RETRYABLE: ReadonlySet<AiFailureReason> = new Set<AiFailureReason>(['timeout', 'network']);

export interface AttemptContext {
  /** Milliseconds this attempt may take. Derived from what is left of the total budget. */
  timeoutMs: number;
  /** 1 for the first try, 2 for the retry. Logged, never sent upstream. */
  attempt: number;
}

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; reason: AiFailureReason; detail: string };

/**
 * Runs `attempt`, retrying once when it fails in a way a retry could fix and the budget allows.
 *
 * `label` names the capability in logs ("enhance", "planFix") so an operator reading them can see
 * which path is stalling without correlating timestamps.
 */
export async function withRetry<T>(
  label: string,
  attempt: (context: AttemptContext) => Promise<AttemptResult<T>>,
): Promise<AttemptResult<T>> {
  const startedAt = Date.now();
  const budgetMs = Math.max(env.aiTimeoutMs, env.aiTotalBudgetMs);

  const first = await attempt({ timeoutMs: Math.min(env.aiTimeoutMs, budgetMs), attempt: 1 });
  if (first.ok || !RETRYABLE.has(first.reason)) return first;

  const remaining = budgetMs - (Date.now() - startedAt);
  if (remaining < env.aiRetryMinRemainingMs) {
    console.warn(`[scorelo-ai] ${label} failed (${first.reason}) with ${Math.max(0, remaining)}ms left — not enough budget to retry`);
    return first;
  }

  console.warn(`[scorelo-ai] ${label} ${first.reason}; retrying once with ${remaining}ms left`);
  const second = await attempt({ timeoutMs: remaining, attempt: 2 });
  if (second.ok) {
    console.log(`[scorelo-ai] ${label} succeeded on retry after ${Date.now() - startedAt}ms`);
    return second;
  }

  // The FIRST reason is returned, not the second: it describes how the call actually behaved,
  // and the retry's reason is often just "ran out of what was left of the budget".
  return first;
}
