import { api } from '../lib/api';

// ─── AI Discovery settings ───────────────────────────────────────────
// The two merchant-owned inputs the pillar needs, plus the file generator.
//
// There is no mock and no fallback in this file. A store that has configured nothing gets nulls
// and empty arrays from the API, and the UI renders an empty state from them — it never shows a
// sample key or an example question, because a merchant cannot tell a placeholder apart from
// something they already set up.

export interface IndexNowConfig {
  /** Null when the merchant has not set one up. */
  indexNowKey: string | null;
  indexNowKeySetAt: string | null;
}

/** One real assistant answer that really happened. */
export interface PromptObservation {
  model: string;
  mentioned: boolean;
  /** The sentence the brand appeared in, quoted. Null when it was not mentioned. */
  mentionContext: string | null;
  checkedAt: string;
}

export interface PromptQuery {
  id: number;
  query: string;
  brandTerm: string;
  active: boolean;
  createdAt: string;
  /** Empty means this question has never been asked — not that it was never mentioned. */
  observations: PromptObservation[];
}

export interface AiDiscoverySettings {
  indexNow: IndexNowConfig;
  promptTracking: {
    queries: PromptQuery[];
    maxQueries: number;
    /** Observations needed before a mention rate is reported at all. */
    minSamples: number;
    /** The check's own "healthy" band for a mention rate, sent so this UI never retypes it. */
    healthyRate: number;
    /** False when the deployment has no AI provider — why nothing is being checked. */
    aiConfigured: boolean;
    model: string | null;
  };
}

export interface GeneratedFile {
  path: string;
  content: string;
  bytes: number;
  /** What was really included. */
  includes: string[];
  /** Real data the store does not have, which is why those sections are absent. */
  omitted: string[];
}

export interface GeneratedAgentFiles {
  llmsTxt: GeneratedFile;
  llmsFullTxt: GeneratedFile;
  agentsMd: GeneratedFile;
  source: {
    products: number;
    collections: number;
    pages: number;
    policies: number;
    productsTruncated: boolean;
    /** Products read but left out of the files: draft, archived or not on the online store. */
    unpublishedProducts: number;
    capturedAt: string;
  };
}

export interface PromptSweepResult {
  checked: number;
  mentioned: number;
  failures: Array<{ queryId: number; query: string; detail: string }>;
  queries: PromptQuery[];
}

/**
 * ─── DO NOT DESTRUCTURE `.data` FROM AN `api.*` CALL ─────────────────
 *
 * `request()` in lib/api.ts ALREADY unwraps the `{ data: ... }` envelope every Rankvora AI controller
 * responds with — see its closing return. So `api.get<T>()` resolves to T, not to `{ data: T }`.
 *
 * This file used to declare an `Envelope<T>` type and write `const { data } = await api.get(...)`,
 * which unwrapped a second time: `data` was `undefined`, every function here returned undefined,
 * and the caller died on the first property access. Because the resulting TypeError is not an
 * ApiError, each panel's error handler fell through to its most generic branch and reported
 * "Could not reach the Rankvora AI API" — pointing at the backend for a bug that was entirely in the
 * browser, on an API that was answering perfectly.
 *
 * TypeScript could not catch it: `Envelope<T>` was a lie the call site told the compiler about a
 * shape the runtime never produced, so the types agreed with each other and both were wrong.
 *
 * Every function below returns the api call directly. Keep it that way.
 */

export async function fetchAiDiscoverySettings(): Promise<AiDiscoverySettings> {
  return api.get<AiDiscoverySettings>('/ai-discovery/settings');
}

/** Omitting `key` asks the server to generate one. */
export async function saveIndexNowKey(key?: string): Promise<IndexNowConfig> {
  return api.post<IndexNowConfig>('/ai-discovery/indexnow-key', key ? { key } : {});
}

export async function removeIndexNowKey(): Promise<IndexNowConfig> {
  return api.delete<IndexNowConfig>('/ai-discovery/indexnow-key');
}

export async function addPromptQuery(query: string, brandTerm?: string): Promise<PromptQuery> {
  return api.post<PromptQuery>('/ai-discovery/prompt-queries', { query, ...(brandTerm ? { brandTerm } : {}) });
}

export async function setPromptQueryActive(id: number, active: boolean): Promise<PromptQuery[]> {
  return api.patch<PromptQuery[]>(`/ai-discovery/prompt-queries/${id}`, { active });
}

export async function deletePromptQuery(id: number): Promise<PromptQuery[]> {
  return api.delete<PromptQuery[]>(`/ai-discovery/prompt-queries/${id}`);
}

/** Asks every active question once, now. Each answer is recorded as it arrives. */
export async function runPromptSweep(): Promise<PromptSweepResult> {
  return api.post<PromptSweepResult>('/ai-discovery/prompt-queries/run');
}

