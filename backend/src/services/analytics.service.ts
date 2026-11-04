import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { googleConnections } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { rangeEndingWithLag as reportingRange } from './reporting-window.js';
import {
  clearGoogleRefusal,
  getGoogleConnection,
  getProviderRow,
  getValidGoogleAccessToken,
  grantsAnalytics,
  markIntegrationStatus,
  markIntegrationSynced,
  providerHealth,
  upsertIntegrationRow,
  type GoogleConnection,
} from './google-oauth.service.js';

/**
 * ─── Google Analytics 4 · reading real data ──────────────────────────
 *
 * Every number here came from Google in the request that produced it. No cached sample, no seeded
 * row, no fallback: a store with no connection reports `connected: false`, and a property with no
 * traffic reports zeroes that are genuinely zero.
 *
 * WHY GA4 IS WORTH READING ALONGSIDE SEARCH CONSOLE, given both are Google and both are about
 * traffic: Search Console ends at the click. It knows which query was searched, which page was
 * shown and where it ranked — and nothing at all about what happened next. GA4 starts there: did
 * the visit engage, which landing page took it, did it convert. A page can rank well, earn the
 * click, and lose the visitor immediately, and Search Console reports that as a success.
 *
 * ─── Two APIs, because they answer different questions ───────────────
 *   Admin API   which properties may this account read      analyticsadmin.googleapis.com
 *   Data API    what did that property record               analyticsdata.googleapis.com
 *
 * The Data API cannot enumerate properties, so without the Admin API the merchant would have to
 * paste a numeric id by hand — and a typo would silently report another company's traffic. Both
 * must be enabled on the Cloud project or the first call 403s with SERVICE_DISABLED.
 *
 * ─── The lag is real and is not hidden ───────────────────────────────
 * GA4 finalises data on roughly a 24-48 hour delay. Ranges here end two days back and the dates
 * actually used are returned, rather than quietly requesting today and presenting the partial tail
 * as a collapse in traffic. Same rule, and the same reason, as DATA_LAG_DAYS in
 * search-console.service.ts.
 */

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
export const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';

/**
 * GA4 finalises data on roughly a one-to-two day delay. Ending a range at "today" returns rows
 * that are still filling in, which reads as a sudden drop rather than as absent data.
 */
const DATA_LAG_DAYS = 2;

/** Rows per report. Well inside Google's 250,000 ceiling — this feeds a card, not an export. */
const ROW_LIMIT = 100;

export interface AnalyticsProperty {
  /** Numeric id, e.g. `498211037`. `properties/` is not part of it. */
  propertyId: string;
  displayName: string;
  /** The Analytics account the property sits under, so two similarly named ones stay tellable apart. */
  account: string;
}

export interface AnalyticsTotals {
  sessions: number;
  engagedSessions: number;
  /** Engagement rate as a fraction (0.0432 = 4.32%), exactly as Google returns it. */
  engagementRate: number;
  conversions: number;
}

export interface AnalyticsRow {
  key: string;
  sessions: number;
  engagedSessions: number;
  conversions: number;
}

export interface AnalyticsPerformance {
  propertyId: string;
  /** The dates actually queried, so the UI never implies a range Google did not answer for. */
  startDate: string;
  endDate: string;
  totals: AnalyticsTotals;
  topLandingPages: AnalyticsRow[];
  topChannels: AnalyticsRow[];
}

export interface AnalyticsStatus {
  /** Whether the SERVER has Google OAuth credentials at all. */
  configured: boolean;
  /** Whether THIS store has a live Google connection. */
  connected: boolean;
  /**
   * Whether that connection's grant actually carries the GA4 scope.
   *
   * Separate from `connected` because a grant made before GA4 support existed is a real, working
   * Search Console connection that simply cannot read Analytics. Collapsing the two would either
   * hide a working connection or offer a button that 403s.
   */
  scopeGranted: boolean;
  googleEmail: string | null;
  propertyId: string | null;
  /**
   * When Google last answered a GA4 read for this store. Null = never. Analytics' OWN read time, from
   * its integrations row — not the shared connection's, which a Search Console read also moves.
   */
  lastSyncedAt: string | null;
  /** Why the last GA4 read failed, or why the Google grant itself is unusable. See providerHealth(). */
  lastError: string | null;
}

/**
 * The window this service asks GA4 for, ending DATA_LAG_DAYS back.
 *
 * Shared with Search Console — see reporting-window.ts for why a `days`-day window is `days - 1`
 * wide. This used to subtract a full `days`, so every GA4 figure covered one day more than its
 * label claimed.
 */
export function rangeEndingWithLag(days: number): { startDate: string; endDate: string } {
  return reportingRange(days, DATA_LAG_DAYS);
}

