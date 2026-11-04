import { createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrations, shopifyConnections, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { encryptToken } from '../lib/crypto.js';
import {
  signShopifyLoginGrant,
  signShopifyLoginState,
  verifyShopifyLoginGrant,
  verifyShopifyLoginState,
} from '../lib/jwt.js';
import type { RequestMetadata } from '../lib/requestMetadata.js';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { fetchShopIdentity, fetchShopOwner, type ShopIdentity } from '../audit-engine/store-data/shopify.queries.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  missingScopes,
  requireConfigured,
  verifyCallbackHmac,
  type TokenResponse,
} from './shopify-oauth.service.js';
import { NOTIFICATION_LINKS, createNotification } from './notification.service.js';
import { completeExternalSignIn } from './auth.service.js';
import { applyShopifyFacts, factsFromShop } from './store-profile.service.js';

/**
 * ─── Sign in with Shopify ────────────────────────────────────────────
 *
 * The shop IS the identity. A merchant proves who they are by approving Rankvora AI on Shopify's own
 * authorization screen, which Shopify only shows to someone signed in to that shop's admin. Rankvora AI
 * never sees or stores a password for this route.
 *
 *   start      the browser sends a shop (typed, or delivered signed by Shopify) and a nonce hash
 *   authorize  Shopify authenticates the merchant and redirects to the shared callback
 *   callback   the code is exchanged, the token proven against the Admin API, and the shop resolved
 *              to an account — the existing one, or a new one created from Shopify's own records
 *   complete   the starting browser redeems a two-minute grant with its raw nonce for a session
 *
 * WHICH ACCOUNT A SHOP OPENS. A shop Rankvora AI already holds a connection for signs in to the account
 * that owns that store — including a connection left behind by an uninstall, because reinstalling
 * the same shop is the same merchant coming back to the same audit history. A shop Rankvora AI has never
 * seen gets a new account.
 *
 * HOW A SHOP IS RECOGNISED. By what Shopify says it is, not by what was typed: the `shop` on the
 * callback is covered by Shopify's signature, and the shop's own id (`gid://shopify/Shop/…`) is read
 * from the Admin API with the token just issued. In order:
 *   1. the connection stored for that myshopify domain (a domain recorded against a DIFFERENT shop
 *      id is refused — the address now belongs to another shop);
 *   2. else the connection stored for that shop id, which finds a shop whose myshopify address was
 *      renamed — the stable id is the identity, the address is only a label;
 *   3. else a store whose last Shopify-verified read named this domain but whose connection row is
 *      gone (Shopify's shop/redact webhook deletes it ~48h after an uninstall), so a merchant who
 *      comes back later reopens their own store instead of dead-ending or getting a second one.
 * Only when none of them know the shop is an account created.
 *
 * ACCOUNTS ARE NEVER LINKED BY EMAIL. A shop owner controls the email address on their shop, so
 * attaching a shop to whichever Rankvora AI account already uses that address would let anyone who can
 * edit a store's settings walk into someone else's account. That case is refused, and the merchant
 * is told to contact support.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** The encrypted credential columns, shared by the insert and update paths so the two can never
 * store a token pair differently. */
