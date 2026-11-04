import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { updateReturning } from '../db/returning.js';
import { stores } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import type { UpdateStoreInput } from '../schemas/store.schema.js';

async function resolveStore(userId: number, storeId?: number) {
  const where = storeId ? and(eq(stores.ownerId, userId), eq(stores.id, storeId)) : eq(stores.ownerId, userId);
  const [store] = await db.select().from(stores).where(where).orderBy(asc(stores.id)).limit(1);
  if (!store) throw new ApiError(404, 'Store not found', 'STORE_NOT_FOUND');
  return store;
}

/** Every other service's tenancy seam: resolves the caller's active store, scoped to their own stores only. */
export async function getCurrentStoreId(userId: number, storeId?: number) {
  const store = await resolveStore(userId, storeId);
  return store.id;
}

export async function findCurrentStore(userId: number, storeId?: number) {
  return resolveStore(userId, storeId);
}

export async function listStores(userId: number) {
  return db.select().from(stores).where(eq(stores.ownerId, userId)).orderBy(asc(stores.id));
}

export async function updateCurrentStore(userId: number, input: UpdateStoreInput, storeId?: number) {
  const store = await resolveStore(userId, storeId);
  const [updatedStore] = await updateReturning(stores, input, eq(stores.id, store.id));
  if (!updatedStore) throw new ApiError(404, 'Store not found', 'STORE_NOT_FOUND');
  return updatedStore;
}
