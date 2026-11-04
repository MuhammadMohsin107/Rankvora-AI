import type { Request, Response } from 'express';
import { findCurrentStore, listStores, updateCurrentStore } from '../services/store.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { profileOptions, refreshStoreProfile } from '../services/store-profile.service.js';

export async function getStores(req: Request, res: Response) {
  res.json({ data: await listStores(requireUserId(req)) });
}

export async function getCurrentStore(req: Request, res: Response) {
  res.json({ data: await findCurrentStore(requireUserId(req), optionalStoreId(req)) });
}

export async function updateStore(req: Request, res: Response) {
  res.json({ data: await updateCurrentStore(requireUserId(req), req.body, optionalStoreId(req)) });
}

/** Reads the connected shop now and fills the workspace from it, keeping hand edits. */
export async function refreshStoreFromShopify(req: Request, res: Response) {
  res.json({ data: await refreshStoreProfile(requireUserId(req), optionalStoreId(req)) });
}

/** The choices the Workspace page offers — the same vocabulary guided setup uses. */
export function getStoreProfileOptions(_req: Request, res: Response) {
  res.json({ data: profileOptions() });
}
