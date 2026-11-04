import type { Request, Response } from 'express';
import { env, googleConfigured } from '../config/env.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';
import { getCurrentStoreId } from '../services/store.service.js';
import { buildGoogleAuthUrl, disconnectGoogle, handleGoogleCallback } from '../services/google-oauth.service.js';
import { verifyGoogleState } from '../lib/jwt.js';
import { adminAppUrl, findShopForStore } from '../services/shopify-embedded.service.js';
import {
  getSearchConsolePerformance,
  getSearchConsoleStatus,
  listSearchConsoleSites,
  selectSearchConsoleSite,
} from '../services/search-console.service.js';
import {
  getAnalyticsPerformance,
  getAnalyticsStatus,
  listAnalyticsProperties,
  selectAnalyticsProperty,
} from '../services/analytics.service.js';

/**
 * ─── Google Search Console endpoints ─────────────────────────────────
 *
 * Every handler except the callback resolves the store with getCurrentStoreId(), which scopes to
 * stores the caller owns — so a storeId in a query string can never point a connection, a property
 * selection or a data read at somebody else's store.
 *
 * The callback is the one unauthenticated route, by necessity: Google redirects a browser to it
 * and carries no Rankvora AI session. Its identity comes entirely from the signed `state`, which is
 * why that state is a JWT rather than a random string kept in memory.
 */

/** Returns the consent URL rather than redirecting, so the SPA controls the navigation. */
export async function getGoogleAuthUrl(req: Request, res: Response) {
  const userId = requireUserId(req);
  const storeId = await getCurrentStoreId(userId, optionalStoreId(req));
  // Only the one known word is honoured; anything else is the ordinary Integrations flow.
  const returnTo = req.query.returnTo === 'onboarding' ? 'onboarding' : undefined;
  res.json({ data: { url: buildGoogleAuthUrl(userId, storeId, returnTo) } });
}

/**
 * What the SIGNED state says: which store the merchant started from, and which in-app page to go
 * back to.
 *
 * Read before the code is exchanged so a failure returns them to the same place they started —
 * guided setup shows the outcome in step 4 rather than dropping them on Integrations mid-flow. A
 * state that does not verify has no trustworthy origin: null, and the caller uses the defaults.
 */
function readState(state: unknown): ReturnType<typeof verifyGoogleState> | null {
  if (typeof state !== 'string') return null;
  try {
    return verifyGoogleState(state);
  } catch {
    return null;
  }
}

/**
 * Where Google sends the merchant's browser back to.
 *
 * ALWAYS REDIRECTS TO THE APP, success or failure. This is a browser navigation, not an API call —
 * returning JSON here would leave the merchant staring at a raw payload on a backend domain. The
 * outcome travels as a query parameter the Integrations page reads and then strips, which is the
 * same pattern the Shopify callback already uses.
 */
export async function getGoogleCallback(req: Request, res: Response) {
  const state = readState(req.query.state);
  const path = state?.returnTo === 'onboarding' ? '/onboarding' : '/integrations';

  // The merchant left the Shopify admin to reach Google, so they come back to the app INSIDE it: the
  // bare site has no session of its own and nothing to show outside the admin's iframe. A store with
  // no installed shop (local development, mock sign-in) returns to the site as it always did.
  const shop = state && env.shopifyApiKey ? await findShopForStore(state.storeId) : null;
  const target = new URL(shop ? adminAppUrl(shop, path) : `${env.frontendUrl.replace(/\/+$/, '')}${path}`);

  try {
    await handleGoogleCallback(req.query as Record<string, unknown>);
    target.searchParams.set('google', 'connected');
  } catch (error) {
    // The code, never the message: Google's text can name the account and the property, and this
    // lands in a URL the merchant's browser history keeps.
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'GOOGLE_FAILED';
    target.searchParams.set('google', 'failed');
    target.searchParams.set('reason', code);
  }

  res.redirect(target.toString());
}

export async function getGoogleStatus(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await getSearchConsoleStatus(storeId, googleConfigured()) });
}

/** The properties the connected Google account can read, for the merchant to choose from. */
export async function getGoogleSites(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await listSearchConsoleSites(storeId) });
}

/** Records which property this store reports on. Verified against the account's own list. */
export async function postGoogleSite(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  await selectSearchConsoleSite(storeId, req.body.siteUrl);
  res.json({ data: await getSearchConsoleStatus(storeId, googleConfigured()) });
}

/** Live search performance. Every number comes from Google in this request. */
export async function getGooglePerformance(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const days = typeof req.query.days === 'number' ? req.query.days : 28;
  res.json({ data: await getSearchConsolePerformance(storeId, days) });
}

export async function postGoogleDisconnect(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  await disconnectGoogle(storeId);
  res.json({ data: await getSearchConsoleStatus(storeId, googleConfigured()) });
}

/**
 * ─── Google Analytics 4 ──────────────────────────────────────────────
 *
 * The SAME connection as Search Console — one consent, one token pair, two APIs — so there is no
 * separate connect or disconnect here. What differs is that a grant made before the Analytics
 * scope existed cannot read GA4, which the service checks rather than letting Google answer with
 * an opaque 403.
 */

export async function getGa4Status(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await getAnalyticsStatus(storeId, googleConfigured()) });
}

/** The GA4 properties the connected account can read, for the merchant to choose from. */
export async function getGa4Properties(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  res.json({ data: await listAnalyticsProperties(storeId) });
}

/** Records which property this store reports on. Verified against the account's own list. */
export async function postGa4Property(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  await selectAnalyticsProperty(storeId, req.body.propertyId);
  res.json({ data: await getAnalyticsStatus(storeId, googleConfigured()) });
}

/** Live GA4 performance. Every number comes from Google in this request. */
export async function getGa4Performance(req: Request, res: Response) {
  const storeId = await getCurrentStoreId(requireUserId(req), optionalStoreId(req));
  const days = typeof req.query.days === 'number' ? req.query.days : 28;
  res.json({ data: await getAnalyticsPerformance(storeId, days) });
}
