import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { callbackQuerySchema } from '../schemas/shopify.schema.js';
import { buildInstallUrl, disconnectShopify, handleShopifyCallback } from '../services/shopify-oauth.service.js';
import { getShopifyStatus, syncShopifyStore } from '../services/shopify-sync.service.js';
import { getCurrentStoreId } from '../services/store.service.js';
import { adminAppUrl } from '../services/shopify-embedded.service.js';
import { describeError, logValue } from '../lib/logger.js';
import {
  handleAppScopesUpdate,
  handleAppUninstalled,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  verifyWebhookHmac,
} from '../services/shopify-webhook.service.js';

/**
 * Returns the Shopify authorization URL for the caller to navigate to.
 *
 * It returns JSON rather than a 302 on purpose. Rankvora AI authenticates with a bearer token in the
 * Authorization header, and a top-level browser navigation cannot send one — so a redirect
 * endpoint behind `authenticate` would 401 every merchant who clicked Connect. The client fetches
 * this with its token, then sets window.location to the returned URL.
 *
 * The URL is built server-side and carries a signed state nonce, so the client cannot influence
 * which user, which app or which scopes the authorization is for.
 */
export async function getInstall(req: Request, res: Response) {
  const userId = requireUserId(req);
  const shop = String(req.query.shop);
  // Resolved HERE, through the same seam GET /shopify/status reads, and signed into the OAuth
  // state so the callback attaches the connection to the store the merchant is actually looking
  // at — rather than picking one for itself once the merchant is no longer in the request.
  const storeId = await getCurrentStoreId(userId, optionalStoreId(req));
  // Quoted: `shop` is the caller's query string, and a raw newline in it could forge a log line.
  console.log(`[scorelo-api] shopify: installation started for ${logValue(shop)} (user ${userId}, store ${storeId})`);
  res.json({ data: { url: buildInstallUrl(userId, storeId, shop) } });
}

/** A shop domain taken from the callback's query, kept only when it has the shape of a real one. */
function plainShop(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : null;
}

/** A reason Shopify itself reported on the redirect (`?error=`), kept only when it is a plain token —
 * it is written into a URL the merchant's browser keeps. */
function reportedReason(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'failed';
}

/**
 * Where the merchant's browser lands after the OAuth round trip, with an outcome the Integrations
 * page reads. `reason` is a stable code, never a raw error message.
 *
 * The merchant left the Shopify admin to reach Shopify's permission screen, so they come back to the
 * app INSIDE their admin (the bare site has no session and nothing to show outside the admin's
 * iframe). With no shop to name, it returns to the site as it always did.
 */
function frontendReturn(outcome: 'connected' | 'failed' | 'cancelled', reason?: string, shop?: string | null): string {
  const url = shop && env.shopifyApiKey ? new URL(adminAppUrl(shop, '/integrations')) : new URL('/integrations', env.frontendUrl);
  url.searchParams.set('shopify', outcome);
  if (reason) url.searchParams.set('reason', reason);
  return url.toString();
}

/**
 * Shopify redirects the merchant's BROWSER here after they approve — or decline — the permissions
 * Rankvora AI asks for when connecting a store from Integrations or granting access it was missing. Every
 * outcome has to end in a page rather than a JSON error; failures redirect back to Integrations with a
 * code the UI turns into merchant-readable wording, and nothing is marked connected unless
 * handleShopifyCallback succeeded.
 *
 * This is NOT how a merchant signs in: inside the Shopify admin the shop is identified by its ID token
 * (middleware/authenticate.ts), and the callback only attaches a store to a session that already exists
 * — through the signed `state` made when the merchant pressed Connect.
 */
export async function getCallback(req: Request, res: Response) {
  const shop = plainShop(req.query.shop);

  // The merchant declined the permission screen. Not an error — say so plainly.
  if (typeof req.query.error === 'string') {
    const cancelled = req.query.error === 'access_denied';
    console.log(`[scorelo-api] shopify: installation ${cancelled ? 'cancelled by merchant' : 'rejected'} (${logValue(req.query.error)}) rid=${req.requestId ?? '-'}`);
    return res.redirect(frontendReturn(cancelled ? 'cancelled' : 'failed', reportedReason(req.query.error), shop));
  }

  const parsed = callbackQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    console.warn(`[scorelo-api] shopify: callback rejected — malformed query rid=${req.requestId ?? '-'}`);
    return res.redirect(frontendReturn('failed', 'invalid_callback', shop));
  }

  try {
    await handleShopifyCallback(req.query as Record<string, unknown>);
    return res.redirect(frontendReturn('connected', undefined, parsed.data.shop));
  } catch (error) {
    const reason = error instanceof ApiError ? error.code ?? 'connect_failed' : 'connect_failed';
    // The underlying error, not only the code. Anything that is not an ApiError — a database
    // failure, Shopify not answering — was logged as the bare word "connect_failed", which said an
    // install had failed and nothing about why.
    console.warn(`[scorelo-api] shopify: installation failed — ${reason} (${describeError(error)})`);
    return res.redirect(frontendReturn('failed', reason, shop));
  }
}

/** Connection state for the current store. Contains no token, in any form. */
export async function getStatus(req: Request, res: Response) {
  const userId = requireUserId(req);
  res.json({ data: await getShopifyStatus(userId, optionalStoreId(req)) });
}

export async function postSync(req: Request, res: Response) {
  const userId = requireUserId(req);
  res.json({ data: await syncShopifyStore(userId, optionalStoreId(req)) });
}

export async function postDisconnect(req: Request, res: Response) {
  const userId = requireUserId(req);
  // Resolve through the tenancy seam so a caller can only ever disconnect their own store.
  const resolvedStoreId = await getCurrentStoreId(userId, optionalStoreId(req));
  await disconnectShopify(resolvedStoreId);
  res.json({ data: await getShopifyStatus(userId, resolvedStoreId) });
}

function verifyWebhookOrThrow(req: Request) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  if (!req.rawBody || typeof hmacHeader !== 'string' || !verifyWebhookHmac(req.rawBody, hmacHeader)) {
    throw new ApiError(401, 'Invalid Shopify webhook signature', 'SHOPIFY_WEBHOOK_HMAC_INVALID');
  }
  if (typeof shopDomain !== 'string') throw new ApiError(400, 'Missing shop domain header', 'SHOPIFY_WEBHOOK_MISSING_SHOP');
  return shopDomain;
}

export async function postWebhookAppUninstalled(req: Request, res: Response) {
  const shopDomain = verifyWebhookOrThrow(req);
  await handleAppUninstalled(shopDomain);
  res.status(200).send();
}

export async function postWebhookAppScopesUpdate(req: Request, res: Response) {
  const shopDomain = verifyWebhookOrThrow(req);
  await handleAppScopesUpdate(shopDomain, req.body);
  res.status(200).send();
}

export async function postWebhookCustomersDataRequest(req: Request, res: Response) {
  const shopDomain = verifyWebhookOrThrow(req);
  await handleCustomersDataRequest(shopDomain);
  res.status(200).send();
}

export async function postWebhookCustomersRedact(req: Request, res: Response) {
  const shopDomain = verifyWebhookOrThrow(req);
  await handleCustomersRedact(shopDomain);
  res.status(200).send();
}

export async function postWebhookShopRedact(req: Request, res: Response) {
  const shopDomain = verifyWebhookOrThrow(req);
  await handleShopRedact(shopDomain);
  res.status(200).send();
}