/**
 * One authorised call to an Analytics API.
 *
 * Google's errors arrive as JSON with a message that can name the property and the account, so the
 * body is never surfaced to the caller — a 403 here usually means the connected account cannot read
 * that property, or that the API was never enabled on the Cloud project, and both are worth saying
 * plainly without echoing whatever Google chose to include.
 */
export async function callApi<T>(connection: GoogleConnection, url: string, body?: unknown): Promise<T> {
  const accessToken = await getValidGoogleAccessToken(connection);

  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    const reason = response.status === 401
      ? 'Reconnect Google to continue.'
      : 'That Google account cannot read this Analytics property, or the Analytics APIs are not enabled for this server.';
    if (response.status === 401) {
      // The token itself was rejected. That is the GRANT failing, and Search Console reads through the
      // same token — so it is recorded on the shared connection, where providerHealth() reports it for
      // both providers.
      await db
        .update(googleConnections)
        .set({ lastError: reason })
        .where(eq(googleConnections.id, connection.id));
    }
    // Recorded against Analytics alone. A 403 is this provider's problem — no access to this property,
    // or the API not enabled — and says nothing about Search Console or Shopify. Written to the shared
    // connection, it used to appear under Search Console as well.
    await markIntegrationStatus(connection.storeId, 'analytics', 'needs_attention', reason);
    throw new ApiError(response.status, reason, 'GA4_ACCESS_DENIED');
  }

  if (!response.ok) {
    console.error(`[scorelo-google] Analytics API returned HTTP ${response.status}`);
    throw new ApiError(502, 'Google Analytics could not be reached. Try again shortly.', 'GA4_UNAVAILABLE');
  }

  return (await response.json()) as T;
}

/**
 * The store's connection, refusing early when it cannot serve Analytics.
 *
 * The scope check is here rather than at each call site so a grant that predates GA4 support can
 * never reach Google and come back as an opaque 403.
 */
export async function requireAnalyticsConnection(storeId: number): Promise<GoogleConnection> {
  const connection = await getGoogleConnection(storeId);
  if (!connection) {
    throw new ApiError(409, 'Connect Google first.', 'GOOGLE_NOT_CONNECTED');
  }
  if (!grantsAnalytics(connection)) {
    throw new ApiError(
      409,
      'This Google connection was made before Analytics access was added. Reconnect Google to grant it.',
      'GA4_SCOPE_MISSING',
    );
  }
  return connection;
}

interface AccountSummariesResponse {
  accountSummaries?: Array<{
    displayName?: string;
    propertySummaries?: Array<{ property?: string; displayName?: string }>;
  }>;
  nextPageToken?: string;
}

/**
 * The GA4 properties this Google account can read.
 *
 * Returned so the merchant CHOOSES. An agency account routinely has dozens, and picking one
 * automatically would silently report another client's traffic as this store's — a wrong number
 * presented with total confidence, which is the one failure mode this integration must not have.
 *
 * Paged to exhaustion rather than taking the first page: an account with more properties than fit
 * in one response would otherwise find its property simply missing from the list, with nothing
 * saying why.
 */
export async function listAnalyticsProperties(storeId: number): Promise<AnalyticsProperty[]> {
  const connection = await requireAnalyticsConnection(storeId);

  const properties: AnalyticsProperty[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${ADMIN_BASE}/accountSummaries`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const data = await callApi<AccountSummariesResponse>(connection, url.toString());

    for (const account of data.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        // `property` arrives as "properties/498211037"; the bare id is what is stored and what
        // the request path is rebuilt from.
        const propertyId = property.property?.replace(/^properties\//, '');
        if (!propertyId) continue;
        properties.push({
          propertyId,
          displayName: property.displayName ?? propertyId,
          account: account.displayName ?? 'Unknown account',
        });
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  // Google just answered for Analytics, which proves the grant works and the Analytics APIs are
  // enabled — so a refusal recorded earlier no longer describes the connection. Cleared WITHOUT
  // stamping a read time: listing properties is not reading a report, and "Working" is reserved for
  // a store where one was actually read.
  await clearGoogleRefusal(storeId, 'analytics');

  return properties;
}

/** Records which property this store reports on. Verified against the account's own list first. */
export async function selectAnalyticsProperty(storeId: number, propertyId: string): Promise<void> {
  const properties = await listAnalyticsProperties(storeId);
  // THE AUTHORIZATION ANCHOR: a property the connected account cannot read is not selectable, so a
  // request body cannot point this store at an arbitrary company's Analytics.
  if (!properties.some((property) => property.propertyId === propertyId)) {
    throw new ApiError(400, 'That property is not available on the connected Google account.', 'GA4_PROPERTY_INVALID');
  }

  await db
    .update(googleConnections)
    .set({ ga4PropertyId: propertyId, lastError: null })
    .where(eq(googleConnections.storeId, storeId));

  // The display row the Integrations catalogue reads. Written here rather than only on connect,
  // because the property is what the card names — and because nothing wrote an `analytics` row at
  // all until now, which is why the catalogue reported "Not connected" beside a card showing live
  // Analytics data.
  const chosen = properties.find((property) => property.propertyId === propertyId);
  await upsertIntegrationRow(storeId, 'analytics', 'connected', chosen?.displayName ?? propertyId);
}

interface ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface ReportResponse {
  rows?: ReportRow[];
}

/**
 * One metric off a row, as a number.
 *
 * GA4 returns EVERY metric as a string, counts included — `"1483"`, not `1483` — so the parse is
 * not optional. An absent row is a real zero: a property with no traffic in the window returns no
 * rows at all rather than rows of zeroes, and that is a genuine figure, not a failed read.
 */
function metric(row: ReportRow | undefined, index: number): number {
  const parsed = Number(row?.metricValues?.[index]?.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function runReport(
  connection: GoogleConnection,
  propertyId: string,
  range: { startDate: string; endDate: string },
  dimension: string | null,
): Promise<ReportResponse> {
  return callApi<ReportResponse>(
    connection,
    // The property id is part of the PATH and is encoded for the same reason the Search Console
    // site id is — it is caller-influenced, even though the shape is validated upstream.
    `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      ...(dimension ? { dimensions: [{ name: dimension }] } : {}),
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'engagementRate' },
        { name: 'conversions' },
      ],
      limit: dimension ? ROW_LIMIT : 1,
    },
  );
}

