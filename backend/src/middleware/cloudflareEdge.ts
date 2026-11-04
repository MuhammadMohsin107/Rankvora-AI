import type { NextFunction, Request, Response } from 'express';

/**
 * ─── What nginx did, when there is no nginx ──────────────────────────
 *
 * On the server, every request passes through nginx and server.cjs before it reaches this API. That
 * chain does two things the app relies on:
 *
 *   1. It records the caller's real address in X-Forwarded-For, which `req.ip` (behind
 *      `trust proxy`, see lib/trustProxy.ts) and lib/requestMetadata.ts read. The rate limiters key
 *      on `req.ip`, so this is what gives every visitor their own allowance.
 *   2. nginx adds five security headers to every response.
 *
 * On Cloudflare Workers neither exists. Cloudflare instead tells the Worker who the caller is in the
 * CF-Connecting-IP header, which it sets itself at its edge — a caller cannot choose its value.
 * worker.ts switches this middleware on; on Node it is never switched on and does nothing at all, so
 * nginx's headers are not doubled (a repeated X-Frame-Options can make a browser ignore it).
 */

/** The headers nginx adds on staging, read from its responses — same names, same values. */
export const EDGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'X-Permitted-Cross-Domain-Policies': 'master-only',
  'Referrer-Policy': 'same-origin',
};

let enabled = false;

/** Turns the edge behaviour on. Called by worker.ts; Node never calls it. */
export function useCloudflareEdge(on: boolean): void {
  enabled = on;
}

/**
 * Mounted first in app.ts, before anything reads `req.ip`.
 *
 * The caller's address replaces `req.ip`, AND replaces any X-Forwarded-For the caller sent: that
 * header is client-settable, and on Workers there is no proxy of ours whose entry it could be.
 * Without CF-Connecting-IP (it is always present on Cloudflare) the request is left as it arrived.
 */
export function cloudflareEdge(req: Request, res: Response, next: NextFunction): void {
  if (!enabled) return next();

  const raw = req.headers['cf-connecting-ip'];
  const address = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (address) {
    Object.defineProperty(req, 'ip', { value: address, configurable: true, enumerable: true });
    req.headers['x-forwarded-for'] = address;
  }

  for (const [name, value] of Object.entries(EDGE_SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}