function tokenColumns(tokens: TokenResponse) {
  return {
    accessTokenEncrypted: encryptToken(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scope: tokens.scope,
  };
}

// ─── Start ───────────────────────────────────────────────────────────

/** The authorization URL for a shop the merchant typed on Rankvora AI's sign-in page. */
export function beginShopifyLogin(shop: string, nonce: string): string {
  requireConfigured();
  return buildAuthorizeUrl(shop, signShopifyLoginState(shop, hashNonce(nonce)));
}

/**
 * The authorization URL for a shop Shopify delivered — the merchant opened Rankvora AI from the App
 * Store or from the Apps list in their admin, so nothing was typed at all.
 *
 * The query is trusted only after its HMAC verifies. No freshness window is applied: replaying an
 * old launch link does nothing but show Shopify's own authorization screen again, which Shopify
 * still guards with the merchant's admin session.
 */
export function beginShopifyLaunch(launch: Record<string, string>, nonce: string): string {
  requireConfigured();
  if (!verifyCallbackHmac(launch)) {
    throw new ApiError(401, 'This link from Shopify could not be verified. Open Rankvora AI from your Shopify admin again.', 'SHOPIFY_HMAC_INVALID');
  }
  const shop = launch.shop;
  if (typeof shop !== 'string' || !SHOP_DOMAIN.test(shop)) {
    throw new ApiError(400, 'This link from Shopify did not name a store.', 'SHOPIFY_LAUNCH_INVALID');
  }
  return beginShopifyLogin(shop, nonce);
}

// ─── Callback ────────────────────────────────────────────────────────

/**
 * Completes Shopify's side of sign-in and returns the grant the frontend redeems.
 *
 * Nothing is recorded until the token has been exchanged AND used successfully against the Admin
 * API — the same rule the Integrations connect flow follows, so a shop is never attached to an
 * account on the strength of a token that was never proven to work.
 */
export async function handleShopifyLoginCallback(query: Record<string, unknown>): Promise<string> {
  requireConfigured();

  if (!verifyCallbackHmac(query)) throw new ApiError(401, 'Invalid Shopify OAuth signature', 'SHOPIFY_HMAC_INVALID');

  const shop = String(query.shop);
  const code = String(query.code);

  let state;
  try {
    state = verifyShopifyLoginState(String(query.state));
  } catch {
    throw new ApiError(401, 'Invalid or expired OAuth state', 'SHOPIFY_STATE_INVALID');
  }
  if (state.shop !== shop) throw new ApiError(401, 'OAuth state does not match shop', 'SHOPIFY_STATE_MISMATCH');

  const tokens = await exchangeCodeForToken(shop, code);

  // A store approved without every permission could not be audited or fixed, so it opens nothing.
  const missing = missingScopes(tokens.scope);
  if (missing.length > 0) {
    throw new ApiError(403, `Shopify did not grant: ${missing.join(', ')}`, 'SHOPIFY_SCOPES_MISSING');
  }

  const client = new ShopifyClient({ shopDomain: shop, accessToken: tokens.accessToken });
  const userId = await establishShopAccount(shop, tokens, client);

  return signShopifyLoginGrant(userId, state.nonceHash);
}

/**
 * Turns a token Shopify has just issued for `shop` into the account that owns the shop, and returns
 * that account's id.
 *
 * Both ways in end here — the redirect sign-in above, and the embedded app's token exchange
 * (shopify-embedded.service.ts) — so a shop is recognised, reinstalled and created by one set of
 * rules whichever door the merchant came through. The caller has already proved the token works;
 * what this adds is reading the shop's identity with it and deciding which account that identity is.
 */
export async function establishShopAccount(shop: string, tokens: TokenResponse, client: ShopifyClient): Promise<number> {
  const identity = await fetchShopIdentity(client);

  const [byDomain] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shop)).limit(1);
  // The id lookup only matters when the address is unknown: an address we hold is answered by step 1.
  const byGid = byDomain
    ? []
    : await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopGid, identity.gid)).orderBy(asc(shopifyConnections.id));

  const match = matchConnection(byDomain, byGid, identity.gid);
  if (match.kind === 'mismatch') {
    console.warn(`[scorelo-api] shopify: sign-in refused — ${shop} is on file for a different Shopify shop id`);
    throw new ApiError(
      409,
      'This store address is on file for a different Shopify store. Contact support to sort out which store it belongs to.',
      'SHOPIFY_STORE_MISMATCH',
    );
  }

  if (match.kind === 'match') {
    return signInToKnownShop({ connection: match.connection }, shop, tokens, identity);
  }

  const remembered = await findRememberedStore(shop);
  return remembered
    ? signInToKnownShop({ store: remembered }, shop, tokens, identity)
    : createAccountForShop(shop, tokens, identity, client);
}

type Connection = typeof shopifyConnections.$inferSelect;
type StoreRow = typeof stores.$inferSelect;

/**
 * Which stored connection, if any, is the shop that just authenticated. Pure, so the rule can be
 * tested without a database.
 *
 * `byDomain` is the row for the myshopify address on the callback; `byGid` the rows holding the
 * shop's Shopify id. A row with no id yet (connected before ids were recorded) is accepted by its
 * address and gets the id on this sign-in; a row WITH a different id is a different shop.
 */
export function matchConnection(
  byDomain: Connection | undefined,
  byGid: Connection[],
  gid: string,
): { kind: 'match'; connection: Connection } | { kind: 'mismatch' } | { kind: 'none' } {
  if (byDomain) {
    return byDomain.shopGid && byDomain.shopGid !== gid ? { kind: 'mismatch' } : { kind: 'match', connection: byDomain };
  }
  // Several rows for one shop id can only come from a renamed address reconnected under its new
  // name. The installed one is the live relationship; else the oldest.
  const connection = byGid.find((row) => row.uninstalledAt === null) ?? byGid[0];
  return connection ? { kind: 'match', connection } : { kind: 'none' };
}

/**
 * The store whose last Shopify-verified read (`stores.shopify_profile`) named this domain and which
 * has no connection row at all — what shop/redact leaves behind. Null when there is none.
 *
 * More than one is refused rather than guessed: two stores both claiming a shop with no connection
 * between them means nobody can say whose it is from the data alone.
 */
