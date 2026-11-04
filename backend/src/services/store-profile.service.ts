import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopifyConnections, stores, users } from '../db/schema.js';
import { fetchShopIdentity } from '../audit-engine/store-data/shopify.queries.js';
import { resolveShopifyClient } from '../audit-engine/store-data/index.js';
import { INDUSTRY_OPTIONS } from './onboarding-signals.js';
import { findCurrentStore } from './store.service.js';
import { ApiError } from '../middleware/error.js';

/**
 * ─── Workspace & store · filled from the connected shop ──────────────
 *
 * The store record's identity — name, storefront URL, country, currency, timezone — comes from
 * Shopify, read from the connected shop itself. It is filled in when the shop is connected or
 * used to sign in, refreshed on every sync, audit and completed guided setup, and can be edited
 * by hand at any time. Editing is optional; nothing asks the merchant to type what Shopify knows.
 *
 * ─── A HAND EDIT IS NEVER OVERWRITTEN ────────────────────────────────
 * What Shopify reported last is kept on the row (`stores.shopify_profile`). A field is refreshed
 * only when it still holds that last-reported value — i.e. nobody changed it — or holds nothing
 * real at all. A value the merchant typed differs from what Shopify said, and is left alone;
 * the Settings page shows Shopify's value beside it with a way to switch back.
 *
 * ─── NOTHING HERE IS INVENTED ────────────────────────────────────────
 * A field Shopify does not report stays as it is. Industry is not a Shopify field at all, so it is
 * never filled from here — the merchant chooses it, in guided setup or Settings.
 */

/** What Shopify reported for a shop, as last read. Stored on the store row. */
export interface ShopifyStoreFacts {
  /** The myshopify domain the facts were read from — a different shop means different facts. */
  shopDomain: string;
  name: string | null;
  /** The shop's primary storefront origin: its custom domain when it has one. */
  url: string | null;
  /** Shopify's billing-address country name, e.g. "Pakistan". */
  country: string | null;
  /** ISO 4217 code, e.g. "PKR". */
  currency: string | null;
  /** IANA zone, e.g. "Asia/Karachi". */
  timezone: string | null;
  readAt: string;
}

/** The store columns this service fills. */
export type ProfileField = 'workspaceName' | 'name' | 'url' | 'country' | 'currency' | 'timezone';

type ProfileRow = Pick<typeof stores.$inferSelect, ProfileField | 'shopifyProfile'>;

/** Builds the facts from anything that carries a shop's identity — the OAuth read or a snapshot. */
export function factsFromShop(
  shop: {
    shopDomain: string;
    name: string | null;
    primaryUrl: string | null;
    country: string | null;
    currency: string | null;
    timezone: string | null;
  },
  readAt: Date = new Date(),
): ShopifyStoreFacts {
  const clean = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    shopDomain: shop.shopDomain,
    name: clean(shop.name),
    // The shop's own primary domain, else its myshopify address — both are Shopify's answer.
    url: clean(shop.primaryUrl) ?? (shop.shopDomain ? `https://${shop.shopDomain}` : null),
    country: clean(shop.country),
    currency: clean(shop.currency),
    timezone: clean(shop.timezone),
    readAt: readAt.toISOString(),
  };
}

/** Narrows the JSON column, which the driver returns as `unknown`. A malformed value is no facts. */
export function storedFacts(raw: unknown): ShopifyStoreFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.shopDomain !== 'string' || typeof value.readAt !== 'string') return null;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  return {
    shopDomain: value.shopDomain,
    name: text('name'),
    url: text('url'),
    country: text('country'),
    currency: text('currency'),
    timezone: text('timezone'),
    readAt: value.readAt,
  };
}

/**
 * Values that hold nothing real, and so may always be filled.
 *
 * Empty and 'Unspecified' are the honest "not known" states. The rest are what earlier builds
 * wrote before a shop was connected — a stand-in name, example.com, a UTC timezone and the first
 * entries of hand-written option lists — and were never Shopify's answer or the merchant's.
 */
function holdsNothingReal(field: ProfileField, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'Unspecified' || trimmed === 'Not connected') return true;
  switch (field) {
    case 'name':
      return trimmed === 'My store';
    case 'url':
      return trimmed === 'https://example.com';
    case 'timezone':
      // "(UTC+05:00) Karachi" — the old hand-written list's format. Shopify reports an IANA zone.
      return /^\(UTC[+-]\d{2}:\d{2}\) /.test(trimmed);
    case 'currency':
      // "USD — US Dollar" — the old hand-written list's format. Shopify reports an ISO code.
      return /^[A-Z]{3} — /.test(trimmed);
    default:
      return false;
  }
}

