import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shopifyConnections, stores } from '../../db/schema.js';
import { getValidAccessToken } from '../../services/shopify-oauth.service.js';
import { loadAiDiscoveryInputs } from '../../services/ai-discovery.service.js';
import { latestPageSpeedReports } from '../../services/pagespeed.service.js';
import { readConnectorRow } from '../../services/integration.service.js';
import { ShopifyClient } from './shopify-client.js';
import { ShopifyStoreDataProvider } from './shopify.provider.js';
import { StoreDataError, type StoreDataProvider } from './types.js';

export * from './types.js';

/** True when the store has a live (non-uninstalled) Shopify connection. Used by the audit
 * trigger to reject a run up-front instead of failing minutes later inside the worker. */
export async function hasStoreDataSource(storeId: number): Promise<boolean> {
  const [connection] = await db
    .select({ id: shopifyConnections.id })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  return Boolean(connection);
}

/**
 * An authenticated Shopify client for a store, or a StoreDataError explaining why not.
 *
 * Extracted from resolveStoreDataProvider rather than copied: this is the one place that turns a
 * stored connection into a usable token, so a second caller (the alt-text preview, which needs a
 * handful of products rather than a whole snapshot) cannot end up with its own subtly different
 * token-refresh path. The token is decrypted here, used for this request, and never returned.
 */
export async function resolveShopifyClient(storeId: number): Promise<ShopifyClient> {
  const [connection] = await db
    .select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);

  if (!connection) {
    throw new StoreDataError('NOT_CONNECTED', 'No connected Shopify store — connect a store before running an audit', false);
  }

  // Expiring offline tokens live one hour, so this renews first when the stored token is at or
  // near expiry — otherwise a long audit would start with a token that dies mid-run.
  const accessToken = await getValidAccessToken(connection);
  return new ShopifyClient({ shopDomain: connection.shopDomain, accessToken });
}

/**
 * Resolves the data provider for a store. Today only Shopify exists; adding another platform
 * means adding one provider here, not touching any check (master prompt C6).
 */
export async function resolveStoreDataProvider(storeId: number): Promise<StoreDataProvider> {
  const [store] = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  if (!store) throw new StoreDataError('NOT_CONNECTED', 'Store not found', false);

  const [connection] = await db
    .select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);

  if (!connection) {
    throw new StoreDataError('NOT_CONNECTED', 'No connected Shopify store — connect a store before running an audit', false);
  }

  // Decrypted only here, held only for this run's lifetime, never logged or returned by any API.
  const client = await resolveShopifyClient(storeId);

  // The merchant's own AI Discovery inputs — the IndexNow key and the questions they track.
  // Loaded here rather than inside the provider or the checks: a check is a pure function of a
  // snapshot, and that property is what lets every one of them be tested without a database.
  const aiDiscovery = await loadAiDiscoveryInputs(storeId);

  // The store's most recent PageSpeed measurements, taken by the connector on the Integrations
  // page. READ, NEVER RUN: a measurement is tens of seconds of Google's time per strategy, and
  // triggering two inside every audit would add minutes to a run for a number that hardly moves
  // between them. The check reports when the reading was taken, so an old one says it is old
  // instead of passing as current.
  const [reports, connector] = await Promise.all([
    latestPageSpeedReports(storeId),
    readConnectorRow(storeId, 'pagespeed'),
  ]);

  return new ShopifyStoreDataProvider(
    client,
    storeId,
    connection.shopDomain,
    store.pageLimit,
    aiDiscovery,
    { reports, lastError: connector?.notice ?? null },
  );
}
