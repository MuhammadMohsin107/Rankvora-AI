import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { googleConnections } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { precedingRange, rangeEndingWithLag as reportingRange } from './reporting-window.js';
import {
  clearGoogleRefusal,
  getGoogleConnection,
  getProviderRow,
  getValidGoogleAccessToken,
  markIntegrationStatus,
  markIntegrationSynced,
  providerHealth,
  upsertIntegrationRow,
  type GoogleConnection,
} from './google-oauth.service.js';

/**
 * ─── Google Search Console · reading real data ───────────────────────
 *
 * Every number this service returns came from Google in the request that produced it. There is no
 * cached sample, no seeded row and no fallback: a store with no connection gets `connected: false`
 * and a store whose property has no traffic gets zeroes that are genuinely zero.
 *
 * WHY SEARCH CONSOLE IS WORTH CONNECTING AT ALL, given the audit already reads Shopify: everything
 * else Rankvora AI measures is what the store PUBLISHES — titles, descriptions, structured data. This
 * is the only source for what actually happened: which queries brought people in, how often pages
 * were shown, and where they ranked. A meta description can be perfect and still earn no clicks,
 * and nothing in the Shopify catalogue can tell you that.
 *
 * THE THREE-DAY LAG IS REAL AND IS NOT HIDDEN. Search Console finalises data on a delay, so a
 * range ending today is usually empty at the tail. Ranges here end three days back, and the dates
 * actually used are returned, rather than quietly requesting today and presenting the gap as a
 * collapse in traffic.
 */

const API_BASE = 'https://www.googleapis.com/webmasters/v3';

/**
 * Search Console finalises data on roughly a two-to-three day delay. Ending a range at "today"
 * returns rows that are still filling in, which reads as a sudden drop rather than as absent data.
 */
const DATA_LAG_DAYS = 3;

/** Rows per query. Well inside Google's 25,000 ceiling — this feeds a dashboard, not an export. */
const ROW_LIMIT = 100;

export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchConsoleTotals {
  clicks: number;
  impressions: number;
  /** Click-through rate as a fraction (0.0432 = 4.32%), exactly as Google returns it. */
  ctr: number;
  /** Average position. Lower is better; 1 is the top result. */
  position: number;
}

export interface SearchConsoleRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchConsolePerformance {
  siteUrl: string;
  /** The dates actually queried, so the UI never implies a range Google did not answer for. */
  startDate: string;
  endDate: string;
  totals: SearchConsoleTotals;
  topQueries: SearchConsoleRow[];
  topPages: SearchConsoleRow[];
}

/**
 * The window this service asks Search Console for, ending DATA_LAG_DAYS back.
 *
 * Shared with GA4 — see reporting-window.ts for why a `days`-day window is `days - 1` wide. This
 * used to subtract a full `days`, so every Search Console figure covered one day more than its
 * label claimed.
 */
function rangeEndingWithLag(days: number): { startDate: string; endDate: string } {
  return reportingRange(days, DATA_LAG_DAYS);
}

/**
 * One authorised call to the Search Console API.
 *
 * Google's errors arrive as JSON with a message that can name the property and the account, so the
 * body is never surfaced to the caller — a 403 here usually means the connected Google account
 * does not have access to that property, which is worth saying plainly and without echoing
 * whatever Google chose to include.
 */
async function callApi<T>(connection: GoogleConnection, path: string, body?: unknown): Promise<T> {
  const accessToken = await getValidGoogleAccessToken(connection);

  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    const reason = response.status === 401
      ? 'Reconnect Google Search Console to continue.'
      : 'That Google account does not have access to this Search Console property.';
    if (response.status === 401) {
      // The token itself was rejected. That is the GRANT failing, and Analytics reads through the
      // same token — so it is recorded on the shared connection, where providerHealth() reports it
      // for both providers.
      await db
        .update(googleConnections)
        .set({ lastError: reason })
        .where(eq(googleConnections.id, connection.id));
    }
    // Recorded against Search Console alone. A 403 is this provider's problem — the account cannot
    // read this property — and written to the shared connection it used to surface under Analytics
    // as well. Scoped by provider for the older reason too: without it, a Search Console permission
    // problem marked every connector on the store, Shopify included, as needing attention.
    await markIntegrationStatus(connection.storeId, 'search-console', 'needs_attention', reason);
    throw new ApiError(response.status, reason, 'GOOGLE_ACCESS_DENIED');
  }

  if (!response.ok) {
    console.error(`[scorelo-google] Search Console API returned HTTP ${response.status} for ${path}`);
    throw new ApiError(502, 'Google Search Console could not be reached. Try again shortly.', 'GOOGLE_UNAVAILABLE');
  }

  return (await response.json()) as T;
}