function toRows(response: ReportResponse): AnalyticsRow[] {
  return (response.rows ?? []).map((row) => ({
    key: row.dimensionValues?.[0]?.value ?? '',
    sessions: metric(row, 0),
    engagedSessions: metric(row, 1),
    conversions: metric(row, 3),
  }));
}

/**
 * Real GA4 performance for the store's selected property.
 *
 * Three calls, because GA4 aggregates per request: one un-dimensioned call for the true totals, one
 * by landing page, one by acquisition channel. Summing the dimensioned rows instead would
 * MISREPORT the totals — GA4 collapses high-cardinality dimensions into an `(other)` bucket and
 * applies its own thresholding, so the grouped rows deliberately do not add up. Deriving the
 * headline figure from them would quietly under-report the store's traffic, which is the same trap
 * getSearchConsolePerformance() avoids with withheld queries.
 */
export async function getAnalyticsPerformance(storeId: number, days = 28): Promise<AnalyticsPerformance> {
  const connection = await requireAnalyticsConnection(storeId);
  if (!connection.ga4PropertyId) {
    throw new ApiError(409, 'Choose which Analytics property this store reports on.', 'GA4_PROPERTY_NOT_SELECTED');
  }

  const range = rangeEndingWithLag(days);
  const propertyId = connection.ga4PropertyId;

  const [totalsResponse, landingResponse, channelResponse] = await Promise.all([
    runReport(connection, propertyId, range, null),
    runReport(connection, propertyId, range, 'landingPagePlusQueryString'),
    runReport(connection, propertyId, range, 'sessionDefaultChannelGroup'),
  ]);

  const total = totalsResponse.rows?.[0];

  await db
    .update(googleConnections)
    .set({ lastSyncedAt: new Date(), lastError: null })
    .where(eq(googleConnections.id, connection.id));
  await markIntegrationSynced(storeId, 'analytics');

  return {
    propertyId,
    startDate: range.startDate,
    endDate: range.endDate,
    // A property with no traffic in the window returns no rows at all. That is a real zero, and it
    // is reported as zero rather than as an error or an empty state that implies a failure.
    totals: {
      sessions: metric(total, 0),
      engagedSessions: metric(total, 1),
      engagementRate: metric(total, 2),
      conversions: metric(total, 3),
    },
    topLandingPages: toRows(landingResponse),
    topChannels: toRows(channelResponse),
  };
}

/**
 * What the Analytics card shows. Never includes a token, encrypted or otherwise.
 *
 * `configured`, `connected` and `scopeGranted` are three separate facts because the card has to say
 * three different things: an unconfigured server should offer no button, a configured one with no
 * connection should offer Connect, and a connection without the Analytics scope should ask for a
 * reconnect rather than presenting a button that fails at Google.
 */
export async function getAnalyticsStatus(storeId: number, configured: boolean): Promise<AnalyticsStatus> {
  const connection = await getGoogleConnection(storeId);
  // Analytics' own read time and refusal, not the shared grant's — see providerHealth(). Read off the
  // connection row, a Search Console read showed Analytics as freshly synced.
  const health = providerHealth(connection, connection ? await getProviderRow(storeId, 'analytics') : null);

  return {
    configured,
    connected: Boolean(connection),
    scopeGranted: Boolean(connection && grantsAnalytics(connection)),
    googleEmail: connection?.googleEmail ?? null,
    propertyId: connection?.ga4PropertyId ?? null,
    lastSyncedAt: health.lastSyncedAt,
    lastError: health.lastError,
  };
}
