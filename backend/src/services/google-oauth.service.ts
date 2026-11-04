import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { googleConnections, integrations } from '../db/schema.js';
import { env, googleConfigured } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { signGoogleState, verifyGoogleState, type GoogleReturnTo } from '../lib/jwt.js';

/**
 * ─── Google Search Console · OAuth ───────────────────────────────────
 *
 * The authorization-code flow, driven by Rankvora AI rather than by a library, for the same reason the
 * Shopify integration drives its own: the whole exchange is four HTTP calls, and owning them means
 * the token handling is auditable in one file instead of distributed through a vendor SDK.
 *
 * ─── Access scope ────────────────────────────────────────────────────
 *   https://www.googleapis.com/auth/webmasters.readonly
 *
 * READ-ONLY, and that is the entire grant. Google also offers `.../auth/webmasters`, which adds
 * write access — submitting and deleting sitemaps, adding and removing verified properties.
 * Rankvora AI reads search performance and never changes anything in Search Console, so requesting the
 * writable scope would be asking merchants to approve a permission nothing in this codebase uses.
 *
 * ─── Why a refresh token is non-negotiable here ──────────────────────
 * A Google access token lives about an hour. Audits run on a schedule and in background jobs, long
 * after any consent screen is closed, so a connection that cannot renew itself is a connection that
 * works for one hour and then silently reports nothing. `access_type=offline` with
 * `prompt=consent` is what makes Google return one.
 *
 * THE SUBTLETY THAT BREAKS THIS SILENTLY: Google issues a refresh token only on the FIRST consent
 * for a given client. A second authorisation returns an access token alone unless `prompt=consent`
 * forces the screen again — which is why it is always sent, rather than only when convenient.
 *
 * SECURITY: both tokens are AES-256-GCM encrypted before they touch the database, decrypted only
 * for the moment of a request, and never logged, never returned by any API.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Read-only Search Console access. See the header for why the writable scope is not requested.
 *
 * `userinfo.email` is the second entry and earns its place: fetchAccountEmail() below reads the
 * connected account's address so the Integrations page can show WHICH Google account granted
 * access. Without the scope that call 401s, the helper swallows it and returns null, and the card
 * shows a connection with no way to tell whose it is — which matters when a merchant has several
 * Google accounts and needs to know they connected the right one.
 *
 * Adding a scope later is not free: Google issues scopes only on fresh consent, so every existing
 * connection would have to be re-authorised. That is the reason to declare it now rather than when
 * the email is first missed.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

/**
 * Scopes a stored grant must carry before the feature that needs it is offered.
 *
 * A connection made before a scope was added keeps the scopes it was granted — Google issues them
 * only on fresh consent — so `googleConnections.scope` is the truth about what a given token can
 * actually do, and the code that reads GA4 has to ask rather than assume. Without this check the
 * failure is a 403 from Google at read time, which reads as "Analytics is broken" instead of
 * "this connection predates Analytics support; reconnect".
 */
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/** Whether a stored grant actually carries the GA4 read scope. */
export function grantsAnalytics(connection: GoogleConnection): boolean {
  return connection.scope.includes(ANALYTICS_SCOPE);
}

/**
 * Renew slightly BEFORE expiry rather than on it. A token that expires mid-audit fails a request
 * that has already done work, and a minute of margin costs nothing.
 */
const RENEW_MARGIN_MS = 60 * 1000;

export type GoogleConnection = typeof googleConnections.$inferSelect;

function requireConfigured(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!googleConfigured()) {
    throw new ApiError(
      503,
      'Google Search Console is not configured on this server.',
      'GOOGLE_NOT_CONFIGURED',
    );
  }
  return {
    clientId: env.googleClientId!,
    clientSecret: env.googleClientSecret!,
    // Must match the registered redirect URI in Google Cloud character for character.
    redirectUri: `${env.backendUrl!.replace(/\/+$/, '')}/api/google/callback`,
  };
}

/**
 * The URL the merchant is sent to in order to grant access.
 *
 * `state` carries the signed user and store. Google's callback has no signature of its own, so
 * this is the only thing that identifies whose connection is coming back — and the only defence
 * against someone handing Rankvora AI an authorization code to be filed against another store.
 */
