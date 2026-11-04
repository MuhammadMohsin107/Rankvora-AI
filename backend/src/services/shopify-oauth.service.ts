import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrations, shopifyConnections, stores } from '../db/schema.js';
import { env, shopifyConfigured } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { signShopifyState, verifyShopifyState } from '../lib/jwt.js';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { fetchShopIdentity } from '../audit-engine/store-data/shopify.queries.js';
import { NOTIFICATION_LINKS, createNotification } from './notification.service.js';
import { getCurrentStoreId } from './store.service.js';
import { applyShopifyFacts, factsFromShop } from './store-profile.service.js';

/**
 * ─── Access scopes ───────────────────────────────────────────────────
 * Minimum set required by the data Rankvora AI actually reads. Every entry below is justified by a
 * resource the provider fetches; nothing is requested "just in case", because each extra scope
 * is a permission the merchant must grant and a question Shopify asks at app review.
 *
 *   read_products     Product + Collection objects: title, descriptionHtml, seo{title,description},
 *                     media alt text, metafields. Feeds SEO (title tags, meta descriptions, image
 *                     alt text), Content (product/collection descriptions, metafields) and CRO.
 *   read_content      Page, Blog and Article objects. Feeds SEO (page titles/meta) and Content
 *                     (blog freshness, media richness). Also implicitly grants
 *                     read_online_store_pages, so that scope is NOT requested separately.
 *   read_themes       Online store theme data. Feeds Speed (theme weight, app bloat).
 *   read_metaobjects  Metaobject instances. Feeds Content (metafields/metaobjects) and
 *                     AI Discovery (structured answerable content).
 *   read_legal_policies  Shop policies (refund, shipping, privacy, terms). Feeds CRO (returns
 *                     flow). `shopPolicies` used to be readable under read_content and now
 *                     requires this scope of its own — without it Shopify denies the field
 *                     outright, so the returns check reports "not measured" rather than scoring.
 *   read_online_store_navigation  `UrlRedirect` records. Feeds SEO (handles & redirects: self
 *                     redirects, chains, loops). Easy to miss because the LEGACY REST `Redirect`
 *                     resource was covered by `content`, which this app already has — but the
 *                     GraphQL `urlRedirects` connection is scoped separately, and Shopify's own
 *                     access-scope table maps `UrlRedirect` to this scope alone. Without it the
 *                     query is denied outright and handles-redirects reports "not measured".
 *                     `write_online_store_navigation` is deliberately NOT requested: Rankvora AI
 *                     reads redirects to diagnose them and never creates or edits one.
 *
 * ─── Write scopes ────────────────────────────────────────────────────
 * These are what turn an approved fix into an actual change on the storefront. Without them the
 * flow can propose and record a value but never save it — which is the state this app shipped in:
 * `ai_fix_proposals` reached `approved` and stopped there.
 *
 *   write_products    seo{title,description} on Product and Collection, through productUpdate and
 *                     collectionUpdate.
 *   write_content     Page and Article search listings. Neither has an `seo` field on its update
 *                     input — verified against the 2026-07 schema — so their listing is written as
 *                     the `global.title_tag` / `global.description_tag` metafields, which is both
 *                     what Shopify's own SEO guide documents AND exactly what this app already
 *                     READS in PAGES_QUERY/ARTICLES_QUERY. Write field and read field are the same
 *                     field, so an applied fix is visible to the very next audit. Implicitly
 *                     grants write_online_store_pages, so that is NOT requested separately.
 *
 * SCOPE IS STILL CHECKED PER FIELD AT RUNTIME. `FIELD_RULES[].writeScope` names what each field
 * needs and fixability.service.ts compares it against `shopify_connections.scope` — what the
 * merchant ACTUALLY consented to. Adding a scope here grants nothing on existing connections:
 * Shopify only issues scopes on fresh consent, so a store connected before this change stays
 * read-only until it reconnects, and Apply refuses with a reason rather than failing at Shopify.
 *
 * Deliberately NOT requested:
 *   write_themes — Speed findings are diagnostic, and editing theme code from an audit tool is a
 *     far larger blast radius than a bounded metadata field. Nothing here proposes theme changes.
 *   read_orders, read_customers — Protected Customer Data. They force a Level 2 approval review
 *     with extra security obligations, and until approved Shopify redacts the fields anyway. No
 *     Rankvora AI check reads an order or a customer.
 *   read_product_listings, read_shipping, read_locations, read_price_rules, read_discounts,
 *   read_translations — no code path reads any of them.
 *
 * Changing this list changes what Shopify asks the merchant to approve. Existing connections keep
 * the scope string they were granted (stored per-connection), so a widened list only takes effect
 * for merchants who reconnect.
 */
