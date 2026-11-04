import type { Request } from 'express';
import { ApiError } from '../middleware/error.js';

/** The authenticated user's id — throws if `authenticate` middleware didn't run. */
export function requireUserId(req: Request): number {
  if (!req.user) throw new ApiError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED');
  return req.user.id;
}

/** Optional `?storeId=` query param — lets a multi-store user target a specific store. */
export function optionalStoreId(req: Request): number | undefined {
  const raw = (req.query as { storeId?: unknown }).storeId;
  return typeof raw === 'number' ? raw : undefined;
}