/**
 * The properties this Google account can read.
 *
 * Returned so the merchant CHOOSES which one this store reports on. An account often has several
 * verified sites, and picking one automatically would silently report another domain's traffic as
 * this store's — a wrong number presented with total confidence.
 */
export async function listSearchConsoleSites(storeId: number): Promise<SearchConsoleSite[]> {
  const connection = await requireConnection(storeId);
  const data = await callApi<{ siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> }>(
    connection,
    '/sites',
  );
  // Google just answered for Search Console, which proves the grant works and the API is enabled —
  // so a refusal recorded earlier no longer describes the connection. Cleared WITHOUT stamping a read
  // time: listing properties is not reading data, and "Working" is reserved for a store where one was.
  await clearGoogleRefusal(storeId, 'search-console');

  return (data.siteEntry ?? [])
    // A property the account can only see in a restricted role returns no analytics rows, so
    // offering it would produce an empty dashboard with no explanation.
    .filter((entry) => entry.siteUrl && entry.permissionLevel !== 'siteUnverifiedUser')
    .map((entry) => ({ siteUrl: entry.siteUrl!, permissionLevel: entry.permissionLevel ?? 'unknown' }));
}

/** Records which property this store reports on. Verified against the account's own list first. */
export async function selectSearchConsoleSite(storeId: number, siteUrl: string): Promise<void> {
  const sites = await listSearchConsoleSites(storeId);
  // THE AUTHORIZATION ANCHOR: a property the connected account cannot read is not selectable, so a
  // request body cannot point this store at an arbitrary domain.
  if (!sites.some((site) => site.siteUrl === siteUrl)) {
    throw new ApiError(400, 'That property is not available on the connected Google account.', 'GOOGLE_SITE_INVALID');
  }

  await db
    .update(googleConnections)
    .set({ siteUrl, lastError: null })
    .where(eq(googleConnections.storeId, storeId));

  await upsertIntegrationRow(storeId, 'search-console', 'connected', siteUrl);
}

async function requireConnection(storeId: number): Promise<GoogleConnection> {
  const connection = await getGoogleConnection(storeId);
  if (!connection) {
    throw new ApiError(409, 'Connect Google Search Console first.', 'GOOGLE_NOT_CONNECTED');
  }
  return connection;
}

interface QueryResponse {
  rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
}