const SCOPES = [
  'read_products',
  'read_content',
  'read_themes',
  'read_metaobjects',
  'read_legal_policies',
  // GraphQL's `urlRedirects` is scoped separately from the legacy REST Redirect resource that
  // `read_content` covers — see the read_online_store_navigation entry in the block above.
  'read_online_store_navigation',
  // Write access, required by the Apply-fix path. See the block above for why each is needed and
  // why existing connections keep read-only access until they reconnect.
  'write_products',
  'write_content',
].join(',');

/**
 * The scopes in SCOPES that a granted scope string does not cover. Shopify may list only the
 * write scope when both were requested, because write implies read.
 */
export function missingScopes(granted: string): string[] {
  const have = new Set(granted.split(',').map((scope) => scope.trim()).filter(Boolean));
  return SCOPES.split(',').filter(
    (scope) => !have.has(scope) && !(scope.startsWith('read_') && have.has(`write_${scope.slice('read_'.length)}`)),
  );
}

/** Renew an expiring access token this many ms BEFORE it actually expires, so a long audit run
 * cannot have its token die mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type ShopifyConnection = typeof shopifyConnections.$inferSelect;

export interface TokenResponse {
  accessToken: string;
  scope: string;
  /** Null for a legacy non-expiring token; Shopify omits these fields when `expiring` is unset. */
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export function requireConfigured() {
  if (!shopifyConfigured()) {
    throw new ApiError(500, 'Shopify app is not configured on this server (missing SHOPIFY_API_KEY/SECRET/BACKEND_URL/TOKEN_ENCRYPTION_KEY)', 'SHOPIFY_NOT_CONFIGURED');
  }
}

/**
 * Shopify's authorization screen for `shop`, returning to the one registered callback.
 *
 * Connecting a store and signing in with Shopify both come through here, and both land on the same
 * redirect URI — only the signed `state` differs. Keeping one URI means neither flow needs a new
 * entry in the app's redirect_urls, which only `shopify app deploy` can change.
 */
export function buildAuthorizeUrl(shop: string, state: string): string {
  requireConfigured();
  const redirectUri = new URL('/api/shopify/callback', env.backendUrl).toString();
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', env.shopifyApiKey!);
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  return authorizeUrl.toString();
}

export function buildInstallUrl(userId: number, storeId: number, shop: string): string {
  requireConfigured();
  return buildAuthorizeUrl(shop, signShopifyState(userId, storeId, shop));
}

/** Shopify's documented OAuth-callback HMAC check: sort every param except hmac/signature,
 * join as key=value with '&', HMAC-SHA256 with the app secret, compare to the sent hmac.
 *
 * The same signature covers the query Shopify appends when it opens the app from the admin or the
 * App Store (`shop`, `timestamp`, `host`, …), which is how sign-in trusts a shop it did not type. */
export function verifyCallbackHmac(query: Record<string, unknown>): boolean {
  const { hmac, signature: _signature, ...rest } = query as Record<string, string>;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&');
  const digest = createHmac('sha256', env.shopifyApiSecret!).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmac, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Shared shape for both grants against POST /admin/oauth/access_token. Shopify documents this
 * endpoint as form-encoded; the response is JSON either way. */
async function postTokenRequest(shop: string, body: Record<string, string>, failureCode: string): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });

  // Never include the response body in the error: on some failures Shopify echoes back request
  // parameters, and this request carries the client secret.
  if (!response.ok) throw new ApiError(502, 'Shopify rejected the OAuth token request', failureCode);

  const parsed = (await response.json()) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };

  if (!parsed.access_token) throw new ApiError(502, 'Shopify returned no access token', failureCode);

  const now = Date.now();
  const seconds = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) ? new Date(now + value * 1000) : null);

  return {
    accessToken: parsed.access_token,
    scope: parsed.scope ?? '',
    accessTokenExpiresAt: seconds(parsed.expires_in),
    refreshToken: parsed.refresh_token ?? null,
    refreshTokenExpiresAt: seconds(parsed.refresh_token_expires_in),
  };
}

