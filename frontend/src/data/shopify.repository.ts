import { api, ApiError } from '../lib/api';
import { openOutsideAdmin } from '../lib/embedded';

/**
 * Connection lifecycle as the backend reports it. `connecting` and `syncing` are transient states
 * the UI owns while a request is in flight — they are never persisted, because a state that only
 * exists during a request cannot be recovered by reloading the page.
 */
export type ShopifyStatusValue = 'not_connected' | 'connected' | 'reauthorization_required' | 'error';

export interface ShopifySyncSummary {
  products: number;
  collections: number;
  pages: number;
  articles: number;
  policies: number;
  /** Resource groups the scope limit cut short. */
  truncated: string[];
  /** Resource groups that could not be read at all. */
  unavailable: string[];
  warnings: string[];
  syncedAt: string;
}

export interface ShopifyStatus {
  /** False when the server holds no Shopify app credentials. The UI must not offer Connect. */
  configured: boolean;
  status: ShopifyStatusValue;
  shopDomain: string | null;
  storeName: string | null;
  storeUrl: string | null;
  installedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastSyncSummary: ShopifySyncSummary | null;
  /** Granted scopes. The access token is never part of any API response. */
  scopes: string[];
}

export function fetchShopifyStatus(): Promise<ShopifyStatus> {
  return api.get<ShopifyStatus>('/shopify/status');
}

/**
 * Starts the real Shopify authorization flow.
 *
 * The shop domain is only the ENTRY POINT — it tells Shopify which store's admin to show the
 * permission screen for. Nothing is connected by typing it: the merchant still has to approve the
 * requested scopes in Shopify's own UI, and only Shopify's signed callback creates a connection.
 *
 * The authorization URL is built server-side (it carries a signed state nonce and the app's
 * client id), fetched here with the caller's bearer token, then followed as a top-level
 * navigation because Shopify's consent screen cannot be framed.
 */
export async function beginShopifyInstall(shopDomain: string): Promise<void> {
  const { url } = await api.get<{ url: string }>(`/shopify/install?shop=${encodeURIComponent(shopDomain)}`);
  openOutsideAdmin(url);
}

/** Whether `address` is somewhere only Shopify serves from — the one kind of place the bare site sends anyone. */
export function isShopifyAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && (url.hostname === 'admin.shopify.com' || /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname));
  } catch {
    return false;
  }
}

/**
 * The bare site's way in: the visitor names their store, the server says where Shopify should take them,
 * and the browser goes there. Shopify signs them in and, if Rankvora AI is not installed on that store,
 * asks them to install it; either way it ends with the app open inside their admin, which identifies the
 * shop by its ID token as always. Nothing is signed in or remembered here.
 *
 * The address comes from the server, which builds it from the store handle alone; it is checked once more
 * here so that a page which has somehow been fed another address still never leaves Shopify's domains.
 */
export async function openStoreOnShopify(shop: string): Promise<void> {
  const { url } = await api.post<{ url: string; installed: boolean }>('/shopify/open', { shop });
  if (!isShopifyAddress(url)) throw new ApiError('Unexpected address from the server', 502, 'SHOPIFY_ADDRESS_UNEXPECTED');
  openOutsideAdmin(url);
}

/** Reads the connected store's real data. Throws on failure — there is no silent success. */
export function syncShopifyStore(): Promise<ShopifySyncSummary> {
  return api.post<ShopifySyncSummary>('/shopify/sync');
}

export function disconnectShopify(): Promise<ShopifyStatus> {
  return api.post<ShopifyStatus>('/shopify/disconnect');
}

/** Normalizes what a merchant typed into the `*.myshopify.com` form the backend requires.
 * Accepts a bare handle, a full URL, or the domain itself. Returns null when it cannot. */
export function normalizeShopDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!trimmed) return null;
  const candidate = trimmed.endsWith('.myshopify.com') ? trimmed : `${trimmed}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate) ? candidate : null;
}

/**
 * Merchant-facing wording for the `reason` code the OAuth callback redirects back with.
 * Raw error codes are never shown, and no case falls through to a generic "something went wrong"
 * that leaves the merchant without a next step.
 */
export function describeConnectOutcome(outcome: string | null, reason: string | null): { tone: 'success' | 'error' | 'info'; message: string } | null {
  if (outcome === 'connected') return { tone: 'success', message: 'Shopify store connected. Run a sync to read your store data.' };
  if (outcome === 'cancelled') return { tone: 'info', message: 'Shopify connection was cancelled.' };
  if (outcome !== 'failed') return null;

  switch (reason) {
    case 'SHOPIFY_HMAC_INVALID':
    case 'SHOPIFY_STATE_INVALID':
    case 'SHOPIFY_STATE_MISMATCH':
      return { tone: 'error', message: 'Shopify authorization failed its security check. Please try connecting again.' };
    case 'SHOPIFY_SHOP_ALREADY_CLAIMED':
      return { tone: 'error', message: 'That Shopify store is already connected to a different Rankvora AI account.' };
    case 'SHOPIFY_STORE_ALREADY_CONNECTED':
      return { tone: 'error', message: 'This workspace is already connected to a different Shopify store. Disconnect it first, then connect the new one.' };
    case 'SHOPIFY_NOT_CONFIGURED':
      return { tone: 'error', message: 'Shopify is not configured on this server yet. Contact your administrator.' };
    case 'SHOPIFY_TOKEN_EXCHANGE_FAILED':
      return { tone: 'error', message: 'Shopify authorization failed. Please reconnect your store.' };
    default:
      return { tone: 'error', message: 'Shopify authorization failed. Please reconnect your store.' };
  }
}

/** Turns an API failure into merchant-readable wording without exposing internals. */
export function describeShopifyError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SHOPIFY_NOT_CONFIGURED') return 'Shopify is not configured on this server yet.';
    if (error.code === 'SHOPIFY_REAUTH_REQUIRED') return 'Shopify authorization has expired. Reconnect your store to continue.';
    if (error.code === 'STORE_NOT_CONNECTED') return 'Connect a Shopify store first.';
    // SHOPIFY_SYNC_FAILED already carries merchant-safe wording chosen by the backend.
    if (error.code === 'SHOPIFY_SYNC_FAILED') return error.message;
  }
  return "Shopify is temporarily unavailable. We couldn't complete that request.";
}
