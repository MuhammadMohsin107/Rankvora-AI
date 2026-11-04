import type { Request, Response } from 'express';
import { logValue } from '../lib/logger.js';
import { requireUserId } from '../lib/requestContext.js';
import { withinLimit } from '../middleware/rateLimit.js';
import type { ClientErrorReport } from '../schemas/client-error.schema.js';

/**
 * ─── Browser crashes, in the server's log ────────────────────────────
 *
 * The frontend's ErrorBoundary catches a render crash and shows the merchant a way out — and until
 * now wrote the error only to that merchant's browser console. The one failure that blanks the
 * whole app for a customer was the one failure operators could never see. The boundary now posts
 * the error here, and it is written to the log beside everything else, with the user and the page.
 */

/** Frames kept from each stack. The top of a stack says where; the rest is framework plumbing. */
const MAX_FRAMES = 12;

/** Reports accepted per user per window. A crash that re-renders in a loop must not flood the log. */
const MAX_REPORTS = 10;
const WINDOW_MS = 10 * 60_000;
const recent = new Map<number, number[]>();

/** Whether this user may log another report now. Old timestamps are dropped as it goes. */
export function acceptReport(userId: number, now: number = Date.now()): boolean {
  const kept = (recent.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (kept.length >= MAX_REPORTS) {
    recent.set(userId, kept);
    return false;
  }
  kept.push(now);
  recent.set(userId, kept);
  return true;
}

/** Clears the rate-limit memory. Tests only. */
export function resetClientErrorLimits(): void {
  recent.clear();
}

/** A browser-supplied stack as indented log lines — each one quoted, so none can pose as a log line. */
function frames(label: string, stack: string | undefined): string[] {
  if (!stack) return [];
  const lines = stack.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_FRAMES);
  return lines.length > 0 ? [`  ${label}:`, ...lines.map((line) => `    ${logValue(line, 300)}`)] : [];
}

/** The log entry for one report. Pure, so its exact shape is tested. */
export function clientErrorLogLines(userId: number, requestId: string | undefined, report: ClientErrorReport): string {
  return [
    `[scorelo-client] render crash user=${userId} rid=${requestId ?? '-'} path=${logValue(report.path)} — ${logValue(report.message, 500)}`,
    ...frames('stack', report.stack),
    ...frames('component stack', report.componentStack),
  ].join('\n');
}

export async function postClientError(req: Request, res: Response) {
  const userId = requireUserId(req);
  // In this process's memory on Node (acceptReport, a sliding ten-minute window). On Cloudflare the
  // copies of the Worker share one count per user instead — a fixed ten-minute window, same ceiling.
  if (await withinLimit('client-errors', `user:${userId}`, WINDOW_MS, MAX_REPORTS, () => acceptReport(userId))) {
    console.error(clientErrorLogLines(userId, req.requestId, req.body as ClientErrorReport));
  }
  // 204 either way: the browser has nothing to do with the answer, and a suppressed report is not
  // an error the merchant should see.
  res.status(204).send();
}
