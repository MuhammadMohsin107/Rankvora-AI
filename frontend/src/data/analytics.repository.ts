import { api } from '../lib/api';

/**
 * ─── Google Analytics 4 ──────────────────────────────────────────────
 *
 * Every value here comes from the real GA4 API through Rankvora AI's backend. There is no sample
 * property, no placeholder metric and no fallback row: a store with no connection reports
 * `connected: false`, and a property with no traffic reports zeroes that are genuinely zero.
 *
 * THERE IS NO CONNECT CALL HERE, deliberately. GA4 rides on the SAME Google connection Search
 * Console uses — one consent screen, one token pair, two APIs — so connecting and disconnecting
 * live in google.repository.ts. Duplicating them would imply a second grant to manage.
 */

export interface AnalyticsStatus {
  /** Whether the SERVER has Google OAuth credentials at all. False = hide everything. */
  configured: boolean;
  /** Whether THIS store has a live Google connection. */
  connected: boolean;
  /**
   * Whether that connection's grant actually carries the GA4 scope.
   *
   * A connection made before Analytics support existed is a real, working Search Console
   * connection that simply cannot read GA4. The card asks for a reconnect in that case rather
   * than showing an error the merchant cannot act on.
   */
  scopeGranted: boolean;
  googleEmail: string | null;
  /** The numeric property this store reports on. Null = nothing chosen yet. */
  propertyId: string | null;
  /**
   * When Google last answered a real GA4 read for this store. Null = never. Analytics' own, not the
   * shared Google connection's — a Search Console read does not move it.
   */
  lastSyncedAt: string | null;
  /** Why the last GA4 read failed, or why the Google grant itself is unusable. */
  lastError: string | null;
}

export interface AnalyticsProperty {
  /** Numeric id, e.g. `498211037`. Never the `G-XXXXXXXXXX` measurement id. */
  propertyId: string;
  displayName: string;
  /** The Analytics account it sits under, so similarly named properties stay tellable apart. */
  account: string;
}

export interface AnalyticsRow {
  key: string;
  sessions: number;
  engagedSessions: number;
  conversions: number;
}

export interface AnalyticsPerformance {
  propertyId: string;
  /** The dates actually queried. GA4 lags 1-2 days, so this is never "today". */
  startDate: string;
  endDate: string;
  totals: {
    sessions: number;
    engagedSessions: number;
    /** A fraction as Google returns it: 0.0432 = 4.32%. */
    engagementRate: number;
    conversions: number;
  };
  topLandingPages: AnalyticsRow[];
  topChannels: AnalyticsRow[];
}

export const fetchAnalyticsStatus = () => api.get<AnalyticsStatus>('/google/ga4/status');

/** The properties the connected account can read, for the merchant to choose between. */
export const fetchAnalyticsProperties = () => api.get<AnalyticsProperty[]>('/google/ga4/properties');

/** Records which property this store reports on. The server verifies it against the account. */
export const selectAnalyticsProperty = (propertyId: string) =>
  api.post<AnalyticsStatus>('/google/ga4/property', { propertyId });

export const fetchAnalyticsPerformance = (days = 28) =>
  api.get<AnalyticsPerformance>(`/google/ga4/performance?days=${days}`);
