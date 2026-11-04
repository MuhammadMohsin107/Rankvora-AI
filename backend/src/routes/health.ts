import { Router } from 'express';
import { pingDatabase } from '../db/client.js';

export const healthRouter = Router();

/**
 * GET /api/health — liveness + database reachability.
 * Exposes status flags only; no infrastructure details.
 */
healthRouter.get('/health', async (_req, res) => {
  const databaseOk = await pingDatabase();
  res.status(databaseOk ? 200 : 503).json({
    status: databaseOk ? 'ok' : 'degraded',
    database: databaseOk ? 'connected' : 'unreachable',
  });
});