/** `expiring=1` asks Shopify for a 1-hour access token plus a 90-day refresh token, which public
 * apps must use for Admin API requests from 2027-01-01. */
export async function exchangeCodeForToken(shop: string, code: string): Promise<TokenResponse> {
  return postTokenRequest(
    shop,
    { client_id: env.shopifyApiKey!, client_secret: env.shopifyApiSecret!, code, expiring: '1' },
    'SHOPIFY_TOKEN_EXCHANGE_FAILED',
  );
}

/**
 * Token exchange: trades the ID token App Bridge gave the page for an expiring offline access token.
 *
 * This is how an embedded app is installed and kept authorized with no redirect at all. Shopify has
 * already granted the scopes in shopify.app.toml (managed installation), and the ID token proves a
 * staff member has this shop's admin open, so there is no consent screen and no authorization code.
 * The token it returns is the same kind exchangeCodeForToken returns — one hour, plus a 90-day
 * refresh token — so everything downstream (encryption, storage, renewal) is shared.
 */
export async function exchangeIdTokenForToken(shop: string, idToken: string): Promise<TokenResponse> {
  return postTokenRequest(
    shop,
    {
      client_id: env.shopifyApiKey!,
      client_secret: env.shopifyApiSecret!,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    },
    'SHOPIFY_TOKEN_EXCHANGE_FAILED',
  );
}

async function refreshAccessToken(shop: string, refreshToken: string): Promise<TokenResponse> {
  return postTokenRequest(
    shop,
    { client_id: env.shopifyApiKey!, client_secret: env.shopifyApiSecret!, grant_type: 'refresh_token', refresh_token: refreshToken },
    'SHOPIFY_TOKEN_REFRESH_FAILED',
  );
}

/** A NULL expiry means a legacy non-expiring token, which is valid indefinitely — it must not be
 * mistaken for "expired at epoch" and sent through a refresh it has no refresh token for. */
function needsRefresh(connection: ShopifyConnection, nowMs: number): boolean {
  if (!connection.accessTokenExpiresAt) return false;
  return connection.accessTokenExpiresAt.getTime() - REFRESH_SKEW_MS <= nowMs;
}

