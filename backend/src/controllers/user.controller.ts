import type { Request, Response } from 'express';
import { ApiError } from '../middleware/error.js';
import { getUserById, updateUserById } from '../services/user.service.js';

function requireUserId(req: Request) {
  if (!req.user) throw new ApiError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED');
  return req.user.id;
}

export async function getCurrentUser(req: Request, res: Response) {
  res.json({ data: await getUserById(requireUserId(req)) });
}

export async function updateCurrentUser(req: Request, res: Response) {
  res.json({ data: await updateUserById(requireUserId(req), req.body) });
}
