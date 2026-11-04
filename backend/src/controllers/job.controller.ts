import type { Request, Response } from 'express';
import { createAuditJob, getJob } from '../services/job.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

export async function postRunAudit(req: Request, res: Response) {
  const job = await createAuditJob(requireUserId(req), optionalStoreId(req));
  res.status(202).json({ data: job });
}

export async function getJobById(req: Request, res: Response) {
  const job = await getJob(requireUserId(req), Number(req.params.id), optionalStoreId(req));
  res.json({ data: job });
}
