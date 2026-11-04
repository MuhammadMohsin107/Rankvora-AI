import type { AnalyticsStatus } from './analytics.repository';
import type { SearchConsoleStatus } from './google.repository';
import { formatReadTime, sequentialChecks, type ConnectorHealth, type HealthCheck, type HealthTone } from './connectorHealth';

// Re-exported so the many call sites that already import these from here keep working, and so
// there is still one name for each of them rather than two that can drift apart.
export { formatReadTime };
export type { HealthCheck, HealthTone };

/**
 * ─── Is a Google connector actually working? ─────────────────────────
 *
 * "Connected" was answering the wrong question. The Integrations catalogue took its badge from the
 * display row the OAuth callback writes, and that row says `connected` the moment Google consent
 * completes — before a property is chosen and before a single number has been read. A merchant saw a
 * green "Connected" beside "Never synced" and had no way to tell whether anything worked.
 *
 * The verdict here is derived from the connector's own status endpoint, checked in the order a
 * merchant would have to fix things. WORKING has exactly one meaning: Google answered a real read for
 * this provider and has not refused one since. Nothing is inferred from a column a client can write.
 *
 * Pure — no fetching — so the same verdict drives the catalogue card, the detail drawer and Settings,
 * and they cannot disagree with each other.
 */

export type GoogleProviderId = 'search-console' | 'analytics';

export function isGoogleProvider(provider: string): provider is GoogleProviderId {
  return provider === 'search-console' || provider === 'analytics';
}

export type GoogleHealthState =
  | 'unconfigured'
  | 'not_connected'
  | 'scope_missing'
  | 'failing'
  | 'no_property'
  | 'unverified'
  | 'working';

export interface GoogleHealth extends ConnectorHealth {
  provider: GoogleProviderId;
  state: GoogleHealthState;
  /** Everything a live read needs is in place, so a test read can honestly be offered. */
  canTest: boolean;
  property: string | null;
}

