// ─── Dashboard contracts ─────────────────────────────────────────────
// The page-facing shapes that data/dashboard/dashboard.repository.ts assembles from the API.
//
// This file previously also exported `dashboardMockData`, a ~256-line fixture that nothing
// imported and whose SEO sub-pillar ids had drifted out of date ('alt-text', 'handles' instead
// of the real 'image-alt-text', 'handles-redirects'). Anyone wiring it up for a demo would have
// got broken sub-pillar links, so it has been removed rather than corrected.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type PillarKey = 'seo' | 'content' | 'speed' | 'cro' | 'ai-discovery';
/** `not-measured` is deliberately NOT a score band. It means the engine produced no measurable
 * result, and it exists so "we could not measure this" can never be rendered as "critical". */
export type ScoreStatus = 'excellent' | 'good' | 'needs-work' | 'critical' | 'not-measured';
export type TrendDirection = 'up' | 'down' | 'stable';

export interface OverallScore {
  score: number;
  status: ScoreStatus;
  statusLabel: string;
  description: string;
  trend: TrendDirection;
  trendValue: number;
  /** False when the audit recorded overallAvailable:false — `score` is then a placeholder and
   * the UI must show a "not measured" state instead of the number or a status band. */
  measured: boolean;
  /** e.g. "2,000 of 10,000 products analyzed · 20% coverage". Null when the audit covered
   * everything, or when the store total could not be read. Shown so a score computed from a
   * partial catalogue is never presented as a whole-store result. */
  coverageNote: string | null;
}

export interface KeyMetric {
  id: string;
  label: string;
  value: number;
  statusLabel?: string;
  suffix?: string;
  /** One line under the value, built from the same audit ("of 1,570 analyzed"). Never a guess. */
  context?: string;
  trend?: TrendDirection;
  trendValue?: number;
  color: 'critical' | 'warning' | 'success' | 'info' | 'neutral';
}

export interface SubPillar {
  id: string;
  label: string;
}

export interface PillarScore {
  key: PillarKey;
  label: string;
  /**
   * null when this audit produced no measurable result for the pillar — either no check is
   * registered for it yet, or every check it does have reported `unavailable`.
   *
   * The pillar is still present in the list. A pillar that could not be measured must render as
   * "Not analyzed yet", never vanish from the dashboard and never be shown as a real 0.
   */
  score: number | null;
  status: ScoreStatus;
  statusLabel: string;
  description: string;
  icon: string;
  checksTotal: number;
  checksPassed: number;
  subPillars: SubPillar[];
}

export interface PriorityIssue {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  pillar: PillarKey;
  pillarLabel: string;
  actionLabel: string;
  /** The merchant has marked it reviewed; it is still outstanding, so it stays on the list. */
  reviewed: boolean;
  /** Where the fix is: the sub-pillar page when the app has one, else the pillar dashboard. */
  route: string;
  /** As the audit counted it: "39" + "pages". */
  affectedCount: number;
  affectedLabel: string;
  /** What `affectedCount` is out of, when the check recorded it — "39 of 120 pages". */
  population: number | null;
  /** The sub-area the finding belongs to ("Image alt text"), shown beside the pillar tag. */
  areaLabel?: string;
}

/**
 * NO `impact`, NO `effort` AND NO `scoreLift`.
 *
 * `estimatedTime` went first: a minute count mapped from severity and summed into a "~75 min
 * total". Its replacement, `effort`, and the `impact` chip beside it were no better — words each
 * check typed in by hand, the same for every store whatever it found.
 *
 * `scoreLift` went last. It was shown as "+100 potential pts" beside an overall score of 49, but
 * it is not a number of overall points: most checks store the SHARE of one sub-pillar's items the
 * finding touches (39 of 39 crawled pages → 100), and a few type a constant in by hand (40, 20,
 * 67). What an action carries now is only what the audit determined: the severity its rules set,
 * how many items it counted, and the first line of evidence it recorded in this store.
 */
export interface RecommendedAction {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  pillar: PillarKey;
  pillarLabel: string;
  /** As the audit counted it: "39" + "pages". */
  affectedCount: number;
  affectedLabel: string;
  /** The first evidence line the audit recorded for this finding in this store, if any. */
  evidence: string | null;
  route: string;
}

export interface ScoreTrendPoint {
  date: string;
  score: number;
}

export interface DashboardData {
  overallScore: OverallScore;
  keyMetrics: KeyMetric[];
  pillars: PillarScore[];
  priorityIssues: PriorityIssue[];
  recommendedActions: RecommendedAction[];
  scoreTrend: ScoreTrendPoint[];
  lastUpdated: string;
  storeName: string;
  storeUrl: string;
}
