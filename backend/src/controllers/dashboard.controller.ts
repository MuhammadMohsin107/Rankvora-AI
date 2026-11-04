import type { Request, Response } from 'express';
import { getDashboardSummary } from '../services/dashboard.service.js';
import { getDashboardSignals } from '../services/dashboard-signals.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

export async function getSummary(req: Request, res: Response) {
  res.json({ data: await getDashboardSummary(requireUserId(req), optionalStoreId(req)) });
}

/** The four outcome cards under the pillars. Each is read on its own, so one failing never blanks the rest. */
export async function getSignals(req: Request, res: Response) {
  res.json({ data: await getDashboardSignals(requireUserId(req), optionalStoreId(req)) });
}
