import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { shopifyConnections, stores } from '../db/schema.js';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { ApiError } from '../middleware/error.js';
import { verifyShopifyIdToken } from '../lib/shopify-id-token.js';
import { establishShopAccount } from './shopify-account.service.js';
import { exchangeIdTokenForToken, missingScopes, requireConfigured } from './shopify-oauth.service.js';

/**
 * ─── Opening the app from inside the Shopify admin ───────────────────
 *
 * The embedded app has no sign-in page, no redirect and no stored session. Every request carries an
 * ID token (lib/shopify-id-token.ts) that names the shop; this file is how a shop becomes an account.
 *
 *   findInstalledOwner      every request: the account that owns an installed shop, or null.
 *   openEmbeddedSession     once, when the app opens: makes sure the shop has a working connection —
 *                           exchanging the ID token for an access token when it does not — and
 *                           returns its account, creating one for a shop never seen before.
 *
 * The first is one indexed read and never calls Shopify. The second is the only place a token
 * exchange happens, so a Shopify outage cannot turn every request into a failed one.
 */

type Connection = typeof shopifyConnections.$inferSelect;

/**
 * Whether a stored connection can still do its job without asking Shopify for anything new.
 *
 * Not current when the shop was uninstalled; when its granted scopes no longer cover what the app
 * asks for (the merchant has since approved more, and only a fresh token carries them); or when both
 * its access token and its refresh token have lapsed. A legacy token with no expiry is current — it
 * is valid until Shopify revokes it, and reading its NULL expiry as "expired at the epoch" would send
 * every such shop through an exchange it does not need.
 */
export function connectionIsCurrent(connection: Connection, now = Date.now()): boolean {
  if (connection.uninstalledAt) return false;
  if (missingScopes(connection.scope).length > 0) return false;
  if (!connection.accessTokenExpiresAt) return true;
  if (connection.accessTokenExpiresAt.getTime() > now) return true;
  // The access token has lapsed. A live refresh token renews it on first use (getValidAccessToken).
  if (!connection.refreshTokenEncrypted) return false;
  return !connection.refreshTokenExpiresAt || connection.refreshTokenExpiresAt.getTime() > now;
}

/** The account that owns an installed shop, or null when the shop has not been opened here yet (or
 * was uninstalled). Run on every authenticated request, so it is a single read. */
export async function findInstalledOwner(shop: string): Promise<number | null> {
  const [row] = await db
    .select({ ownerId: stores.ownerId })
    .from(shopifyConnections)
    .innerJoin(stores, eq(stores.id, shopifyConnections.storeId))
    .where(and(eq(shopifyConnections.shopDomain, shop), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  return row?.ownerId ?? null;
}

/**
 * The address of a page of this app inside the merchant's Shopify admin.
 *
 * Shopify serves `https://<shop>/admin/apps/<client id>/<path>` by opening the admin and loading
 * the app at that path in its iframe. It is how a browser that has left the app — to Google's consent
 * screen, say — comes back to the embedded app instead of to the bare site, which outside the admin
 * has no session and nothing to show.
 */
export function adminAppUrl(shop: string, path: string): string {
  return `https://${shop}/admin/apps/${env.shopifyApiKey}${path}`;
}

/** The installed shop a store belongs to, or null when it has none (or was uninstalled). */
export async function findShopForStore(storeId: number): Promise<string | null> {
  const [row] = await db
    .select({ shop: shopifyConnections.shopDomain })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  return row?.shop ?? null;
}

export interface EmbeddedSession {
  userId: number;
  shop: string;
  /** True when this call exchanged a token — a first open, a reinstall, or new scopes. */
  exchanged: boolean;
}

/**
 * Makes sure the shop that sent `idToken` has a working connection, and returns the account it
 * belongs to. Throws ShopifyIdTokenError for a token that is not Shopify's, an ApiError when the
 * exchange or the account cannot be completed.
 */
export async function openEmbeddedSession(idToken: string): Promise<EmbeddedSession> {
  requireConfigured();
  const { shop } = verifyShopifyIdToken(idToken);

  const [existing] = await db
    .select({ connection: shopifyConnections, ownerId: stores.ownerId })
    .from(shopifyConnections)
    .innerJoin(stores, eq(stores.id, shopifyConnections.storeId))
    .where(eq(shopifyConnections.shopDomain, shop))
    .limit(1);
  if (existing && connectionIsCurrent(existing.connection)) {
    return { userId: existing.ownerId, shop, exchanged: false };
  }

  const tokens = await exchangeIdTokenForToken(shop, idToken);

  // Managed installation grants the scopes in shopify.app.toml, so a shortfall means the toml and
  // the code's own list have drifted apart — or the merchant has not yet approved a newer version.
  // Either way the shop cannot be audited or fixed, so it opens nothing.
  const missing = missingScopes(tokens.scope);
  if (missing.length > 0) {
    throw new ApiError(403, `Shopify did not grant: ${missing.join(', ')}`, 'SHOPIFY_SCOPES_MISSING');
  }

  const client = new ShopifyClient({ shopDomain: shop, accessToken: tokens.accessToken });
  const userId = await establishShopAccount(shop, tokens, client);
  console.log(`[scorelo-api] shopify: embedded session opened for ${shop} (user ${userId})`);
  return { userId, shop, exchanged: true };
}