export async function findRememberedStore(shop: string): Promise<StoreRow | null> {
  const rows = await db
    .select({ store: stores })
    .from(stores)
    .leftJoin(shopifyConnections, eq(shopifyConnections.storeId, stores.id))
    .where(and(
      isNull(shopifyConnections.id),
      // json_extract returns the text itself, unquoted.
      sql`json_extract(${stores.shopifyProfile}, '$.shopDomain') = ${shop}`,
    ))
    .orderBy(asc(stores.id));

  if (rows.length > 1) {
    console.warn(`[scorelo-api] shopify: sign-in refused — ${rows.length} stores remember ${shop} and none holds its connection`);
    throw new ApiError(
      409,
      'More than one Rankvora AI workspace remembers this store. Contact support to choose which one to reopen.',
      'SHOPIFY_LOGIN_UNAVAILABLE',
    );
  }
  return rows[0]?.store ?? null;
}

/**
 * Signs in to the account that already owns this shop, and brings its connection up to date with
 * the token Shopify just issued.
 *
 * Two ways the shop is known: by a stored CONNECTION (the normal case, including one left behind by
 * an uninstall or under a renamed address), or only by a STORE that remembers it after shop/redact
 * removed the connection row — then the connection is written again, on that same store, so the
 * audit history the merchant left is still attached to it.
 */
async function signInToKnownShop(
  known: { connection: Connection } | { store: StoreRow },
  shop: string,
  tokens: TokenResponse,
  identity: ShopIdentity,
): Promise<number> {
  const connection = 'connection' in known ? known.connection : null;

  const store = 'store' in known
    ? known.store
    : (await db.select().from(stores).where(eq(stores.id, known.connection.storeId)).limit(1))[0];
  // The foreign key makes this unreachable; refusing is still better than guessing an account.
  if (!store) throw new ApiError(409, 'This Shopify store could not be matched to a Rankvora AI account.', 'SHOPIFY_LOGIN_UNAVAILABLE');

  const reinstalled = connection === null || connection.uninstalledAt !== null;

  if (connection) {
    // The token Shopify just issued is newer than the stored one and has been proven to work, so it
    // replaces it. That also recovers a connection whose authorization had expired. The address is
    // written too: found by the shop's id, it may have been renamed since it was stored.
    await db
      .update(shopifyConnections)
      .set({ ...tokenColumns(tokens), shopDomain: shop, shopGid: identity.gid, uninstalledAt: null })
      .where(eq(shopifyConnections.id, connection.id));
  } else {
    await db.insert(shopifyConnections).values({ storeId: store.id, shopDomain: shop, shopGid: identity.gid, ...tokenColumns(tokens) });
  }

  await db
    .insert(integrations)
    .values({ storeId: store.id, provider: 'shopify', status: 'connected', accountDetail: shop, lastSyncedAt: null })
    .onConflictDoUpdate({ target: [integrations.storeId, integrations.provider], set: { status: 'connected', accountDetail: shop, notice: null } });

  // Signing in is a fresh read of the shop, so the workspace picks up anything changed in Shopify
  // since — without touching a value the merchant edited in Settings.
  await applyShopifyFacts(store.id, factsFromShop({
    shopDomain: shop,
    name: identity.name,
    primaryUrl: identity.primaryUrl,
    country: identity.country,
    currency: identity.currencyCode,
    timezone: identity.ianaTimezone,
  }));

  if (reinstalled) {
    // The app/uninstalled subscription is declared in shopify.app.toml, so it survives a reinstall
    // on its own and nothing is registered here.
    await createNotification({
      storeId: store.id,
      type: 'integration_alert',
      title: 'Shopify store reconnected',
      message: `Rankvora AI is connected to ${shop} again. Run a sync from Integrations to read your latest store data.`,
      tone: 'success',
      link: NOTIFICATION_LINKS.integrations,
    });
    console.log(`[scorelo-api] shopify: sign-in reinstalled ${shop} (store ${store.id}${connection ? '' : ', connection restored after shop/redact'})`);
  }

  return store.ownerId;
}

/**
 * Opens a Rankvora AI account for a shop Rankvora AI has never seen.
 *
 * Every value written comes from Shopify. What Shopify did not report is left as the schema's
 * explicit "Unspecified" rather than a plausible default, and the owner's name is left empty when
 * Shopify does not share it — the merchant can add it in Settings, and an empty name is honest
 * where a made-up one is not.
 *
 * The account holds no credential at all — no password, no second factor — so there is nothing to
 * hash, reset or recover. The merchant signs in with Shopify, and only with Shopify.
 *
 * Exported for tests only (tests/d1-transactions.test.ts drives it with a stand-in Shopify client);
 * the app reaches it through completeShopifyLogin.
 */