/** Builds the files from the store as it is right now. Returns content; publishes nothing. */
export async function fetchAgentFiles(): Promise<GeneratedAgentFiles> {
  return api.get<GeneratedAgentFiles>('/ai-discovery/agent-files');
}

/** Mention rate across real observations, or null when there are too few to mean anything. */
export function mentionRate(query: PromptQuery, minSamples: number): number | null {
  if (query.observations.length < minSamples) return null;
  return query.observations.filter((observation) => observation.mentioned).length / query.observations.length;
}

// ─── AI referral traffic ─────────────────────────────────────────────
// Real GA4 sessions from AI assistants. The pillar's only OUTCOME measure — every other check
// reports readiness. Nothing here has a fallback: a store with no GA4 property gets an ApiError the
// card renders as a prompt, and a property with no AI traffic gets zeroes Google actually returned.

export interface AiReferralPlatform {
  id: string;
  label: string;
  vendor: string;
  kind: 'assistant' | 'ai-search';
  sessions: number;
  engagedSessions: number;
  conversions: number;
}

export interface AiReferralPerformance {
  propertyId: string;
  /** The dates Google actually answered for, never the ones we asked about. */
  startDate: string;
  endDate: string;
  totals: {
    sessions: number;
    engagedSessions: number;
    conversions: number;
    /** AI sessions ÷ all sessions in the same window. Null when the property recorded no sessions. */
    shareOfAllSessions: number | null;
  };
  platforms: AiReferralPlatform[];
  allSessions: number;
  /**
   * Always true. GA4 cannot see an assistant that answered without linking, an in-app browser that
   * arrives as direct, or a shopper who searched the brand afterwards. Every surface showing these
   * numbers must say they are a floor.
   */
  isFloor: true;
  platformsChecked: number;
}

export async function fetchAiReferrals(days = 28): Promise<AiReferralPerformance> {
  return api.get<AiReferralPerformance>(`/ai-discovery/referrals?days=${days}`);
}

// ─── Google index coverage ───────────────────────────────────────────
// Real URL Inspection results for a sample of the store's own sitemap.

export interface InspectedUrl {
  url: string;
  verdict: 'VERDICT_UNSPECIFIED' | 'PASS' | 'PARTIAL' | 'FAIL' | 'NEUTRAL';
  /** Google's own sentence, e.g. "Crawled — currently not indexed". The one that matters. */
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  indexed: boolean;
  error: string | null;
}

export interface IndexCoverage {
  siteUrl: string;
  sitemapUrlCount: number;
  inspectedCount: number;
  indexedCount: number;
  notIndexedCount: number;
  errorCount: number;
  /** Of the SAMPLE, not the catalogue. Null when no inspection succeeded — never a fabricated 0. */
  sampledIndexRate: number | null;
  results: InspectedUrl[];
  isSample: boolean;
}

/** Each URL spends one unit of the merchant's own Search Console quota — hence the small default. */
export async function fetchIndexCoverage(sample = 10): Promise<IndexCoverage> {
  return api.get<IndexCoverage>(`/ai-discovery/index-coverage?sample=${sample}`);
}

// ─── Test as a bot ───────────────────────────────────────────────────

export interface TestableBot {
  name: string;
  vendor: string;
  purpose: 'training' | 'search' | 'user-action' | 'archive';
  effect: string;
  /** False for robots.txt-only tokens like Google-Extended, which have no User-Agent to send. */
  probeable: boolean;
}

export interface BotTestResult {
  bot: { name: string; vendor: string; purpose: TestableBot['purpose']; effect: string; userAgent: string };
  url: string;
  robots: { fetched: boolean; allowed: boolean; hasSpecificGroup: boolean; crawlDelaySeconds: number | null };
  response: { status: number | null; contentType: string | null; bytes: number; error: string | null; passwordGated: boolean };
  content: { title: string | null; textPreview: string | null; textLength: number };
  summary: string;
  checkedAt: string;
}

export async function fetchTestableBots(): Promise<TestableBot[]> {
  // The controller wraps this one twice on purpose — `{ data: { bots: [...] } }` — so that the
  // list can gain siblings later without changing its shape. `request()` strips the outer `data`;
  // `bots` is the real payload key and is destructured here.
  const { bots } = await api.get<{ bots: TestableBot[] }>('/ai-discovery/bots');
  return bots;
}

/** Really fetches the URL as that crawler, right now. `path` is resolved against the store's origin. */
export async function runBotTest(bot: string, path: string): Promise<BotTestResult> {
  return api.post<BotTestResult>('/ai-discovery/bot-test', { bot, path });
}

// ─── Prompt tracking over time ───────────────────────────────────────

export interface PromptHistoryBucket {
  date: string;
  samples: number;
  mentions: number;
  rate: number;
  /** Below the sample floor — render as unsettled, never as a settled value. */
  provisional: boolean;
}

