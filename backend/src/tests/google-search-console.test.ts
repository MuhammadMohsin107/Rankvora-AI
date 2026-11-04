import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { signGoogleState, verifyGoogleState, signShopifyState } from '../lib/jwt.js';

/**
 * ─── Google Search Console · what can be proven without Google ───────
 *
 * The OAuth exchange and the analytics reads need a real Google account with a verified property,
 * so they are not faked here — a stub would only prove the stub, and the thing worth proving about
 * this integration is that it never invents a number.
 *
 * What IS provable is the boundary:
 *
 *   · the OAUTH STATE, which is the entire CSRF defence — Google's callback carries no signature
 *     of its own, unlike Shopify's HMAC-signed one
 *   · the SCOPE, checked against the source, because requesting the writable scope by accident is
 *     silent: everything keeps working and merchants are asked to approve more than we use
 *   · the REDACTION invariants, also checked against the source, since a logged refresh token is
 *     a standing key to a merchant's search data
 */

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('oauth state', () => {
  it('round-trips the user and store', () => {
    const token = signGoogleState(42, 7);
    const payload = verifyGoogleState(token);
    assert.equal(payload.sub, 42);
    assert.equal(payload.storeId, 7);
  });

  it('rejects a tampered token', () => {
    // THE ENTIRE CSRF DEFENCE. Google's callback has no signature of its own, so if this were
    // forgeable anyone could hand Rankvora AI an authorization code and have the resulting tokens
    // filed against someone else's store.
    const token = signGoogleState(42, 7);
    const tampered = `${token.slice(0, -4)}AAAA`;
    assert.throws(() => verifyGoogleState(tampered));
  });

  it('rejects a shopify state presented as a google state', () => {
    // Both are signed with the same secret, so only the `type` claim keeps them apart. Without
    // that check a state minted for one integration would authorise the other.
    const shopifyState = signShopifyState(42, 7, 'example.myshopify.com');
    assert.throws(() => verifyGoogleState(shopifyState));
  });

  it('rejects an empty or malformed token', () => {
    assert.throws(() => verifyGoogleState(''));
    assert.throws(() => verifyGoogleState('not-a-jwt'));
  });
});

describe('access scope', () => {
  it('requests read-only Search Console access and nothing more', () => {
    // Google also offers `.../auth/webmasters`, which permits submitting and deleting sitemaps and
    // changing verified properties. Rankvora AI reads and never writes, so requesting it would ask
    // merchants to approve a permission no code path uses — and nothing would fail to reveal it.
    const oauth = source('../services/google-oauth.service.ts');
    assert.ok(
      oauth.includes('https://www.googleapis.com/auth/webmasters.readonly'),
      'the read-only Search Console scope is no longer requested',
    );
    assert.equal(
      /auth\/webmasters'/.test(oauth),
      false,
      'the WRITABLE webmasters scope is being requested — Rankvora AI only reads',
    );
  });

  it('requests read-only Analytics access and nothing more', () => {
    // Google also offers `.../auth/analytics`, which permits editing property configuration,
    // custom dimensions and data streams. Rankvora AI reads reports and never writes, so requesting it
    // would ask merchants to approve a permission no code path uses.
    const oauth = source('../services/google-oauth.service.ts');
    assert.ok(
      oauth.includes('https://www.googleapis.com/auth/analytics.readonly'),
      'the read-only Analytics scope is no longer requested',
    );
    assert.equal(
      /auth\/analytics'/.test(oauth),
      false,
      'the WRITABLE analytics scope is being requested — Rankvora AI only reads',
    );
  });

  it('gates GA4 on the scope the stored grant actually carries', () => {
    // Scopes are issued only on fresh consent, so a connection made before Analytics support
    // exists keeps a token that cannot read GA4. Without this gate the failure is an opaque 403
    // from Google at read time, which reads as "Analytics is broken" rather than "reconnect".
    const analytics = source('../services/analytics.service.ts');
    assert.ok(analytics.includes('grantsAnalytics'), 'GA4 reads no longer check the granted scope');
    assert.ok(analytics.includes('GA4_SCOPE_MISSING'), 'the reconnect-required case is no longer distinguished');
  });

  it('asks for a refresh token explicitly', () => {
    // Without both of these Google returns an access token that dies in an hour, and audits that
    // run in background jobs would silently report nothing.
    const oauth = source('../services/google-oauth.service.ts');
    assert.ok(oauth.includes("'access_type', 'offline'"), 'access_type=offline is no longer sent');
    assert.ok(oauth.includes("'prompt', 'consent'"), 'prompt=consent is no longer sent');
  });
});

describe('redaction invariants', () => {
  it('never logs a token', () => {
    // Checked against the source because the failure is silent and permanent: a refresh token in a
    // log file is a standing key to a merchant's search data.
    for (const file of [
      '../services/google-oauth.service.ts',
      '../services/search-console.service.ts',
      '../services/analytics.service.ts',
    ]) {
      for (const line of source(file).split('\n')) {
        if (!/console\.(log|warn|error|info|debug)/.test(line)) continue;
        assert.equal(
          /access_token|refresh_token|accessToken|refreshToken|client_secret|clientSecret/.test(line),
          false,
          `${file} logs a credential: ${line.trim()}`,
        );
      }
    }
  });

  it('never returns a token to a caller', () => {
    // The status payload is what the Integrations page renders. An encrypted token is still a
    // token, and nothing in the UI has any use for one.
    const service = source('../services/search-console.service.ts');
    const status = service.slice(service.indexOf('export interface SearchConsoleStatus'));
    for (const field of ['accessToken', 'refreshToken', 'Encrypted']) {
      assert.equal(status.includes(field), false, `the status payload exposes ${field}`);
    }
  });

  it('the controller never touches an encrypted column', () => {
    const controller = source('../controllers/google.controller.ts');
    for (const field of ['accessTokenEncrypted', 'refreshTokenEncrypted']) {
      assert.equal(controller.includes(field), false, `the controller references ${field}`);
    }
  });
});