export function buildGoogleAuthUrl(userId: number, storeId: number, returnTo?: GoogleReturnTo): string {
  const { clientId, redirectUri } = requireConfigured();

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  // Both are required for a refresh token — see the header. Dropping either produces a connection
  // that works for an hour and then goes quiet.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', signGoogleState(userId, storeId, returnTo));

  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * Posts to Google's token endpoint and returns the parsed body.
 *
 * Google reports OAuth failures as a 400 with an `error` field rather than a transport error, so
 * the body is checked as well as the status — treating a 400 body as a token is how an integration
 * ends up storing the string "invalid_grant" as somebody's credential.
 */
async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || payload.error || !payload.access_token) {
    // Google's own error code only. The request body carries the client secret and must never
    // reach a log line.
    const reason = payload.error_description || payload.error || `HTTP ${response.status}`;
    console.error(`[scorelo-google] token request failed: ${reason}`);
    throw new ApiError(502, 'Google rejected the authorization. Please try connecting again.', 'GOOGLE_TOKEN_FAILED');
  }

  return payload;
}

/** The signed-in Google account's email, so the merchant can see which account is connected. */
async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    // A label, not a credential. Failing to read it must not fail the connection.
    return null;
  }
}

/**
 * Completes the OAuth round trip and stores the connection.
 *
 * REFUSES A GRANT WITH NO REFRESH TOKEN on a first connection. Storing an access-token-only
 * connection would present as "Connected" and stop working within the hour, with nothing in the
 * UI explaining why — the merchant would see empty search data and no error. An existing refresh
 * token is preserved when Google declines to send a new one, which is the legitimate re-consent
 * case.
 */
export async function handleGoogleCallback(query: Record<string, unknown>): Promise<{ storeId: number }> {
  const { clientId, clientSecret, redirectUri } = requireConfigured();

  if (typeof query.error === 'string') {
    // The merchant pressed Cancel on the consent screen. Not an error worth a 500.
    throw new ApiError(400, 'Google access was not granted.', 'GOOGLE_ACCESS_DENIED');
  }

  const code = typeof query.code === 'string' ? query.code : '';
  const state = typeof query.state === 'string' ? query.state : '';
  if (!code || !state) throw new ApiError(400, 'Incomplete response from Google.', 'GOOGLE_CALLBACK_INVALID');

  let payload;
  try {
    payload = verifyGoogleState(state);
  } catch {
    throw new ApiError(401, 'This connection link has expired. Please try again.', 'GOOGLE_STATE_INVALID');
  }

  const tokens = await postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const [existing] = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.storeId, payload.storeId))
    .limit(1);

  // Google returns a refresh token only on first consent. Keeping the stored one when none comes
  // back is what makes re-authorising safe; having neither is what must be refused.
  const refreshToken = tokens.refresh_token ?? null;
  if (!refreshToken && !existing?.refreshTokenEncrypted) {
    throw new ApiError(
      400,
      'Google did not return a renewable connection. Remove Rankvora AI at myaccount.google.com/permissions, then connect again.',
      'GOOGLE_NO_REFRESH_TOKEN',
    );
  }

  const email = await fetchAccountEmail(tokens.access_token!);
  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);

  const values = {
    storeId: payload.storeId,
    googleEmail: email,
    accessTokenEncrypted: encryptToken(tokens.access_token!),
    ...(refreshToken ? { refreshTokenEncrypted: encryptToken(refreshToken) } : {}),
    accessTokenExpiresAt: expiresAt,
    scope: tokens.scope ?? SCOPES,
    lastError: null,
    disconnectedAt: null,
  };

  if (existing) {
    await db.update(googleConnections).set(values).where(eq(googleConnections.id, existing.id));
  } else {
    await db.insert(googleConnections).values(values);
  }

  // The Integrations rows are display state only and are kept in step here, so the page reflects
  // the connection without every reader having to join against the credential table.
  //
  // BOTH providers are written, and Analytics is written from the scope Google ACTUALLY granted
  // rather than from the scopes requested. Re-consenting can return less than was asked for, and a
  // grant made before Analytics support existed carries only the Search Console scope — writing
  // "connected" for Analytics in either case would put a green badge on a connector that cannot
  // read anything.
  const grantedScope = tokens.scope ?? SCOPES;
  await upsertIntegrationRow(payload.storeId, 'search-console', 'connected', email);
  await upsertIntegrationRow(
    payload.storeId,
    'analytics',
    grantedScope.includes(ANALYTICS_SCOPE) ? 'connected' : 'not_connected',
    grantedScope.includes(ANALYTICS_SCOPE) ? email : null,
  );

  console.log(`[scorelo-google] Search Console connected for store ${payload.storeId}`);
  return { storeId: payload.storeId };
}

/**
 * The two providers this one Google grant backs.
 *
 * They are separate `integrations` rows because the Integrations page lists them as separate
 * connectors and they genuinely can differ: a grant made before Analytics support existed is a
 * working Search Console connection and no Analytics connection at all.
 */
export const GOOGLE_PROVIDERS = ['search-console', 'analytics'] as const;
export type GoogleProvider = (typeof GOOGLE_PROVIDERS)[number];

