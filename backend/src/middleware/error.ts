import type { NextFunction, Request, Response } from 'express';
import { isDev } from '../config/env.js';
import { describeError, describeErrorWithStack } from '../lib/logger.js';
import { requestPath } from './requestLog.js';
import { RequestValidationError } from './validateRequest.js';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'API_ERROR',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 404 for unmatched routes. */
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

/** 4xx means the caller asked for something we legitimately refused; 5xx means we broke. */
function statusCodeOf(err: unknown): number {
  if (err instanceof RequestValidationError || err instanceof ApiError) return err.statusCode;
  return 500;
}

/**
 * Which fields failed validation, never what was in them: "body.email (invalid_format)". The old
 * line said only "Request validation failed", which could not tell a client bug from a bad form.
 */
function validationSummary(err: RequestValidationError): string {
  const fields = err.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '(root)'} (${issue.code})`);
  const more = err.issues.length > 5 ? `, +${err.issues.length - 5} more` : '';
  return `${err.message}: ${fields.join(', ')}${more}`;
}

/**
 * Central error handler. Logs the failure server-side; the response never carries SQL internals,
 * connection strings or credentials.
 *
 * Expected 4xx (a store with no audits yet, an unconnected Shopify store) is normal application
 * flow, not a fault, so it gets no stack: its reason is handed to the request's access line
 * (middleware/requestLog.ts), one line per refused request. A 5xx gets its own line with the
 * stack, the request it happened in, and the request id — which is also returned to the caller,
 * so a merchant's "it failed" can be matched to this exact entry.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const status = statusCodeOf(err);
  const summary = err instanceof RequestValidationError ? validationSummary(err) : describeError(err);
  // Guarded: this is the last handler, and a failure here would replace the real error with its own.
  if (res.locals) res.locals.errorSummary = summary;

  if (status >= 500) {
    const user = req.user ? ` user=${req.user.id}` : '';
    console.error(`[scorelo-api] ${status} ${req.method} ${requestPath(req)} rid=${req.requestId ?? '-'}${user} — ${describeErrorWithStack(err)}`);
  }

  if (err instanceof RequestValidationError) {
    res.status(err.statusCode).json({
      error: 'Request validation failed',
      issues: err.issues,
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }

  res.status(500).json({
    error: 'Internal server error',
    // The id of the log entry above. Not an internal detail — it is the handle a customer or the
    // frontend can quote to find it.
    requestId: req.requestId,
    // Development only, and through describeError like the log: err.message on a query error is
    // drizzle's text with every bound value — the running server echoed a login's email back here.
    ...(isDev && err instanceof Error ? { message: describeError(err) } : {}),
  });
}