describe('integration display rows', () => {
  it('scopes every integrations write to one provider', () => {
    // The bug this guards was invisible until a second Google connector existed:
    // `where(eq(integrations.storeId, id))` with no provider clause matches EVERY provider row on
    // the store, so a Search Console 403 quietly marked Shopify as needing attention. The helpers
    // in google-oauth.service.ts carry the provider; a raw update at a call site would not.
    for (const file of ['../services/search-console.service.ts', '../services/analytics.service.ts']) {
      assert.equal(
        /update\(integrations\)/.test(source(file)),
        false,
        `${file} writes the integrations table directly — use upsertIntegrationRow / markIntegrationStatus / markIntegrationSynced, which scope by provider`,
      );
    }
  });

  it('keys the shared helpers on store AND provider', () => {
    const oauth = source('../services/google-oauth.service.ts');
    assert.ok(
      oauth.includes('eq(integrations.provider'),
      'the integrations helpers no longer filter by provider — every connector on the store would be overwritten',
    );
  });

  it('writes an analytics row, not only a search-console one', () => {
    // Nothing wrote a row for `analytics` at all, so the catalogue card read the default
    // 'not_connected' and reported "Not connected" beside a card showing live GA4 data.
    const oauth = source('../services/google-oauth.service.ts');
    assert.ok(oauth.includes("'analytics'"), 'the Google callback no longer records an analytics row');
  });
});

describe('per-provider health', () => {
  // Search Console and Analytics share ONE Google grant and one google_connections row. Reading health
  // off that row is what made a Search Console read stamp Analytics as freshly synced, and a GA4
  // refusal appear under Search Console. providerHealth() is pure, so the separation is provable
  // without Google. Imported here rather than at the top: the rest of this file deliberately checks
  // the Google services against their source instead of loading them.
  const load = () => import('../services/google-oauth.service.js');
  const grant = { lastError: null };
  const read = new Date('2026-09-14T10:00:00Z');

  it('does not mark Analytics as synced because Search Console was read', async () => {
    const { providerHealth } = await load();
    const searchConsole = providerHealth(grant, { lastSyncedAt: read, notice: null });
    const analytics = providerHealth(grant, { lastSyncedAt: null, notice: null });
    assert.equal(searchConsole.lastSyncedAt, read.toISOString());
    assert.equal(analytics.lastSyncedAt, null, 'Analytics was reported as synced by a read it never made');
  });

  it('keeps an Analytics refusal off Search Console', async () => {
    const { providerHealth } = await load();
    const analytics = providerHealth(grant, { lastSyncedAt: null, notice: 'GA4 access denied' });
    const searchConsole = providerHealth(grant, { lastSyncedAt: read, notice: null });
    assert.equal(analytics.lastError, 'GA4 access denied');
    assert.equal(searchConsole.lastError, null, 'an Analytics refusal was shown under Search Console');
  });

  it('reports a failed grant under both providers', async () => {
    const { providerHealth } = await load();
    // A dead token stops both, so the grant's error reaches a provider that recorded nothing itself.
    const deadGrant = { lastError: 'Reconnect Google to continue.' };
    assert.equal(providerHealth(deadGrant, { lastSyncedAt: read, notice: null }).lastError, deadGrant.lastError);
    assert.equal(providerHealth(deadGrant, null).lastError, deadGrant.lastError);
  });

  it("ranks a provider's own refusal above the grant's", async () => {
    const { providerHealth } = await load();
    const health = providerHealth({ lastError: 'grant problem' }, { lastSyncedAt: null, notice: 'property refused' });
    assert.equal(health.lastError, 'property refused');
  });

  it('reports nothing a row remembers once the connection is gone', async () => {
    const { providerHealth } = await load();
    // Any read time or refusal on the rows belongs to a grant that no longer exists. Reported, it
    // would show "Working" — or an old error — beside a Connect button.
    assert.deepEqual(providerHealth(null, { lastSyncedAt: read, notice: 'old refusal' }), { lastSyncedAt: null, lastError: null });
  });

  it('treats a provider with no row yet as never read', async () => {
    const { providerHealth } = await load();
    assert.deepEqual(providerHealth(grant, null), { lastSyncedAt: null, lastError: null });
  });
});

describe('honest reporting', () => {
  it('ends the reporting range before today', () => {
    // Search Console finalises data on a delay. A range ending today returns rows that are still
    // filling in, which reads as a collapse in traffic rather than as absent data.
    const service = source('../services/search-console.service.ts');
    assert.ok(service.includes('DATA_LAG_DAYS'), 'the reporting lag is no longer applied');
  });

  it('reads totals from their own un-dimensioned query', () => {
    // Google withholds low-volume and privacy-sensitive queries, so the grouped rows deliberately
    // do not sum to the total. Deriving the headline figure from them would under-report real
    // traffic — quietly, and in the merchant's favour-losing direction.
    const service = source('../services/search-console.service.ts');
    assert.ok(
      service.includes('queryDimension(connection, connection.siteUrl, range, null)'),
      'totals are no longer read from a dedicated un-dimensioned query',
    );
  });
});
