import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * ─── One line per request ────────────────────────────────────────────
 *
 * The API had no request log. A 401 from `authenticate`, a 404 for a route the deployed build does
 * not have, a request that took twelve seconds — none of them left any trace, so "did the new
 * endpoint ship?" and "what happened to this merchant's request?" could only be answered by
 * reproducing it.
 *
 * Every request now gets an id, returned to the caller in `X-Request-Id` and written on its log
 * line and on any error logged while it ran. A merchant's failed request, the browser's network
 * tab, and the server's stack trace can be matched by that one value.
 *
 * WHAT IS LOGGED: method, path, status, duration, the signed-in user's id. WHAT IS NOT: the query
 * string (OAuth callbacks carry an authorization `code` and a signed `state` there), headers
 * (the bearer token), and bodies.
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 16 hex characters: unique enough to find one request in a log, short enough to read aloud. */
export function newRequestId(): string {
  return randomBytes(8).toString('hex');
}

/** The path a request was for, without its query string. */
export function requestPath(req: Partial<Pick<Request, 'originalUrl'>>): string {
  const path = (req.originalUrl ?? '').split('?')[0] ?? '';
  return path.length > 300 ? `${path.slice(0, 300)}…` : path;
}

export interface AccessLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  userId?: number;
  /** Why it failed, when the error handler knows — set on `res.locals.errorSummary`. */
  error?: string;
  /** The client went away before a response was sent. */
  aborted?: boolean;
}

/**
 * The line itself. Pure, so its exact shape is tested.
 *
 *   [scorelo-http] GET /api/notifications 200 12ms rid=9f2c4e1a0b7d3c55 user=5
 *   [scorelo-http] DELETE /api/notifications/88 404 4ms rid=… user=5 — NOTIFICATION_NOT_FOUND: Notification not found
 */
export function accessLogLine(entry: AccessLogEntry): string {
  const status = entry.aborted ? 'aborted' : String(entry.status);
  const user = entry.userId !== undefined ? ` user=${entry.userId}` : '';
  const reason = entry.error ? ` — ${entry.error}` : '';
  return `[scorelo-http] ${entry.method} ${entry.path} ${status} ${entry.durationMs}ms rid=${entry.requestId}${user}${reason}`;
}

/** 5xx is ours to fix, 4xx is worth seeing, the rest is traffic. */
function write(entry: AccessLogEntry): void {
  const line = accessLogLine(entry);
  if (entry.status >= 500) console.error(line);
  else if (entry.status >= 400 || entry.aborted) console.warn(line);
  else console.log(line);
}

/** Mounted first in server.ts, so every later middleware and handler runs with an id. */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const requestId = newRequestId();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  let logged = false;
  const finish = (aborted: boolean) => {
    if (logged) return;
    logged = true;
    write({
      method: req.method,
      path: requestPath(req),
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
      requestId,
      userId: req.user?.id,
      error: typeof res.locals.errorSummary === 'string' ? res.locals.errorSummary : undefined,
      aborted,
    });
  };

  res.on('finish', () => finish(false));
  // 'close' without 'finish' means the connection ended before the response did.
  res.on('close', () => finish(!res.writableFinished));
  next();
}