export async function createAccountForShop(
  shop: string,
  tokens: TokenResponse,
  identity: ShopIdentity,
  client: ShopifyClient,
): Promise<number> {
  const owner = await fetchShopOwner(client);
  const email = (owner.email ?? identity.contactEmail)?.trim().toLowerCase() || null;

  if (!email) {
    throw new ApiError(422, 'Shopify did not share an email address for this store, so a Rankvora AI account cannot be created for it.', 'SHOPIFY_LOGIN_NO_EMAIL');
  }

  // Ignoring case: an address saved in Settings as "Ada@x.com" is the same inbox as Shopify's
  // "ada@x.com". `email` is already lower-cased above.
  const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (taken) {
    throw new ApiError(
      409,
      'A Rankvora AI account already uses this store’s email address. Contact support to connect this store to that account.',
      'SHOPIFY_LOGIN_EMAIL_TAKEN',
    );
  }

  // The same facts, built the same way, as the Connect flow and every later refresh — and
  // recorded, so the first refresh can tell these values from a merchant's later edit.
  const facts = factsFromShop({
    shopDomain: shop,
    name: identity.name,
    primaryUrl: identity.primaryUrl,
    country: identity.country,
    currency: identity.currencyCode,
    timezone: identity.ianaTimezone,
  });

  // One batch — D1's transaction: an account without its store, or a store without its
  // connection, is a half-built signup nothing could ever display or repair. All four rows are
  // written, or none.
  //
  // A batch cannot hand one statement's new id to the next in code, so each later statement finds
  // it in SQL, inside the same batch: the account by its email (unique, and just written exactly as
  // given), and the store as that brand-new account's newest — in fact only — store.
  const newUserId = sql<number>`(SELECT ${users.id} FROM ${users} WHERE ${users.email} = ${email})`;
  const newStoreId = sql<number>`(SELECT MAX(${stores.id}) FROM ${stores} WHERE ${stores.ownerId} = ${newUserId})`;
  const [createdUser, createdStore] = await db.batch([
    db.insert(users).values({ fullName: owner.name ?? '', email }).returning({ id: users.id }),
    db.insert(stores).values({
      ownerId: newUserId,
      workspaceName: facts.name ?? '',
      name: facts.name ?? '',
      // The shop's primary storefront — its custom domain when it has one — not only the
      // myshopify address, so the audit and Settings name the store the way shoppers reach it.
      url: facts.url ?? '',
      platform: 'Shopify',
      // Not something Shopify knows. Guided setup asks for it.
      industry: 'Unspecified',
      country: facts.country ?? 'Unspecified',
      timezone: facts.timezone ?? 'Unspecified',
      currency: facts.currency ?? 'Unspecified',
      shopifyProfile: facts,
    }).returning({ id: stores.id }),
    db.insert(shopifyConnections).values({ storeId: newStoreId, shopDomain: shop, shopGid: identity.gid, ...tokenColumns(tokens) }),
    db.insert(integrations).values({ storeId: newStoreId, provider: 'shopify', status: 'connected', accountDetail: shop, lastSyncedAt: null }),
  ]);
  const userId = createdUser[0]?.id;
  const storeId = createdStore[0]?.id;
  if (!userId || !storeId) throw new Error('shopify sign-in: the account and store were not saved');

  await createNotification({
    storeId,
    type: 'integration_alert',
    title: 'Shopify store connected',
    message: `Rankvora AI is now connected to ${shop}. Run a sync from Integrations to read your store data.`,
    tone: 'success',
    link: NOTIFICATION_LINKS.integrations,
  });

  console.log(`[scorelo-api] shopify: sign-in created an account for ${shop} (user ${userId}, store ${storeId})`);
  return userId;
}

// ─── Complete ────────────────────────────────────────────────────────

/**
 * Exchanges the grant for a session — only in the browser that started the sign-in.
 *
 * Every failure is the same 401: an expired grant, a forged one and a nonce from another browser
 * are indistinguishable from outside.
 */
export async function completeShopifyLogin(grant: string, nonce: string, metadata: RequestMetadata) {
  const rejected = () =>
    new ApiError(401, 'This Shopify sign-in has expired. Please start again.', 'SHOPIFY_LOGIN_INVALID');

  let payload;
  try {
    payload = verifyShopifyLoginGrant(grant);
  } catch {
    throw rejected();
  }

  const expected = Buffer.from(payload.nonceHash, 'hex');
  const presented = createHash('sha256').update(nonce).digest();
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    console.warn(`[scorelo-auth] shopify sign-in rejected: nonce mismatch (user ${payload.sub})`);
    throw rejected();
  }

  return completeExternalSignIn(payload.sub, metadata);
}
