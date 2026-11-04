import type { Request, Response } from 'express';
import { listIntegrations, updateIntegration } from '../services/integration.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

export async function getIntegrations(req: Request, res: Response) {
  res.json({ data: await listIntegrations(requireUserId(req), optionalStoreId(req)) });
}

export async function patchIntegration(req: Request, res: Response) {
  res.json({ data: await updateIntegration(requireUserId(req), req.params.provider, req.body, optionalStoreId(req)) });
}
