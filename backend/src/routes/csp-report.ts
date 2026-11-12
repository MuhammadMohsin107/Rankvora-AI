import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../middleware/error.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * ─── Where the browser reports what the content policy would block ───
 *
 * The page is sent with a Content-Security-Policy-Report-Only header (cloudflare/shell.ts). Each time it
 * loads or connects to something the policy does not name, the browser POSTs a small JSON report here.
 * Nothing is blocked; this is how the policy gets checked against real Shopify admin sessions before it
 * is enforced.
 *
 * Open to anyone, because a browser sends reports without credentials. So it is built to be harmless:
 * a few kilobytes at most, a rate limit per caller, never a database write, always the same empty 204
 * whatever arrives, and a log line made only from short, sanitised pieces.
 *
 * The page's address carries Shopify's session token (`id_token`) in its query string. That must never
 * reach a log, so every address is cut down to origin + path before it is written.
 */
export const cspReportRouter = Router();

const FIELD_MAX = 160;

/** Origin + path only: no query string, no fragment, so no session token. */
export function withoutQuery(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '-';
  // `inline`, `eval`, `data` and the like are keywords, not addresses.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return clean(value.split(/[?#]/)[0]);
  try {
    const url = new URL(value);
    return clean(`${url.origin}${url.pathname}`);
  } catch {
    return clean(value.split(/[?#]/)[0]);
  }
}

function clean(value: string): string {
  return value.replace(/[^\x20-\x7e]+/g, ' ').slice(0, FIELD_MAX);
}

/** The few fields worth a log line, from either report format. */
export function summariseReport(raw: unknown): { directive: string; blocked: string; document: string; source: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // Legacy: { "csp-report": { "violated-directive", "blocked-uri", "document-uri", "source-file" } }
  // Reporting API: { type: "csp-violation", body: { effectiveDirective, blockedURL, documentURL, sourceFile } }
  const legacy = record['csp-report'];
  const body = (record.body ?? legacy) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return null;
  const pick = (...keys: string[]) => keys.map((key) => body[key]).find((value) => typeof value === 'string');
  const directive = pick('effectiveDirective', 'effective-directive', 'violated-directive', 'violatedDirective');
  return {
    directive: typeof directive === 'string' ? clean(directive.split(' ')[0]) : '-',
    blocked: withoutQuery(pick('blockedURL', 'blocked-uri', 'blockedUri')),
    document: withoutQuery(pick('documentURL', 'document-uri', 'documentUri')),
    source: withoutQuery(pick('sourceFile', 'source-file')),
  };
}

const readReports = express.json({ type: ['application/csp-report', 'application/reports+json'], limit: '8kb' });

cspReportRouter.post(
  '/',
  rateLimit({ name: 'csp-report', windowMs: 60 * 1000, max: 30, message: 'Too many reports.' }),
  readReports,
  (req: Request, res: Response) => {
    const reports = Array.isArray(req.body) ? req.body.slice(0, 5) : [req.body];
    for (const report of reports) {
      const line = summariseReport(report);
      if (line) console.warn(`[scorelo-csp] would block ${line.directive}: ${line.blocked} (page ${line.document}, from ${line.source})`);
    }
    res.status(204).end();
  },
);

// A report that will not parse (or is too large) is not worth an error: answer the same empty 204. The
// rate limiter's refusal is the exception — that is an ApiError, and it keeps its 429.
cspReportRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof ApiError) return next(error);
  res.status(204).end();
});
