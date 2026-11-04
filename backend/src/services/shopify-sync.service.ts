import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrations, shopifyConnections, stores } from '../db/schema.js';
import { shopifyConfigured } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { NOTIFICATION_LINKS, createNotification } from './notification.service.js';
import { resolveStoreDataProvider, StoreDataError } from '../audit-engine/store-data/index.js';
import { applyShopifyFacts, factsFromShop } from './store-profile.service.js';
import { describeError } from '../lib/logger.js';

/**
 * Connection lifecycle states the UI renders directly. `connecting` and `syncing` are transient
 * client-side states during a request and are never persisted, so they are not produced here.
 */
export type ShopifyConnectionStatus = 'not_connected' | 'connected' | 'reauthorization_required' | 'error';

export interface ShopifySyncSummary {
  products: number;
  collections: number;
  pages: number;
  articles: number;
  policies: number;
  /** Resource groups the scope limit cut short — a large catalogue must not read as fully scanned. */
  truncated: string[];
  /** Resource groups that could not be read at all this run. */
  unavailable: string[];
  warnings: string[];
  syncedAt: string;
}

export interface ShopifyStatus {
  /** False when the server has no Shopify app credentials — the UI must not offer Connect. */
  configured: boolean;
  status: ShopifyConnectionStatus;
  shopDomain: string | null;
  storeName: string | null;
  storeUrl: string | null;
  installedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastSyncSummary: ShopifySyncSummary | null;
  /** Granted scopes, for a permissions view. Tokens are NEVER part of this payload. */
  scopes: string[];
}

async function liveConnection(storeId: number) {
  const [connection] = await db
    .select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  return connection ?? null;
}

/**
 * The single source of truth the Integrations UI reads. Every field is derived from persisted
 * state, so the UI cannot show "Connected" for a store that is not, and cannot show a sync time
 * for a sync that never happened.
 */
export async function getShopifyStatus(userId: number, storeId?: number): Promise<ShopifyStatus> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [store] = await db.select().from(stores).where(eq(stores.id, resolvedStoreId)).limit(1);
  const connection = await liveConnection(resolvedStoreId);
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.storeId, resolvedStoreId), eq(integrations.provider, 'shopify')))
    .limit(1);

  if (!connection) {
    return {
      configured: shopifyConfigured(),
      status: 'not_connected',
      shopDomain: null,
      storeName: null,
      storeUrl: null,
      installedAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
      lastSyncSummary: null,
      scopes: [],
    };
  }

  // 'needs_attention' is written by the token-refresh path when re-authorization is the only way
  // forward, so it maps to a distinct state rather than a generic error.
  const status: ShopifyConnectionStatus =
    integration?.status === 'needs_attention' ? 'reauthorization_required' : connection.lastSyncError ? 'error' : 'connected';

  return {
    configured: shopifyConfigured(),
    status,
    shopDomain: connection.shopDomain,
    storeName: store?.name ?? null,
    storeUrl: store?.url ?? null,
    installedAt: connection.installedAt?.toISOString() ?? null,
    lastSyncedAt: integration?.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: connection.lastSyncError,
    lastSyncSummary: (connection.lastSyncSummary as ShopifySyncSummary | null) ?? null,
    scopes: connection.scope ? connection.scope.split(',').map((scope) => scope.trim()).filter(Boolean) : [],
  };
}

/** Merchant-facing wording for each failure mode. Raw Shopify messages and stack traces are
 * never surfaced — they describe our request, not something the merchant can act on. */
function describeFailure(error: unknown): string {
  if (error instanceof StoreDataError) {
    switch (error.code) {
      case 'NOT_CONNECTED':
        return 'No connected Shopify store.';
      case 'TOKEN_REVOKED':
        return 'Shopify authorization failed. Please reconnect your store.';
      case 'MISSING_SCOPES':
        return 'Additional Shopify permissions are required. Reconnect your store to grant them.';
      case 'RATE_LIMITED':
        return 'Shopify rate-limited the sync. Try again in a few minutes.';
      default:
        return "Shopify is temporarily unavailable. We couldn't sync your store.";
    }
  }
  if (error instanceof ApiError && error.code === 'SHOPIFY_REAUTH_REQUIRED') {
    return 'Shopify authorization has expired. Please reconnect your store.';
  }
  return "Shopify is temporarily unavailable. We couldn't sync your store.";
}

