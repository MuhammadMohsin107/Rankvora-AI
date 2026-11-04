import type { NextFunction, Request, Response } from 'express';
import { describeError } from '../lib/logger.js';
import { ApiError } from './error.js';

/**
 * ─── Fixed-window rate limiter ───────────────────────────────────────
 * Small, dependency-free. It guards the few routes an anonymous caller can reach — the Shopify
 * sign-in start/complete calls and the embedded app's open call — which can each end in a request
 * to Shopify.
 *
 * WHAT THIS IS FOR: raising the cost of hammering those endpoints. It is not a DDoS defence — that
 * belongs at the edge.
 *
 * WHERE THE COUNTS LIVE depends on where the API runs:
 *
 *   Node (server.ts)          In this process's memory, one table per limiter, exactly as before.
 *                             They reset on restart and are not shared across processes — fine for
 *                             the single pm2 process this has always run as.
 *   Cloudflare (worker.ts)    In a shared store (a Durable Object per limiter and key), installed with
 *                             useSharedRateLimitStore(). Workers run as many copies at once, each
 *                             with its own memory, so in-memory counts would let a caller multiply
 *                             their allowance just by landing on different copies.
 *
 * Every limiter has a NAME so the shared store can keep two limiters' counts apart: the same IP has
 * one allowance for sending sign-in codes and another for verifying them.
 */

interface Bucket {
  count: number;
  /** Epoch ms at which this window ends and the count resets. */
  resetAt: number;
}

/** A counter shared by every copy of the API — see useSharedRateLimitStore. */
export interface SharedRateLimitStore {
  /** Counts one request for `key` under limiter `name`, and returns the window's running total. */
  hit(name: string, key: string, windowMs: number): Promise<Bucket>;
}

let sharedStore: SharedRateLimitStore | null = null;

/** Moves every limiter's counts to a shared store. Called by worker.ts; Node never calls it. */
export function useSharedRateLimitStore(store: SharedRateLimitStore | null): void {
  sharedStore = store;
}

export interface RateLimitOptions {
  /**
   * Identifies this limiter in the shared store, e.g. 'auth:shopify-start'. Unique per limiter; two
   * routes that use the same limiter object share its name and its counts on purpose.
   */
  name: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Requests permitted per key per window. */
  max: number;
  /**
   * Groups requests. Defaults to client IP.
   */
  keyFor?: (req: Request) => string;
  message?: string;
}

/** Sweeping on write keeps this O(1) amortised with no timer holding the process open. */
const SWEEP_EVERY = 500;

export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let writes = 0;

  const keyFor = options.keyFor ?? ((req: Request) => req.ip ?? 'unknown');
  const message = options.message ?? 'Too many requests. Please wait a moment and try again.';

  /** In this process's memory — what Node has always done. Synchronous on purpose. */
  function countInMemory(key: string, now: number): Bucket {
    if (++writes % SWEEP_EVERY === 0) {
      for (const [existing, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(existing);
    }

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + options.windowMs };
      buckets.set(key, fresh);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = keyFor(req);

    const decide = (bucket: Bucket) => {
      if (bucket.count > options.max) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        // 429 with a generic message. It deliberately does not say WHICH limit was hit.
        return next(new ApiError(429, message, 'RATE_LIMITED'));
      }
      return next();
    };

    if (!sharedStore) return decide(countInMemory(key, now));

    // Shared store unreachable: let the request through and say so loudly. Refusing would lock
    // every merchant out of signing in for as long as the store is down; Shopify's own
    // sign-in still has to succeed before any session starts.
    sharedStore.hit(options.name, key, options.windowMs).then(decide, (error: unknown) => {
      console.error(`[scorelo-ratelimit] ${options.name}: shared store unavailable, request allowed — ${describeError(error)}`);
      next();
    });
  };
}

/**
 * Counts one occurrence of `key` against a limit that is not tied to a route — the browser-crash
 * reports, say. In the shared store when one is installed, otherwise in `memory`, which the caller
 * owns. Resolves true while the count is within `max`.
 */
export async function withinLimit(
  name: string,
  key: string,
  windowMs: number,
  max: number,
  memory: () => boolean,
): Promise<boolean> {
  if (!sharedStore) return memory();
  try {
    const bucket = await sharedStore.hit(name, key, windowMs);
    return bucket.count <= max;
  } catch (error) {
    console.error(`[scorelo-ratelimit] ${name}: shared store unavailable, allowed — ${describeError(error)}`);
    return true;
  }
}