/**
 * Mirrors connection state onto the `integrations` row the Integrations page reads.
 *
 * THE PROVIDER IS PART OF THE KEY, and every write below scopes to it. It did not, and the effect
 * was invisible until two connectors existed: `where(storeId)` alone matches EVERY provider row
 * for the store, so a Search Console 403 quietly marked Shopify as needing attention too. The
 * Shopify service has always scoped its writes this way; these now match.
 */
export async function upsertIntegrationRow(
  storeId: number,
  provider: GoogleProvider,
  status: string,
  accountDetail: string | null,
): Promise<void> {
  await db
    .insert(integrations)
    .values({ storeId, provider, status, accountDetail, lastSyncedAt: null, notice: null })
    // Insert, or update the row that already holds this (store_id, provider): integrations_store_provider_idx.
    //
    // The last read and the recorded refusal are RESET with it. Every caller is a fresh consent, a
    // newly chosen property or a disconnect, and a read or a refusal from before any of those says
    // nothing about the connection as it now stands. Kept, a merchant who reconnected with a
    // different Google account — or picked a different property — would be shown "Working" on the
    // strength of a read the new setup never made.
    .onConflictDoUpdate({ target: [integrations.storeId, integrations.provider], set: { status, accountDetail, lastSyncedAt: null, notice: null } });
}

/**
 * Narrows one provider's status without touching its account detail or creating a row.
 *
 * Used on read failures, where the account is still known and only the health has changed. `notice`
 * records WHY, against this provider alone — see providerHealth() for why that cannot live on the
 * shared connection row. Omitted, any existing notice is left as it is.
 */
export async function markIntegrationStatus(
  storeId: number,
  provider: GoogleProvider,
  status: string,
  notice?: string | null,
): Promise<void> {
  await db
    .update(integrations)
    .set(notice === undefined ? { status } : { status, notice })
    .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, provider)));
}

/** Records a successful read against one provider's row, clearing any refusal it had recorded. */
export async function markIntegrationSynced(storeId: number, provider: GoogleProvider): Promise<void> {
  const readAt = new Date();
  await db
    .insert(integrations)
    .values({ storeId, provider, status: 'connected', accountDetail: null, lastSyncedAt: readAt, notice: null })
    // An upsert, not an update. A connection that chose its property before every path wrote this
    // row would otherwise read real data forever while the update matched nothing — and the page
    // would call it "Not verified" beside live numbers.
    .onConflictDoUpdate({ target: [integrations.storeId, integrations.provider], set: { status: 'connected', lastSyncedAt: readAt, notice: null } });
}

/**
 * Records that Google just answered for this provider, WITHOUT claiming any data was read.
 *
 * Listing the account's properties proves the grant works and the API is enabled, so a refusal
 * recorded earlier — a disabled API, a revoked grant — no longer describes the connection. It does
 * not stamp a read time: no report was read, and "Working" is reserved for a store where one was.
 */
export async function clearGoogleRefusal(storeId: number, provider: GoogleProvider): Promise<void> {
  await db.update(googleConnections).set({ lastError: null }).where(eq(googleConnections.storeId, storeId));
  await db
    .update(integrations)
    .set({ notice: null })
    .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, provider)));
}

export interface ProviderHealth {
  /** When Google last answered a real read FOR THIS PROVIDER. Null = never. */
  lastSyncedAt: string | null;
  /** Why the last read for this provider failed, or why the grant itself is unusable. */
  lastError: string | null;
}

/**
 * The last successful read and the current problem for ONE provider on the shared Google grant.
 *
 * Both used to be read from `google_connections`, which holds one row for BOTH providers. So a
 * Search Console read stamped Analytics as freshly synced, a GA4 permission refusal was shown under
 * Search Console, and a Search Console success erased the Analytics refusal before anyone saw it.
 * They are per provider now:
 *
 *   lastSyncedAt  the provider's own integrations row, written only by markIntegrationSynced() after
 *                 Google answered a read for that provider. PATCH /integrations refuses to write a
 *                 connector-backed provider (integration.service.ts), so no request can forge it.
 *   lastError     the provider's own refusal first; otherwise a problem with the GRANT — revoked, or
 *                 unable to renew — which really does stop both providers.
 */
export function providerHealth(
  connection: Pick<GoogleConnection, 'lastError'> | null,
  row: { lastSyncedAt: Date | null; notice: string | null } | null,
): ProviderHealth {
  // No live connection: whatever the rows remember belongs to a grant that no longer exists.
  if (!connection) return { lastSyncedAt: null, lastError: null };
  return {
    lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    lastError: row?.notice ?? connection.lastError ?? null,
  };
}