async function queryDimension(
  connection: GoogleConnection,
  siteUrl: string,
  range: { startDate: string; endDate: string },
  dimension: 'query' | 'page' | null,
): Promise<QueryResponse> {
  return callApi<QueryResponse>(
    // The property id is part of the PATH, so it has to be encoded — `sc-domain:example.com` and
    // `https://example.com/` both contain characters that would otherwise change the route.
    connection,
    `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      startDate: range.startDate,
      endDate: range.endDate,
      ...(dimension ? { dimensions: [dimension] } : {}),
      rowLimit: dimension ? ROW_LIMIT : 1,
      type: 'web',
    },
  );
}

function toRows(response: QueryResponse): SearchConsoleRow[] {
  return (response.rows ?? []).map((row) => ({
    key: row.keys?.[0] ?? '',
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

/**
 * Real search performance for the store's selected property.
 *
 * Three calls, because Search Console aggregates per request: one un-dimensioned call for the true
 * totals, one grouped by query, one grouped by page. Summing the query rows instead would
 * UNDERSTATE clicks — Google withholds low-volume and privacy-sensitive queries, so the grouped
 * rows deliberately do not add up to the total. Deriving the headline number from them would
 * quietly report less traffic than the store actually received.
 */
export async function getSearchConsolePerformance(storeId: number, days = 28): Promise<SearchConsolePerformance> {
  const connection = await requireConnection(storeId);
  if (!connection.siteUrl) {
    throw new ApiError(409, 'Choose which Search Console property this store reports on.', 'GOOGLE_SITE_NOT_SELECTED');
  }

  const range = rangeEndingWithLag(days);

  const [totalsResponse, queriesResponse, pagesResponse] = await Promise.all([
    queryDimension(connection, connection.siteUrl, range, null),
    queryDimension(connection, connection.siteUrl, range, 'query'),
    queryDimension(connection, connection.siteUrl, range, 'page'),
  ]);

  const total = totalsResponse.rows?.[0];

  await recordSuccessfulRead(connection, storeId);

  return {
    siteUrl: connection.siteUrl,
    startDate: range.startDate,
    endDate: range.endDate,
    // A property with no traffic in the window returns no rows at all. That is a real zero, and it
    // is reported as zero rather than as an error or an empty state that implies a failure.
    totals: {
      clicks: total?.clicks ?? 0,
      impressions: total?.impressions ?? 0,
      ctr: total?.ctr ?? 0,
      position: total?.position ?? 0,
    },
    topQueries: toRows(queriesResponse),
    topPages: toRows(pagesResponse),
  };
}

/** Google answered for this property, so the connection is working and its last refusal is stale. */
async function recordSuccessfulRead(connection: GoogleConnection, storeId: number): Promise<void> {
  await db
    .update(googleConnections)
    .set({ lastSyncedAt: new Date(), lastError: null })
    .where(eq(googleConnections.id, connection.id));
  await markIntegrationSynced(storeId, 'search-console');
}

export interface SearchConsoleClicks {
  siteUrl: string;
  /** The dates actually queried, for this window and for the equally long one before it. */
  startDate: string;
  endDate: string;
  clicks: number;
  previousStartDate: string;
  previousEndDate: string;
  previousClicks: number;
}

/**
 * Organic clicks for the last `days` days beside the `days` before them — the dashboard card's two
 * numbers, and nothing else.
 *
 * Two un-dimensioned calls rather than getSearchConsolePerformance twice: that one also asks for the
 * top queries and pages, which a card showing one total has no use for. The totals come from Google's
 * own aggregate (see the note on getSearchConsolePerformance), never from summing rows.
 */
export async function getSearchConsoleClicks(storeId: number, days = 28): Promise<SearchConsoleClicks> {
  const connection = await requireConnection(storeId);
  if (!connection.siteUrl) {
    throw new ApiError(409, 'Choose which Search Console property this store reports on.', 'GOOGLE_SITE_NOT_SELECTED');
  }

  const range = rangeEndingWithLag(days);
  const previous = precedingRange(range);

  const [current, before] = await Promise.all([
    queryDimension(connection, connection.siteUrl, range, null),
    queryDimension(connection, connection.siteUrl, previous, null),
  ]);

  await recordSuccessfulRead(connection, storeId);

  return {
    siteUrl: connection.siteUrl,
    startDate: range.startDate,
    endDate: range.endDate,
    // No rows is a property with no clicks in the window: a real zero, not a failure.
    clicks: current.rows?.[0]?.clicks ?? 0,
    previousStartDate: previous.startDate,
    previousEndDate: previous.endDate,
    previousClicks: before.rows?.[0]?.clicks ?? 0,
  };
}

export interface SearchConsoleStatus {
  configured: boolean;
  connected: boolean;
  googleEmail: string | null;
  siteUrl: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/**
 * What the Integrations page shows. Never includes a token, encrypted or otherwise.
 *
 * `configured` is about the SERVER (are OAuth credentials present at all) and `connected` about
 * this store. They are separate because the page has to say different things: an unconfigured
 * server should not offer a Connect button, while a configured one with no connection should.
 */
export async function getSearchConsoleStatus(storeId: number, configured: boolean): Promise<SearchConsoleStatus> {
  const connection = await getGoogleConnection(storeId);
  // Search Console's own read time and refusal, not the shared grant's — see providerHealth(). Read
  // off the connection row, an Analytics refusal appeared here and a GA4 read marked this as synced.
  const health = providerHealth(connection, connection ? await getProviderRow(storeId, 'search-console') : null);

  return {
    configured,
    connected: Boolean(connection),
    googleEmail: connection?.googleEmail ?? null,
    siteUrl: connection?.siteUrl ?? null,
    lastSyncedAt: health.lastSyncedAt,
    lastError: health.lastError,
  };
}
