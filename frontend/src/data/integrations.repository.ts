import { api } from '../lib/api';
import type { IntegrationRow } from './api.types';
import { fetchAnalyticsStatus } from './analytics.repository';
import { fetchGoogleStatus } from './google.repository';
import {
  analyticsHealth,
  formatReadTime,
  isGoogleProvider,
  searchConsoleHealth,
  type GoogleProviderId,
  type HealthTone,
} from './googleHealth';
import { catalogEntryFor, integrationCatalog } from './integrationCatalog';
import { fetchPageSpeedStatus } from './pagespeed.repository';
import { pagespeedHealth, PAGESPEED_PROVIDER } from './pagespeedHealth';
import type { ConnectorHealth } from './connectorHealth';

export type IntegrationDisplayStatus = 'Connected' | 'Needs Attention' | 'Not Connected';

export interface IntegrationRecord {
  id: string;
  group: string;
  name: string;
  description: string;
  status: IntegrationDisplayStatus;
  detail: string;
  lastSynced: string;
  data: string[];
  notice?: string;
  /** False when no connector exists yet — the UI must not offer a Connect action. */
  available: boolean;
  /**
   * The badge to show when it says more than `status` can. Set on the connectors that carry a
   * verdict — "Not verified", "Choose a property", "Not measured", "Working" — which comes from
   * googleHealth.ts and pagespeedHealth.ts. Every other provider renders its `status`, as before.
   */
  badge?: { label: string; tone: HealthTone };
}

const statusToDisplay: Record<IntegrationRow['status'], IntegrationDisplayStatus> = {
  connected: 'Connected',
  needs_attention: 'Needs Attention',
  not_connected: 'Not Connected',
};

function formatLastSynced(isoDate: string | null): string {
  if (!isoDate) return 'Never synced';
  return new Date(isoDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toIntegrationRecord(row: IntegrationRow): IntegrationRecord {
  const catalog = catalogEntryFor(row.provider);
  return {
    id: row.provider,
    group: catalog.group,
    name: catalog.name,
    description: catalog.description,
    status: statusToDisplay[row.status],
    detail: row.accountDetail ?? (row.status === 'not_connected' ? 'No account connected' : 'Connected account'),
    lastSynced: formatLastSynced(row.lastSyncedAt),
    data: catalog.data,
    notice: row.notice ?? undefined,
    available: catalog.available,
  };
}

/**
 * Lists every provider in the catalog, overlaid with whatever connection state the backend holds.
 *
 * The previous version listed ONLY the rows the API returned. Since a row is created the first
 * time a provider is actually connected, a new account saw an empty Integrations page and an
 * empty "Add an integration" drawer — which is why the drawer only ever showed "More providers
 * can be added when their connector is available". A provider with no row is simply not
 * connected yet, which is exactly what the catalog entry now renders.
 */
export async function fetchIntegrations(): Promise<IntegrationRecord[]> {
  const rows = await api.get<IntegrationRow[]>('/integrations');
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  return Object.values(integrationCatalog).map((catalog) => {
    const row = byProvider.get(catalog.provider);
    if (row) return toIntegrationRecord(row);

    return {
      id: catalog.provider,
      group: catalog.group,
      name: catalog.name,
      description: catalog.description,
      status: 'Not Connected' as const,
      detail: 'No account connected',
      lastSynced: 'Never synced',
      data: catalog.data,
      available: catalog.available,
    };
  });
}

// ─── Connector health ────────────────────────────────────────────────

/** Providers whose card shows a VERDICT rather than the raw row a client could write. */
export type HealthCheckedProvider = GoogleProviderId | typeof PAGESPEED_PROVIDER;

function isHealthChecked(provider: string): provider is HealthCheckedProvider {
  return isGoogleProvider(provider) || provider === PAGESPEED_PROVIDER;
}

/** Each connector's verdict. A provider is absent when its own status could not be read. */
export type ConnectorHealthMap = Partial<Record<HealthCheckedProvider, ConnectorHealth>>;

/**
 * Reads every verdict-carrying connector's status and turns each into a verdict.
 *
 * Settled independently: the three answer on separate endpoints, and one failing says nothing
 * about the others. A provider whose status could not be read is left OUT of the map rather than
 * filled in, so overlayConnectorHealth() can say it was not checked.
 */
export async function fetchConnectorHealth(): Promise<ConnectorHealthMap> {
  const [searchConsole, analytics, pagespeed] = await Promise.allSettled([
    fetchGoogleStatus(),
    fetchAnalyticsStatus(),
    fetchPageSpeedStatus(),
  ]);
  const health: ConnectorHealthMap = {};
  if (searchConsole.status === 'fulfilled') health['search-console'] = searchConsoleHealth(searchConsole.value);
  if (analytics.status === 'fulfilled') health.analytics = analyticsHealth(analytics.value);
  if (pagespeed.status === 'fulfilled') health.pagespeed = pagespeedHealth(pagespeed.value);
  return health;
}

/**
 * Replaces each verdict-carrying connector's display state with its verdict.
 *
 * The catalogue row for the Google providers is written by the OAuth callback and says `connected`
 * the moment consent completes — before a property is chosen and before a single number is read.
 * Shown as-is, that is a green "Connected" beside "Never synced". PageSpeed has the same hazard
 * from the other direction: its row exists only once a run has been attempted, so the raw row
 * cannot distinguish "never measured" from "measured and fine". The verdict is what the catalogue
 * card, the detail drawer and the connector's own panel all show instead.
 *
 * Only a WORKING connector counts as Connected, and the page's counts are built from that.
 */
export function overlayConnectorHealth(records: IntegrationRecord[], health: ConnectorHealthMap): IntegrationRecord[] {
  return records.map((record): IntegrationRecord => {
    const provider = record.id;
    if (!isHealthChecked(provider)) return record;

    const verdict = health[provider];
    if (!verdict) {
      // The status check itself failed, so nothing here was verified. A raw "not connected" is still
      // true — there is no grant to be wrong about — but a raw "connected" is exactly the unverified
      // claim this overlay exists to stop, so it is never passed through.
      if (record.status === 'Not Connected') return record;
      return {
        ...record,
        status: 'Needs Attention',
        badge: { label: 'Status unavailable', tone: 'warning' },
        detail: 'Could not check whether this connection is working.',
      };
    }

    return {
      ...record,
      status: verdict.displayStatus,
      badge: verdict.badge,
      detail: verdict.summary,
      lastSynced: formatReadTime(verdict.lastSyncedAt),
      // This provider's own refusal, or the grant's. Replaces the row's notice rather than adding to
      // it: the verdict is built from the same facts, read in the same request, so it is never older.
      notice: verdict.lastError ?? undefined,
    };
  });
}
