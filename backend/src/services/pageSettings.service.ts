import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insertReturning, updateReturning } from '../db/returning.js';
import { pageSettings } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import type { UpsertPageSettingsInput } from '../schemas/pageSettings.schema.js';

export async function getPageSettingsBySlug(userId: number, slug: string, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  const [row] = await db
    .select()
    .from(pageSettings)
    .where(and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, slug)))
    .limit(1);

  if (!row) {
    return { slug, values: {} };
  }

  return { slug: row.slug, values: row.values ?? {} };
}

export async function upsertPageSettingsBySlug(userId: number, slug: string, input: UpsertPageSettingsInput, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const values = input.values ?? {};

  const [existing] = await db
    .select()
    .from(pageSettings)
    .where(and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, slug)))
    .limit(1);

  if (existing) {
    const [updated] = await updateReturning(
      pageSettings,
      { values, updatedAt: new Date() },
      and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, slug)),
    );

    if (!updated) {
      throw new ApiError(404, 'Page settings not found', 'PAGE_SETTINGS_NOT_FOUND');
    }

    return { slug: updated.slug, values: updated.values ?? {} };
  }

  const created = await insertReturning(pageSettings, { storeId: resolvedStoreId, slug, values });

  if (!created) {
    throw new ApiError(500, 'Unable to create page settings', 'PAGE_SETTINGS_CREATE_FAILED');
  }

  return { slug: created.slug, values: created.values ?? {} };
}