interface HealthInput {
  provider: GoogleProviderId;
  configured: boolean;
  connected: boolean;
  /** Search Console has no separate scope flag; a refused read surfaces as `lastError` instead. */
  scopeGranted: boolean;
  account: string | null;
  property: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const BADGES: Record<GoogleHealthState, { label: string; tone: HealthTone }> = {
  unconfigured: { label: 'Unavailable', tone: 'neutral' },
  not_connected: { label: 'Not connected', tone: 'neutral' },
  scope_missing: { label: 'Reconnect needed', tone: 'warning' },
  failing: { label: 'Not working', tone: 'critical' },
  // Names the step that is missing rather than grading the setup. "Setup incomplete" told a
  // merchant that something was wrong without saying what, beside a panel whose one remaining
  // action did not look like an action — so the reasonable reading was that Rankvora AI was broken.
  no_property: { label: 'Choose a property', tone: 'warning' },
  unverified: { label: 'Not verified', tone: 'warning' },
  working: { label: 'Working', tone: 'success' },
};

/**
 * The first thing standing between this connector and real data.
 *
 * A refusal ranks above a missing property: when Google has revoked the grant, choosing a property is
 * not the step that will help.
 */
function stateOf(input: HealthInput): GoogleHealthState {
  if (!input.configured) return 'unconfigured';
  if (!input.connected) return 'not_connected';
  if (!input.scopeGranted) return 'scope_missing';
  if (input.lastError) return 'failing';
  if (!input.property) return 'no_property';
  if (!input.lastSyncedAt) return 'unverified';
  return 'working';
}

function names(provider: GoogleProviderId) {
  return provider === 'analytics'
    ? { product: 'Google Analytics', propertyNoun: 'GA4 property', panel: 'Google Analytics panel' }
    : { product: 'Search Console', propertyNoun: 'Search Console property', panel: 'Google Search Console panel' };
}

function describe(state: GoogleHealthState, input: HealthInput): { summary: string; nextStep: string | null } {
  const { product, propertyNoun, panel } = names(input.provider);
  switch (state) {
    case 'unconfigured':
      return {
        summary: `Not available on this server. Google sign-in is not configured, so ${product} cannot be read.`,
        nextStep: 'An administrator needs to add the Google OAuth client ID and secret to the server environment and restart the API.',
      };
    case 'not_connected':
      return {
        summary: `No Google account is connected, so nothing is being read from ${product}.`,
        nextStep: `Connect Google from the ${panel} on this page.`,
      };
    case 'scope_missing':
      return {
        summary: 'Google is connected, but this grant was made before Analytics access was added, so it cannot read Analytics.',
        nextStep: 'Reconnect Google from the Google Analytics panel and approve Analytics access.',
      };
    case 'failing':
      return {
        summary: `Not working. Google refused the last ${product} read, so no current data is coming in.`,
        nextStep: 'Resolve the problem Google reported, then run the test read again. If access was revoked, reconnect Google.',
      };
    case 'no_property':
      return {
        summary: `Google is connected, but no ${propertyNoun} is chosen yet, so there is nothing to read.`,
        nextStep: `Choose the property in the ${panel} on this page.`,
      };
    case 'unverified':
      return {
        summary: `Set up, but no data has been read from ${product} yet, so it is not confirmed to be working.`,
        nextStep: 'Run a test read to fetch live data from Google now.',
      };
    case 'working':
      return {
        summary: `Working. Google answered the last ${product} read on ${formatReadTime(input.lastSyncedAt)}.`,
        nextStep: null,
      };
  }
}

/**
 * The same facts as a checklist, in dependency order. Once a step fails, the steps after it are
 * `pending` — not passed and not failed — because they cannot be judged until it is fixed.
 */
function checksFor(input: HealthInput): HealthCheck[] {
  const steps: Array<{ label: string; passed: boolean; pass: string; fail: string; failOutcome?: HealthCheck['outcome'] }> = [
    {
      label: 'Google sign-in available on this server',
      passed: input.configured,
      pass: 'Google OAuth credentials are configured.',
      fail: 'Google OAuth credentials are not configured on the server.',
    },
    {
      label: 'Google account connected',
      passed: input.connected,
      pass: input.account ? `Connected as ${input.account}.` : 'Connected. Google did not share the account email.',
      fail: 'No Google account is connected to this store.',
    },
    ...(input.provider === 'analytics'
      ? [{
          label: 'Analytics read access granted',
          passed: input.scopeGranted,
          pass: 'The grant includes read-only Analytics access.',
          fail: 'This grant was made before Analytics access was added. Reconnect Google to include it.',
        }]
      : []),
    {
      label: 'Google accepts the connection',
      passed: !input.lastError,
      pass: 'No refusal from Google on record.',
      fail: input.lastError ?? '',
    },
    {
      label: 'Property chosen',
      passed: Boolean(input.property),
      pass: input.property ?? '',
      fail: 'No property is chosen, so there is nothing to read yet.',
    },
    {
      label: 'Live data read from Google',
      passed: Boolean(input.lastSyncedAt),
      pass: `Last successful read ${formatReadTime(input.lastSyncedAt)}.`,
      fail: 'No successful read yet. Run a test read to confirm it works.',
      failOutcome: 'pending',
    },
  ];

  return sequentialChecks(steps);
}

function healthOf(input: HealthInput): GoogleHealth {
  const state = stateOf(input);
  const { summary, nextStep } = describe(state, input);
  return {
    provider: input.provider,
    state,
    badge: BADGES[state],
    displayStatus:
      state === 'working' ? 'Connected'
        : state === 'not_connected' || (state === 'unconfigured' && !input.connected) ? 'Not Connected'
        : 'Needs Attention',
    summary,
    nextStep,
    checks: checksFor(input),
    canTest: input.configured && input.connected && input.scopeGranted && Boolean(input.property),
    account: input.account,
    property: input.property,
    lastSyncedAt: input.lastSyncedAt,
    lastError: input.lastError,
  };
}

export function searchConsoleHealth(status: SearchConsoleStatus): GoogleHealth {
  return healthOf({
    provider: 'search-console',
    configured: status.configured,
    connected: status.connected,
    scopeGranted: true,
    account: status.googleEmail,
    property: status.siteUrl,
    lastSyncedAt: status.lastSyncedAt,
    lastError: status.lastError,
  });
}

export function analyticsHealth(status: AnalyticsStatus): GoogleHealth {
  return healthOf({
    provider: 'analytics',
    configured: status.configured,
    connected: status.connected,
    scopeGranted: status.scopeGranted,
    account: status.googleEmail,
    property: status.propertyId ? `properties/${status.propertyId}` : null,
    // An API still on the build before per-provider read times sends no field at all. Undefined is
    // "unknown", which must read as never-verified rather than as a read that happened.
    lastSyncedAt: status.lastSyncedAt ?? null,
    lastError: status.lastError,
  });
}