/**
 * Reads the connected shop's real data and records what was actually retrieved.
 *
 * This is a genuine round trip to Shopify, not a status flip: the previous Integrations UI
 * "synced" by PATCHing a status column and stamping the current time, which reported a
 * successful sync for a store nobody had contacted. On failure the error is persisted and
 * re-thrown, so the UI shows "Sync failed" rather than a stale success.
 */
export async function syncShopifyStore(userId: number, storeId?: number): Promise<ShopifySyncSummary> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const connection = await liveConnection(resolvedStoreId);
  if (!connection) throw new ApiError(400, 'Connect a Shopify store first', 'STORE_NOT_CONNECTED');

  console.log(`[scorelo-api] shopify: sync started for ${connection.shopDomain} (store ${resolvedStoreId})`);

  try {
    const provider = await resolveStoreDataProvider(resolvedStoreId);
    const snapshot = await provider.buildSnapshot();

    const truncated = Object.entries({
      products: snapshot.scope.productsTruncated,
      collections: snapshot.scope.collectionsTruncated,
      pages: snapshot.scope.pagesTruncated,
      articles: snapshot.scope.articlesTruncated,
    })
      .filter(([, isTruncated]) => isTruncated)
      .map(([resource]) => resource);

    const unavailable = Object.entries(snapshot.coverage)
      .filter(([resource, covered]) => !covered && resource !== 'metafields')
      .map(([resource]) => resource);

    const summary: ShopifySyncSummary = {
      products: snapshot.products.length,
      collections: snapshot.collections.length,
      pages: snapshot.pages.length,
      articles: snapshot.articles.length,
      policies: snapshot.policies.length,
      truncated,
      unavailable,
      warnings: snapshot.warnings,
      syncedAt: snapshot.capturedAt.toISOString(),
    };

    await db
      .update(shopifyConnections)
      .set({ lastSyncSummary: summary, lastSyncError: null })
      .where(eq(shopifyConnections.id, connection.id));

    // The sync read the shop's identity with everything else, so the workspace is refreshed from
    // it — never overwriting a value the merchant edited.
    await applyShopifyFacts(resolvedStoreId, factsFromShop({
      shopDomain: connection.shopDomain,
      name: snapshot.shop.name,
      primaryUrl: snapshot.shop.primaryUrl,
      country: snapshot.shop.country,
      currency: snapshot.shop.currency,
      timezone: snapshot.shop.timezone,
    }, snapshot.capturedAt));

    // Only stamped once real data came back, so "Last synced" always refers to an actual read.
    await db
      .update(integrations)
      .set({ status: 'connected', lastSyncedAt: snapshot.capturedAt, notice: null })
      .where(and(eq(integrations.storeId, resolvedStoreId), eq(integrations.provider, 'shopify')));

    console.log(
      `[scorelo-api] shopify: sync completed for ${connection.shopDomain} — ` +
        `${summary.products} products, ${summary.collections} collections, ${summary.pages} pages, ${summary.articles} articles`,
    );
    return summary;
  } catch (error) {
    const message = describeFailure(error);
    await db.update(shopifyConnections).set({ lastSyncError: message }).where(eq(shopifyConnections.id, connection.id));
    console.warn(`[scorelo-api] shopify: sync failed for ${connection.shopDomain} — ${describeError(error)}`);

    // `message` is already merchant-safe wording chosen by describeFailure — no raw error text
    // reaches the bell. Deduped, because a store whose token died fails every sync attempt.
    await createNotification({
      storeId: resolvedStoreId,
      type: 'integration_alert',
      title: 'Shopify sync failed',
      message,
      tone: 'warning',
      // Retrying the sync, and seeing why it failed, both live on Integrations.
      link: NOTIFICATION_LINKS.integrations,
      dedupeMinutes: 60,
    });

    throw new ApiError(502, message, 'SHOPIFY_SYNC_FAILED');
  }
}
