import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { updateReturning } from '../db/returning.js';
import { integrations } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import type { UpdateIntegrationInput } from '../schemas/integration.schema.js';
import { getCurrentStoreId } from './store.service.js';

export async function listIntegrations(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  return db.select().from(integrations).where(eq(integrations.storeId, resolvedStoreId)).orderBy(asc(integrations.provider));
}

/**
 * Providers whose rows are written by a real connector — its OAuth callback and its verified reads —
 * and never by hand.
 *
 * PATCH /integrations accepted any provider, so a single request could mark Search Console
 * "connected" and stamp a sync time for a read that never happened, and the Integrations page would
 * repeat both as fact. For these providers the row is the record of what Shopify and Google actually
 * answered, so it is not writable through this route.
 */
export const CONNECTOR_MANAGED_PROVIDERS = ['shopify', 'search-console', 'analytics', 'pagespeed'] as const;

export function isConnectorManaged(provider: string): boolean {
  return (CONNECTOR_MANAGED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * ─── Connector-owned display rows ────────────────────────────────────
 *
 * The helpers a connector uses to keep its own `integrations` row in step with what actually
 * happened. EVERY ONE SCOPES TO (store, provider), and that is the whole point: a bare
 * `where(storeId)` matches every provider row on the store, so one connector's failure would mark
 * all of them — including Shopify — as needing attention. The Google connectors have their own
 * equivalents in google-oauth.service.ts, which predate these and carry the same guarantee.
 */

/** One connector's display row, or null when it has never written one. */
export async function readConnectorRow(
  storeId: number,
  provider: string,
): Promise<{ status: string; accountDetail: string | null; lastSyncedAt: Date | null; notice: string | null } | null> {
  const [row] = await db
    .select({
      status: integrations.status,
      accountDetail: integrations.accountDetail,
      lastSyncedAt: integrations.lastSyncedAt,
      notice: integrations.notice,
    })
    .from(integrations)
    .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}

/**
 * Records this connector's state without claiming a read happened.
 *
 * `lastSyncedAt` is deliberately untouched: it is the record of when real data last arrived, and a
 * failure is not a moment when it did.
 */
export async function markConnectorState(
  storeId: number,
  provider: string,
  status: 'connected' | 'needs_attention' | 'not_connected',
  notice: string | null,
): Promise<void> {
  await db
    .insert(integrations)
    .values({ storeId, provider, status, accountDetail: null, lastSyncedAt: null, notice })
    // Insert, or update the row that already holds this (store_id, provider): integrations_store_provider_idx.
    .onConflictDoUpdate({ target: [integrations.storeId, integrations.provider], set: { status, notice } });
}

/**
 * Records that real data arrived for this connector, at this moment.
 *
 * The only path that writes `lastSyncedAt`, so "last synced" cannot be stamped by anything but an
 * answer that actually came back. `notice` carries a partial result forward — some connectors read
 * several things at once and half of it failing is neither a clean success nor a failure.
 */
export async function markConnectorSynced(
  storeId: number,
  provider: string,
  accountDetail: string | null,
  notice: string | null = null,
): Promise<void> {
  const syncedAt = new Date();
  await db
    .insert(integrations)
    .values({ storeId, provider, status: notice ? 'needs_attention' : 'connected', accountDetail, lastSyncedAt: syncedAt, notice })
    .onConflictDoUpdate({
      target: [integrations.storeId, integrations.provider],
      set: { status: notice ? 'needs_attention' : 'connected', accountDetail, lastSyncedAt: syncedAt, notice },
    });
}

export async function updateIntegration(userId: number, provider: string, input: UpdateIntegrationInput, storeId?: number) {
  if (isConnectorManaged(provider)) {
    throw new ApiError(
      409,
      'This integration is managed by its connector. Connect, reconnect or disconnect it from the Integrations page.',
      'INTEGRATION_CONNECTOR_MANAGED',
    );
  }

  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  // A connection event is a sync event — stamp it server-side so the client never invents a timestamp.
  const values = input.status === 'connected' ? { ...input, lastSyncedAt: new Date() } : input;
  const [updatedIntegration] = await updateReturning(
    integrations,
    values,
    and(eq(integrations.storeId, resolvedStoreId), eq(integrations.provider, provider)),
  );

  if (!updatedIntegration) throw new ApiError(404, 'Integration not found', 'INTEGRATION_NOT_FOUND');
  return updatedIntegration;
}
