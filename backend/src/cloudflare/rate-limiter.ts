import { DurableObject } from 'cloudflare:workers';

/**
 * ─── One rate-limit counter, shared by every copy of the Worker ──────
 *
 * A Durable Object is a single instance somewhere on Cloudflare's network that every copy of the
 * Worker can reach, and it handles one call at a time. worker.ts addresses one per limiter and key
 * (e.g. "auth:shopify-start" + an IP), so all requests counted against the same allowance meet
 * here, in order, and the count cannot be raced.
 *
 * Fixed window, the same rule middleware/rateLimit.ts applies in memory on Node: the first hit starts
 * a window of `windowMs`; hits inside it add one; the first hit after it ends starts a fresh one.
 *
 * Storage is cleaned up by itself: an alarm at the end of each window deletes the counter, so an
 * object that is never hit again leaves nothing behind.
 *
 * Cloudflare-only: excluded from the Node build (tsconfig.build.json), loaded by worker.ts alone.
 */

interface Window {
  count: number;
  /** Epoch ms at which this window ends. */
  resetAt: number;
}

export class RateLimiter extends DurableObject {
  /** Counts one request and returns the window's running total. */
  async hit(windowMs: number): Promise<Window> {
    const now = Date.now();
    const current = await this.ctx.storage.get<Window>('window');
    const startsNewWindow = !current || current.resetAt <= now;
    const next: Window = startsNewWindow
      ? { count: 1, resetAt: now + windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };

    await this.ctx.storage.put('window', next);
    if (startsNewWindow) await this.ctx.storage.setAlarm(next.resetAt);
    return next;
  }

  /** The window has ended: forget it. A later hit starts a new one. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