async function persistTokens(connectionId: number, tokens: TokenResponse) {
  await db
    .update(shopifyConnections)
    .set({
      accessTokenEncrypted: encryptToken(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    })
    .where(eq(shopifyConnections.id, connectionId));
}

/**
 * Returns a usable access token for a connection, renewing it first if it is within the refresh
 * skew of expiry. The plaintext token is returned to the caller and never persisted, logged or
 * sent to a client.
 *
 * Throws SHOPIFY_REAUTH_REQUIRED when renewal is impossible (refresh token missing or itself
 * expired) — the merchant must reconnect, and the caller should surface that rather than retry.
 */
export async function getValidAccessToken(connection: ShopifyConnection): Promise<string> {
  const nowMs = Date.now();
  if (!needsRefresh(connection, nowMs)) return decryptToken(connection.accessTokenEncrypted);

  if (!connection.refreshTokenEncrypted || (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt.getTime() <= nowMs)) {
    await markReauthRequired(connection);
    throw new ApiError(401, 'Shopify authorization has expired — reconnect the store to continue', 'SHOPIFY_REAUTH_REQUIRED');
  }

  let tokens: TokenResponse;
  try {
    tokens = await refreshAccessToken(connection.shopDomain, decryptToken(connection.refreshTokenEncrypted));
  } catch {
    // Shopify refused the refresh token (revoked, rotated, app uninstalled). Nothing to retry.
    await markReauthRequired(connection);
    throw new ApiError(401, 'Shopify authorization has expired — reconnect the store to continue', 'SHOPIFY_REAUTH_REQUIRED');
  }

  await persistTokens(connection.id, tokens);
  return tokens.accessToken;
}

async function markReauthRequired(connection: ShopifyConnection) {
  // Record that the stored tokens are dead, not only that the merchant should be told. Embedded, the
  // way back is not a Reconnect button (there is none) but the next time the app is opened: the
  // ID token that open carries is exchanged for fresh tokens — and openEmbeddedSession only does
  // that for a connection it judges no longer current (connectionIsCurrent). A refresh token Shopify
  // refused still looks live by its dates, so without this the shop would stay in "needs attention"
  // for as long as the dates said otherwise. Nothing is lost: both tokens were already unusable.
  await db
    .update(shopifyConnections)
    .set({ accessTokenExpiresAt: new Date(0), refreshTokenEncrypted: null, refreshTokenExpiresAt: null })
    .where(eq(shopifyConnections.id, connection.id));

  await db
    .update(integrations)
    .set({ status: 'needs_attention', notice: 'Shopify authorization expired. Reconnect the store to resume audits.' })
    .where(and(eq(integrations.storeId, connection.storeId), eq(integrations.provider, 'shopify')));

  // Deduped over a day: an expired token is rediscovered by every audit, sync and status check
  // that touches Shopify, and the merchant needs to be told once — not once per attempt.
  await createNotification({
    storeId: connection.storeId,
    type: 'integration_alert',
    title: 'Shopify authorization expired',
    message: `Rankvora AI can no longer read ${connection.shopDomain}. Reconnect the store to resume audits.`,
    tone: 'critical',
    // Straight to the Reconnect button the message is asking them to press.
    link: NOTIFICATION_LINKS.integrations,
    dedupeMinutes: 24 * 60,
  });
}

export async function handleShopifyCallback(query: Record<string, unknown>): Promise<{ shopDomain: string; storeId: number }> {
  requireConfigured();

  if (!verifyCallbackHmac(query)) throw new ApiError(401, 'Invalid Shopify OAuth signature', 'SHOPIFY_HMAC_INVALID');

  const shop = String(query.shop);
  const code = String(query.code);
  const state = String(query.state);

  let statePayload;
  try {
    statePayload = verifyShopifyState(state);
  } catch {
    throw new ApiError(401, 'Invalid or expired OAuth state', 'SHOPIFY_STATE_INVALID');
  }
  if (statePayload.shop !== shop) throw new ApiError(401, 'OAuth state does not match shop', 'SHOPIFY_STATE_MISMATCH');

  /**
   * ─── Which store row this install lands on ───────────────────────────
   *
   * The store the merchant was looking at when they pressed Connect, carried through the OAuth
   * round trip in the signed state and re-checked here against their ownership. It is NOT guessed.
   *
   * The previous implementation guessed: match the shop domain against the caller's store rows,
   * else claim an unclaimed placeholder, else CREATE A NEW STORE. Every read path resolves the
   * caller's first store (store.service.ts) and the app has no store switcher, so that last
   * branch filed the connection against a row nothing could ever display. Connecting a second
   * shop therefore "succeeded" in a way the merchant could never see: Shopify redirected back
   * with shopify=connected and the banner said so, while the Integrations panel, the catalogue
   * card and every audit run kept reporting Not Connected — all three reading the OTHER row.
   *
   * getCurrentStoreId is the same tenancy seam those reads use, and it is scoped to stores this
   * user owns, so it also re-verifies the signed id rather than trusting it. Passing `undefined`
   * (a state token minted before this change) resolves exactly what the install would have signed.
   */
  const storeId = await getCurrentStoreId(statePayload.sub, statePayload.storeId);

  const tokens = await exchangeCodeForToken(shop, code);

  // Prove the token actually works, and take the shop's identity from Shopify rather than
  // inferring it from the domain. If this fails, the connection is NOT recorded — a store must
  // never be shown as "Connected" on the strength of a token we never successfully used.
  const client = new ShopifyClient({ shopDomain: shop, accessToken: tokens.accessToken });
  const identity = await fetchShopIdentity(client);

  const [existingConnection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shop)).limit(1);

  /**
   * The connection row this install should reuse, or null when it must create a fresh one.
   *
   * Null after a LAPSED claim is released below — the shop then follows the same path as a shop
   * Rankvora AI has never seen, which is what files it against the new owner's own store instead of
   * leaving it on someone else's.
   */
  let connectionToReuse: typeof shopifyConnections.$inferSelect | null = existingConnection ?? null;

  if (existingConnection) {
    // The shop_domain unique index means one myshopify domain maps to exactly one store.
    const [owningStore] = await db.select().from(stores).where(eq(stores.id, existingConnection.storeId)).limit(1);
    const ownedByCaller = Boolean(owningStore) && owningStore!.ownerId === statePayload.sub;

    if (!ownedByCaller) {
      /**
       * ─── A live claim is a real conflict; an uninstalled one is not ──
       *
       * If the other account's connection is still installed, two Rankvora AI accounts genuinely want
       * the same shop and handing it over silently would take a working store away from whoever
       * set it up. That is refused, as before.
       *
       * But an UNINSTALLED connection is a claim that has already lapsed. The merchant removed
       * Rankvora AI from that shop's admin, so the stored token is dead and the row does nothing
       * except block the shop forever — including from the same person signing up again. Nothing
       * cleared it: handleAppUninstalled only stamps `uninstalledAt`, and this check never read
       * that column, so "uninstall, then reconnect from a new account" was impossible.
       *
       * The stale row is therefore released. What is NOT released is the previous owner's data:
       * their `stores` row and every audit under it stay exactly where they are. They lose a
       * Shopify connection they had already removed themselves — nothing more.
       */
      if (!existingConnection.uninstalledAt) {
        throw new ApiError(409, 'This Shopify store is already connected to a different Rankvora AI account', 'SHOPIFY_SHOP_ALREADY_CLAIMED');
      }

      // Only the credential row goes. `stores` is the parent of this FK, so deleting a connection
      // cannot cascade into the previous owner's store or its audits.
      await db.delete(shopifyConnections).where(eq(shopifyConnections.id, existingConnection.id));

      if (owningStore) {
        // Their Integrations page must stop showing a connection that no longer exists, and say
        // why in words a merchant can act on.
        await db
          .update(integrations)
          .set({
            status: 'not_connected',
            accountDetail: null,
            lastSyncedAt: null,
            notice: 'This shop was reconnected from a different Rankvora AI account. Your previous audits are unchanged.',
          })
          .where(and(eq(integrations.storeId, owningStore.id), eq(integrations.provider, 'shopify')));
      }

      console.log(`[scorelo-api] shopify: released lapsed claim on ${shop} (was store ${existingConnection.storeId}, uninstalled ${existingConnection.uninstalledAt.toISOString()})`);
      connectionToReuse = null;
    }
  }

  /**
   * One shop per store. The Integrations page only offers Connect when the store has no live
   * connection, so reaching this with a different shop already installed means a stale tab or a
   * hand-made request — and silently swapping the merchant's store out from under them (renaming
   * it, re-pointing its URL, leaving its audits describing a shop it no longer names) is worse
   * than refusing. Disconnect is the explicit way to replace a store.
   */
  const [liveOnTarget] = await db
    .select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  if (liveOnTarget && liveOnTarget.shopDomain !== shop) {
    throw new ApiError(
      409,
      'This workspace is already connected to a different Shopify store — disconnect it first',
      'SHOPIFY_STORE_ALREADY_CONNECTED',
    );
  }

  if (connectionToReuse) {
    await db
      .update(shopifyConnections)
      .set({
        // Follows the store the merchant connected FROM. A row can sit on one of their other
        // store rows — including one the old guess-a-store code created and nothing can display —
        // and re-pointing it is what makes reconnecting from that page actually take effect.
        storeId,
        accessTokenEncrypted: encryptToken(tokens.accessToken),
        refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        scope: tokens.scope,
        shopGid: identity.gid,
        // Clears the uninstall stamp: this IS the reinstall. Keyed off connectionToReuse rather
        // than existingConnection, because a released claim leaves the latter pointing at a row
        // that has just been deleted.
        uninstalledAt: null,
        // The previous read belongs to wherever this row used to live; it is re-established by
        // the next sync rather than carried across.
        lastSyncSummary: null,
        lastSyncError: null,
      })
      .where(eq(shopifyConnections.id, connectionToReuse.id));

    if (connectionToReuse.storeId !== storeId) {
      // The row it moved off must stop claiming a connection it no longer holds.
      await db
        .update(integrations)
        .set({ status: 'not_connected', accountDetail: null, lastSyncedAt: null, notice: null })
        .where(and(eq(integrations.storeId, connectionToReuse.storeId), eq(integrations.provider, 'shopify')));
      console.log(`[scorelo-api] shopify: moved ${shop} from store ${connectionToReuse.storeId} to store ${storeId}`);
    }
  } else {
    await db.insert(shopifyConnections).values({
      storeId,
      shopDomain: shop,
      accessTokenEncrypted: encryptToken(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      scope: tokens.scope,
      shopGid: identity.gid,
    });
  }

  /**
   * Fill the workspace from the shop Shopify just confirmed: name, primary storefront URL, country,
   * currency and timezone — all of it, not only the name. A plain reconnect still never overwrites
   * a value the merchant edited in Settings; see store-profile.service.ts for the rule.
   */
  await applyShopifyFacts(storeId, factsFromShop({
    shopDomain: shop,
    name: identity.name,
    primaryUrl: identity.primaryUrl,
    country: identity.country,
    currency: identity.currencyCode,
    timezone: identity.ianaTimezone,
  }));

  await db
    .insert(integrations)
    .values({ storeId, provider: 'shopify', status: 'connected', accountDetail: shop, lastSyncedAt: null })
    // Insert, or update the row that already holds this (store_id, provider) — the unique index
    // integrations_store_provider_idx.
    //
    // lastSyncedAt is deliberately NOT stamped here: authorizing is not syncing, and stamping it
    // would show "Last synced: just now" for a store whose data has never been read.
    .onConflictDoUpdate({
      target: [integrations.storeId, integrations.provider],
      set: { status: 'connected', accountDetail: shop, notice: null },
    });

  /**
   * Records the connection in the bell, so the store's integration history reads as one thread:
   * connected here, authorization expired later, uninstalled after that — rather than only ever
   * the failures, with nothing saying when the connection it lost had started.
   *
   * NOT deduped, unlike the failure notifications around it. `dedupeMinutes` keys on
   * (store, type) alone, and `integration_alert` is also what a failed sync and an expired token
   * write — so a window here would let this suppress a genuine alert, or be suppressed by one.
   * Duplicates are not a real risk: an OAuth code is single-use, so a replayed callback fails at
   * the token exchange and never reaches this line.
   */
  await createNotification({
    storeId,
    type: 'integration_alert',
    title: 'Shopify store connected',
    message: `Rankvora AI is now connected to ${shop}. Run a sync from Integrations to read your store data.`,
    tone: 'success',
    // The message names the next action — running a sync — so the link is where that button is.
    link: NOTIFICATION_LINKS.integrations,
  });

  // app/uninstalled is not registered here: shopify.app.toml declares it for every install, and a
  // second, shop-specific subscription would deliver each uninstall twice.

  console.log(`[scorelo-api] shopify: installation completed for ${shop} (store ${storeId})`);
  return { shopDomain: shop, storeId };
}

/**
 * Revokes Rankvora AI's side of the connection. Historical audits are deliberately preserved — they
 * are the merchant's own analysis history, and deleting them is a data-retention decision, not a
 * side effect of disconnecting.
 */
export async function disconnectShopify(storeId: number): Promise<void> {
  const [connection] = await db
    .select()
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);

  if (connection) {
    // The token row is dropped entirely rather than flagged: once disconnected we have no reason
    // to keep a live Admin API credential for that shop.
    await db.delete(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
    console.log(`[scorelo-api] shopify: store disconnected (store ${storeId})`);
  }

  await db
    .update(integrations)
    .set({ status: 'not_connected', accountDetail: null, lastSyncedAt: null, notice: null })
    .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, 'shopify')));
}
