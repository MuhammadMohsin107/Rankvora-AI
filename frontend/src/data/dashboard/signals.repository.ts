import { api } from '../../lib/api';

/**
 * ─── The four outcome cards under the pillars ────────────────────────
 *
 * Organic search clicks, mobile LCP, AI mention rate and drafts awaiting approval. Every figure is
 * read by the backend from Google Search Console, the stored PageSpeed measurement, the recorded
 * assistant answers or a database count (services/dashboard-signals.service.ts) — this file only
 * carries the answer here. There is no sample value, no default and no fallback number: a card is
 * either `ready` with a real reading, or `unavailable` with the one reason and the sentence to show.
 */

export type SignalReason =
  | 'not_configured'
  | 'not_connected'
  | 'no_property'
  | 'not_measured'
  | 'no_queries'
  | 'no_data'
  | 'error';

export type Signal<T> =
  | { status: 'ready'; data: T }
  | { status: 'unavailable'; reason: SignalReason; message: string };

export interface SearchTrafficSignal {
  siteUrl: string;
  days: number;
  startDate: string;
  endDate: string;
  clicks: number;
  previousClicks: number;
  /** Percent against the window before, one decimal. Null when that window had no clicks to compare with. */
  changePercent: number | null;
}

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface MobileSpeedSignal {
  /** `field` = real visitors (75th percentile); `lab` = one Lighthouse run. */
  source: 'field' | 'lab';
  lcpMs: number;
  rating: VitalRating;
  /** Field only. `origin` = Google had too few visits to this page and reported the whole domain. */
  scope: 'url' | 'origin' | null;
  measuredAt: string;
}

export interface AiMentionSignal {
  days: number;
  /** A fraction: mentions ÷ sampled answers. */
  rate: number;
  mentions: number;
  samples: number;
  /** Too few answers to call it a rate — shown as an early read and never compared. */
  provisional: boolean;
  minSamples: number;
  previousRate: number | null;
  /** Percentage points against the window before. Null unless both windows are settled. */
  changePoints: number | null;
}

export interface ApprovalArea {
  pillar: string;
  subPillar: string;
  count: number;
}

export interface ApprovalSignal {
  total: number;
  /** Where the waiting drafts are, largest first. */
  areas: ApprovalArea[];
}

export interface DashboardSignals {
  searchTraffic: Signal<SearchTrafficSignal>;
  mobileSpeed: Signal<MobileSpeedSignal>;
  aiMentions: Signal<AiMentionSignal>;
  approvals: Signal<ApprovalSignal>;
}

export const fetchDashboardSignals = () => api.get<DashboardSignals>('/dashboard/signals');
