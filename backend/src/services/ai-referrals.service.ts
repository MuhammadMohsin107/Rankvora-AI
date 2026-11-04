import { AI_REFERRERS, matchAiReferrer, type AiReferrer } from '../audit-engine/storefront/ai-referrers.js';
import { ApiError } from '../middleware/error.js';
import {
  DATA_BASE,
  callApi,
  rangeEndingWithLag,
  requireAnalyticsConnection,
} from './analytics.service.js';

/**
 * ─── AI referral traffic · the only outcome measure the pillar has ───
 *
 * Every other AI Discovery check measures READINESS — is the file published, is the crawler
 * admitted, does the variant carry a GTIN. Readiness is a precondition, not a result: a store can
 * pass all seven and still never be named in an answer anybody acted on. This is the one number
 * that says a human read an assistant's reply and arrived.
 *
 * ─── Why this reuses the GA4 connection rather than adding anything ──
 * It is a `sessionSource` breakdown of traffic the store's own property already records. No new
 * scope, no new consent, no new credential — `analytics.readonly` is already granted, and a store
 * with Analytics connected can be shown this today. That is deliberate: the most valuable figure in
 * the pillar should also be the cheapest to switch on.
 *
 * ─── THIS IS A FLOOR, NOT A TOTAL, AND EVERY CALLER MUST SAY SO ──────
 * Three real cases are invisible here, and none of them can be recovered:
 *
 *   1. An assistant that answers FROM the store's content without linking sends no referral. The
 *      shopper may still buy, having been persuaded — and nothing records why.
 *   2. An assistant whose app opens links in an in-app browser frequently arrives as `(direct)`.
 *   3. A shopper who reads an answer, then types the store name into a search engine, is recorded
 *      as organic search. The assistant caused the visit and gets none of the credit.
 *
 * So `isFloor` is returned on every response and is not optional. Presenting this as "AI traffic"
 * full stop would overstate what GA4 can see, and — worse — a store reading zero would conclude AI
 * discovery had failed when it may simply be uncredited.
 *
 * ─── Nothing is fabricated when there is nothing ─────────────────────
 * A property with no AI referrals returns rows for no platforms and `sessions: 0`. That zero came
 * from Google in this request. It is never a placeholder, never a sample, and the response carries
 * the dates actually queried so the caller can never imply a window Google did not answer for.
 */

/** Matches getAnalyticsPerformance: this feeds a card, not an export. */
const ROW_LIMIT = 250;

export interface AiReferralPlatform {
  id: string;
  label: string;
  vendor: string;
  kind: AiReferrer['kind'];
  sessions: number;
  engagedSessions: number;
  conversions: number;
}

export interface AiReferralTotals {
  sessions: number;
  engagedSessions: number;
  conversions: number;
  /**
   * AI sessions as a fraction of ALL sessions in the same window (0.0132 = 1.32%).
   *
   * Computed from an un-dimensioned total rather than by summing the source rows: GA4 collapses
   * high-cardinality dimensions into `(other)` and applies its own thresholding, so the grouped
   * rows deliberately do not add up. Dividing by their sum would inflate the share — the same trap
   * getAnalyticsPerformance() documents.
   *
   * NULL when the property recorded no sessions at all in the window: a share of nothing is not
   * 0%, and the card used to print "0.00%" for it as though it had been measured.
   */
  shareOfAllSessions: number | null;
}

export interface AiReferralPerformance {
  propertyId: string;
  /** The dates actually queried, so the UI never implies a range Google did not answer for. */
  startDate: string;
  endDate: string;
  totals: AiReferralTotals;
  /** One row per AI platform that sent at least one session. Descending by sessions. */
  platforms: AiReferralPlatform[];
  /** All sessions in the window, AI and otherwise — the denominator behind `shareOfAllSessions`. */
  allSessions: number;
  /** Always true. See the header: GA4 cannot see uncredited AI-driven visits. */
  isFloor: true;
  /**
   * Every platform this build knows how to recognise, whether or not it sent traffic.
   *
   * Returned so the UI can say "we looked for these twelve and found two" instead of showing two
   * rows and leaving the merchant to wonder whether the others were checked or merely absent.
   */
  platformsChecked: number;
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
 * GA4 returns every metric as a string, counts included. An absent row is a real zero: a property
 * with no traffic returns no rows at all rather than rows of zeroes.
 */
function metric(row: ReportRow | undefined, index: number): number {
  const parsed = Number(row?.metricValues?.[index]?.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Real AI referral traffic for the store's selected GA4 property.
 *
 * Two calls: one dimensioned by `sessionSource` to find the AI hosts, one un-dimensioned for the
 * true denominator. See AiReferralTotals.shareOfAllSessions for why the second is not optional.
 */
export async function getAiReferralPerformance(storeId: number, days = 28): Promise<AiReferralPerformance> {
  const connection = await requireAnalyticsConnection(storeId);
  if (!connection.ga4PropertyId) {
    throw new ApiError(409, 'Choose which Analytics property this store reports on.', 'GA4_PROPERTY_NOT_SELECTED');
  }

  const propertyId = connection.ga4PropertyId;
  const range = rangeEndingWithLag(days);
  const url = `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`;

  const body = (dimension: string | null) => ({
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    ...(dimension ? { dimensions: [{ name: dimension }] } : {}),
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'conversions' }],
    limit: dimension ? ROW_LIMIT : 1,
  });

  const [sourceResponse, totalResponse] = await Promise.all([
    callApi<ReportResponse>(connection, url, body('sessionSource')),
    callApi<ReportResponse>(connection, url, body(null)),
  ]);

  // Several source spellings can map to one platform — `chatgpt.com` and `chat.openai.com` are both
  // ChatGPT — so rows are accumulated per platform rather than emitted per row.
  const byPlatform = new Map<string, AiReferralPlatform>();

  for (const row of sourceResponse.rows ?? []) {
    const source = row.dimensionValues?.[0]?.value ?? '';
    const referrer = matchAiReferrer(source);
    if (!referrer) continue;

    const existing = byPlatform.get(referrer.id) ?? {
      id: referrer.id,
      label: referrer.label,
      vendor: referrer.vendor,
      kind: referrer.kind,
      sessions: 0,
      engagedSessions: 0,
      conversions: 0,
    };

    existing.sessions += metric(row, 0);
    existing.engagedSessions += metric(row, 1);
    existing.conversions += metric(row, 2);
    byPlatform.set(referrer.id, existing);
  }

  const platforms = [...byPlatform.values()]
    // A platform GA4 listed with zero sessions is not evidence of anything — drop it rather than
    // show a row that reads as "we sent you nothing" when it is really "this row was noise".
    .filter((platform) => platform.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions);

  const totals = platforms.reduce(
    (accumulator, platform) => ({
      sessions: accumulator.sessions + platform.sessions,
      engagedSessions: accumulator.engagedSessions + platform.engagedSessions,
      conversions: accumulator.conversions + platform.conversions,
    }),
    { sessions: 0, engagedSessions: 0, conversions: 0 },
  );

  const allSessions = metric(totalResponse.rows?.[0], 0);

  return {
    propertyId,
    startDate: range.startDate,
    endDate: range.endDate,
    totals: {
      ...totals,
      // A property with no traffic at all has no share to report — null, which the card renders as
      // "no sessions", never as a measured 0%.
      shareOfAllSessions: allSessions > 0 ? totals.sessions / allSessions : null,
    },
    platforms,
    allSessions,
    isFloor: true,
    platformsChecked: AI_REFERRERS.length,
  };
}