/** One provider's display row, for providerHealth(). Null when none has been written yet. */
export async function getProviderRow(
  storeId: number,
  provider: GoogleProvider,
): Promise<{ lastSyncedAt: Date | null; notice: string | null } | null> {
  const [row] = await db
    .select({ lastSyncedAt: integrations.lastSyncedAt, notice: integrations.notice })
    .from(integrations)
    .where(and(eq(integrations.storeId, storeId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}

/** True when the access token is missing, expired, or about to be. */
function needsRefresh(connection: GoogleConnection): boolean {
  if (!connection.accessTokenExpiresAt) return true;
  return connection.accessTokenExpiresAt.getTime() - RENEW_MARGIN_MS <= Date.now();
}

/**
 * Returns a usable access token, renewing it first when necessary.
 *
 * THE ONLY WAY THE REST OF THE APP GETS A TOKEN. Callers never read the encrypted column
 * themselves, so renewal cannot be forgotten at one call site and not another.
 *
 * A refresh rejected by Google is permanent — the merchant revoked access, or the refresh token
 * was expired by inactivity — so the connection is marked as needing attention rather than
 * retried. Retrying a revoked grant produces the same answer forever while hiding the reason.
 */
export async function getValidGoogleAccessToken(connection: GoogleConnection): Promise<string> {
  if (!needsRefresh(connection)) return decryptToken(connection.accessTokenEncrypted);

  if (!connection.refreshTokenEncrypted) {
    await markNeedsAttention(connection.storeId, 'This connection cannot renew itself. Reconnect Google Search Console.');
    throw new ApiError(401, 'Reconnect Google Search Console to continue.', 'GOOGLE_RECONNECT_REQUIRED');
  }

  const { clientId, clientSecret } = requireConfigured();

  let tokens;
  try {
    tokens = await postToken({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptToken(connection.refreshTokenEncrypted),
    });
  } catch {
    await markNeedsAttention(connection.storeId, 'Google refused to renew access. Reconnect Google Search Console.');
    throw new ApiError(401, 'Reconnect Google Search Console to continue.', 'GOOGLE_RECONNECT_REQUIRED');
  }

  const accessToken = tokens.access_token!;
  await db
    .update(googleConnections)
    .set({
      accessTokenEncrypted: encryptToken(accessToken),
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      // Google may rotate the refresh token. When it does, the new one replaces the old.
      ...(tokens.refresh_token ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) } : {}),
      lastError: null,
    })
    .where(eq(googleConnections.id, connection.id));

  return accessToken;
}

/**
 * A refresh that cannot be recovered kills BOTH providers, because both read through the same
 * token. Marking only Search Console would leave Analytics showing green beside a dead grant.
 */
async function markNeedsAttention(storeId: number, reason: string): Promise<void> {
  await db.update(googleConnections).set({ lastError: reason }).where(eq(googleConnections.storeId, storeId));
  for (const provider of GOOGLE_PROVIDERS) {
    await markIntegrationStatus(storeId, provider, 'needs_attention');
  }
}

/** The store's live connection, or null. A disconnected row is not a connection. */
export async function getGoogleConnection(storeId: number): Promise<GoogleConnection | null> {
  const [connection] = await db
    .select()
    .from(googleConnections)
    .where(and(eq(googleConnections.storeId, storeId), isNull(googleConnections.disconnectedAt)))
    .limit(1);
  return connection ?? null;
}

/**
 * Ends the connection.
 *
 * THE TOKENS ARE DESTROYED, not merely marked disconnected. A row that keeps a live refresh token
 * after the merchant pressed Disconnect still holds standing access to their search data, which is
 * not what disconnecting means to the person who pressed it. Rankvora AI's copy is what Rankvora AI can
 * remove; the merchant can also revoke the grant itself at myaccount.google.com/permissions.
 */
export async function disconnectGoogle(storeId: number): Promise<void> {
  await db
    .update(googleConnections)
    .set({
      disconnectedAt: new Date(),
      accessTokenEncrypted: '',
      refreshTokenEncrypted: null,
      accessTokenExpiresAt: null,
      siteUrl: null,
      // Cleared with the tokens: a property id left behind would be re-selected silently on the
      // next connect, which may be a different Google account entirely.
      ga4PropertyId: null,
      lastError: null,
    })
    .where(eq(googleConnections.storeId, storeId));

  // Both, because one grant backed both.
  for (const provider of GOOGLE_PROVIDERS) {
    await upsertIntegrationRow(storeId, provider, 'not_connected', null);
  }
  console.log(`[scorelo-google] Search Console disconnected for store ${storeId}`);
}
