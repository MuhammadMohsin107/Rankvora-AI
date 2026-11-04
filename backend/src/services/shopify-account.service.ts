import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrations, shopifyConnections, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { encryptToken } from '../lib/crypto.js';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { fetchShopIdentity, fetchShopOwner, type ShopIdentity } from '../audit-engine/store-data/shopify.queries.js';
import type { TokenResponse } from './shopify-oauth.service.js';
import { NOTIFICATION_LINKS, createNotification } from './notification.service.js';
import { applyShopifyFacts, factsFromShop } from './store-profile.service.js';

/**
 * ─── A shop becomes an account ───────────────────────────────────────
 *
 * The shop IS the identity. Shopify only opens an app for someone who is signed in to that shop's
 * admin, and the ID token that open carries proves it (shopify-embedded.service.ts), so a shop that
 * arrives with a working token has been authenticated by Shopify itself. This file turns that shop
 * into the account that owns it — the existing one, or a new one created from Shopify's own records.
 * Nothing here sees, asks for or stores a password: the account holds no credential.
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

/**
 * Turns a token Shopify has just issued for `shop` into the account that owns the shop, and returns
 * that account's id.
 *
 * The embedded app's token exchange (shopify-embedded.service.ts) ends here, so a shop is recognised,
 * reinstalled and created by one set of rules. The caller has already proved the token works; what
 * this adds is reading the shop's identity with it and deciding which account that identity is.
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
 * the app reaches it through establishShopAccount.
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