export interface PromptQueryTrend {
  queryId: number;
  query: string;
  brandTerm: string;
  active: boolean;
  samples: number;
  mentions: number;
  /** Null when never checked. Never conflated with a zero rate. */
  rate: number | null;
  provisional: boolean;
  lastCheckedAt: string | null;
}

/** One competitor's presence across the window, measured against the store's own. */
export interface CompetitorStanding {
  /** The exact term that matched — derived from a domain the merchant entered, never invented. */
  term: string;
  named: number;
  /** Answers naming them but NOT the store. The actionable number. */
  namedWithoutUs: number;
  /** Answers in which they appeared ahead of the store. */
  aheadOfUs: number;
  /** Mean position across the answers naming them, 0 (start) to 1 (end). */
  averagePosition: number;
}

/**
 * Where the store stands against the competitors the merchant listed at onboarding.
 *
 * NOT "your ChatGPT ranking". It is placement among tracked brands in real recorded answers to the
 * merchant's own questions, and an assistant's answer is non-deterministic — so every figure is
 * rendered with the number of answers behind it.
 *
 * `configured: false` means no competitor list, so there is no standing to report. Every derived
 * field is null, because "first of one" is the absence of a comparison, not a win.
 */
export interface RankingStanding {
  configured: boolean;
  rankedAnswers: number;
  /** Mean 1-based ordinal where the store was named. Null when it never was. */
  averageRank: number | null;
  /** Brands named, over the same answers as averageRank. Null when the store was never named. */
  averageBrandsNamed: number | null;
  timesFirst: number;
  /** Mean position of the store's mention, 0 (start) to 1 (end). Lower is better. */
  averagePosition: number | null;
  /** Answers naming a competitor but not the store. */
  answersLostEntirely: number;
  competitors: CompetitorStanding[];
}

export interface PromptHistory {
  days: number;
  granularity: 'day' | 'week';
  startDate: string;
  endDate: string;
  /** Only buckets with real observations. A day nobody ran a sweep is absent, not zero. */
  series: PromptHistoryBucket[];
  totalSamples: number;
  totalMentions: number;
  overallRate: number | null;
  queries: PromptQueryTrend[];
  minSamples: number;
  /** The check's own grading bands for a rate, so the panel colours by them rather than a copy. */
  healthyRate: number;
  criticalRate: number;
  /** Whether this deployment can ask a model at all. An empty trend means nothing without it. */
  aiConfigured: boolean;
  ranking: RankingStanding;
}

export async function fetchPromptHistory(days = 90): Promise<PromptHistory> {
  return api.get<PromptHistory>(`/ai-discovery/prompt-history?days=${days}`);
}

// ─── Per-product AI readiness ────────────────────────────────────────
// The same three product-level AI Discovery checks an audit runs, inverted into one row per
// product. Every verdict below was produced by the check's own assess() function — this is a
// different VIEW of real measurements, not a second measurement.

export type ProductRowStatus = 'Healthy' | 'Needs Work' | 'Critical';

export interface ProductSignal {
  subPillar: 'agentic-attrs' | 'feed' | 'answerable-qa';
  label: string;
  status: ProductRowStatus;
  /**
   * False when the check reached no verdict — agentic-attrs on a product whose variants Shopify did
   * not return in full. The server leaves such a signal out of the product's score and status;
   * the panel says "Not measured" instead of showing a status. Absent on older responses = true.
   */
  measured?: boolean;
  /** The specific problem, worded by the check itself. Empty when the product passed. */
  issue: string;
  detail: string;
  recommendation: string;
}

export interface ProductReadiness {
  id: string;
  title: string;
  handle: string;
  /** Null when the store records no primary domain — never a guessed URL. */
  url: string | null;
  vendor: string;
  productType: string;
  /** Share of applicable checks passed. A count, not a weighted model. */
  readinessScore: number;
  status: ProductRowStatus;
  signals: ProductSignal[];
  passed: number;
  applicable: number;
}

export interface ProductReadinessSummary {
  analyzed: number;
  healthy: number;
  needsWork: number;
  critical: number;
  /** Null when no products were assessed — never 0, which would read as total failure. */
  averageScore: number | null;
  /** Null means the catalogue total could not be read. That is "unknown", NOT "equal to analyzed". */
  available: number | null;
  /** False when Shopify reported the total as AT_LEAST rather than a firm count. */
  exact: boolean | null;
  truncated: boolean;
  /** Draft, archived and unpublished products read but not assessed — no one can reach them. */
  unpublished: number;
  capturedAt: string;
}

export interface ProductReadinessResult {
  summary: ProductReadinessSummary;
  /** Ranked worst-first — this is a work queue, so the top is the next thing to fix. */
  products: ProductReadiness[];
}

/** Reads the store live through the audit's own provider, so recent catalogue edits are reflected. */
export async function fetchProductReadiness(): Promise<ProductReadinessResult> {
  return api.get<ProductReadinessResult>('/ai-discovery/product-readiness');
}