/** Which fact each column is filled from. The workspace is named after the shop. */
const FACT_FOR: Record<ProfileField, keyof Omit<ShopifyStoreFacts, 'shopDomain' | 'readAt'>> = {
  workspaceName: 'name',
  name: 'name',
  url: 'url',
  country: 'country',
  currency: 'currency',
  timezone: 'timezone',
};

/**
 * Which store columns to update from a fresh read, and to what.
 *
 * A column is updated only when Shopify reported a value AND one of these holds:
 *   · the column holds nothing real (see holdsNothingReal);
 *   · it still equals what Shopify reported last time — nobody edited it;
 *   · it equals the connection's own myshopify address, which Rankvora AI wrote at connect time;
 *   · the facts on file are for a DIFFERENT shop, so the old values describe a store that is no
 *     longer connected (hand-edited workspace names excepted: the organisation has not changed).
 *
 * `defaultWorkspaceName` is the name signup generates from the owner's own name. Until the merchant
 * changes it, the shop's name is the better workspace name, and replaces it.
 */
export function planProfileUpdate(
  current: ProfileRow,
  next: ShopifyStoreFacts,
  defaultWorkspaceName: string | null,
): Partial<Record<ProfileField, string>> {
  const previous = storedFacts(current.shopifyProfile);
  const sameShop = previous?.shopDomain === next.shopDomain;
  const updates: Partial<Record<ProfileField, string>> = {};

  for (const field of Object.keys(FACT_FOR) as ProfileField[]) {
    const fact = next[FACT_FOR[field]];
    if (fact === null) continue; // Shopify did not say. The column keeps what it has.

    const value = current[field] ?? '';
    if (value === fact) continue;

    const untouched =
      holdsNothingReal(field, value)
      || (previous !== null && sameShop && value === previous[FACT_FOR[field]])
      || (field === 'url' && value === `https://${next.shopDomain}`)
      || (field === 'workspaceName' && defaultWorkspaceName !== null && value === defaultWorkspaceName)
      || (previous !== null && !sameShop && field !== 'workspaceName');

    if (untouched) updates[field] = fact;
  }

  return updates;
}

/** The name signup gives a workspace, from its owner's name. */
function signupWorkspaceName(fullName: string | null | undefined): string | null {
  const name = fullName?.trim();
  return name ? `${name}'s workspace` : null;
}

/**
 * Applies a fresh read of the connected shop to its store record, and remembers what Shopify said.
 *
 * Safe to call on every sync and audit: it writes only columns nobody edited, and records the facts
 * either way so the next call can tell an edit from a stale value.
 */
export async function applyShopifyFacts(storeId: number, facts: ShopifyStoreFacts): Promise<Partial<Record<ProfileField, string>>> {
  const [row] = await db
    .select({
      workspaceName: stores.workspaceName,
      name: stores.name,
      url: stores.url,
      country: stores.country,
      currency: stores.currency,
      timezone: stores.timezone,
      shopifyProfile: stores.shopifyProfile,
      ownerName: users.fullName,
    })
    .from(stores)
    .innerJoin(users, eq(users.id, stores.ownerId))
    .where(eq(stores.id, storeId))
    .limit(1);
  if (!row) return {};

  const updates = planProfileUpdate(row, facts, signupWorkspaceName(row.ownerName));
  await db
    .update(stores)
    // A connected shop is a Shopify store — a fact, not a choice, so it is set every time.
    .set({ ...updates, platform: 'Shopify', shopifyProfile: facts })
    .where(eq(stores.id, storeId));
  return updates;
}

/**
 * Reads the connected shop now and applies it — the "Refresh from Shopify" button.
 *
 * A live read rather than the last audit's, so a change the merchant has just made in Shopify is
 * what they see.
 */
export async function refreshStoreProfile(userId: number, storeId?: number) {
  const store = await findCurrentStore(userId, storeId);
  const [connection] = await db
    .select({ shopDomain: shopifyConnections.shopDomain })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, store.id), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  if (!connection) {
    throw new ApiError(400, 'Connect your Shopify store first — these details are read from it.', 'STORE_NOT_CONNECTED');
  }
  const identity = await fetchShopIdentity(await resolveShopifyClient(store.id));
  await applyShopifyFacts(store.id, factsFromShop({
    shopDomain: connection.shopDomain,
    name: identity.name,
    primaryUrl: identity.primaryUrl,
    country: identity.country,
    currency: identity.currencyCode,
    timezone: identity.ianaTimezone,
  }));
  return findCurrentStore(userId, store.id);
}

/**
 * The choices the Workspace page offers for industry — the same list guided setup uses, from the
 * one place it is defined, so the two pages cannot offer different vocabularies for one column.
 */
export function profileOptions() {
  return { industries: INDUSTRY_OPTIONS };
}
