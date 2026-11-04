import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { googleConnections } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import {
  extractSitemapEntries,
  extractSitemapLocations,
  isSitemapIndex,
} from '../audit-engine/storefront/html-parser.js';
import {
  clearGoogleRefusal,
  getGoogleConnection,
  getValidGoogleAccessToken,
  markIntegrationStatus,
  type GoogleConnection,
} from './google-oauth.service.js';

/**
 * ─── Google index coverage · what Google actually has ────────────────
 *
 * The AI Discovery pillar's other checks read what the store PUBLISHES. This reads what Google
 * CONFIRMS — page by page, from Google's own index, through the URL Inspection API.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS. A sitemap listing 189 URLs is a claim the store makes about
 * itself. Nothing in a sitemap, a robots.txt or a rendered page can tell you whether Google
 * accepted any of it. Search Console's performance report comes close, but it only ever shows pages
 * that earned an impression — a page indexed and never shown, and a page never indexed at all, look
 * identical there. This is the only call that distinguishes them.
 *
 * ─── No new permission, deliberately ─────────────────────────────────
 * URL Inspection reads through `webmasters.readonly`, which every existing Rankvora AI connection was
 * already granted. No merchant reconnects, no consent screen, no scope upgrade. That is the whole
 * reason this was built before the features that do need one.
 *
 * ─── The quota is real and is respected, not discovered ──────────────
 * Google allows roughly 2,000 inspections per property per day and 600 per minute. Those are not
 * generous for a catalogue of any size, so this service NEVER walks a whole sitemap: it samples,
 * the sample size is capped in code, and the response states how many of how many were inspected.
 * A coverage figure computed from a sample is labelled as one — `sampled`, never `total` — because
 * a merchant told "92% of your pages are indexed" will act on it as a census.
 *
 * ─── What this never does ────────────────────────────────────────────
 * It does not ask Google to index anything. There is no such call: the Indexing API accepts only
 * JobPosting and BroadcastEvent, and using it for products would be both ineffective and against
 * Google's stated terms. This reports; it does not submit.
 */

const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/**
 * Hard ceiling on URLs inspected in one request.
 *
 * Low on purpose. Each inspection is a billed quota unit against the merchant's own property, and a
 * page that silently burned 500 units because someone refreshed it would exhaust a day's allowance
 * in a few clicks.
 */
const MAX_SAMPLE = 25;
const DEFAULT_SAMPLE = 10;

/** Inspections issued at once. Google permits ~600/min; this stays far under while staying quick. */
const CONCURRENCY = 5;

/** A sitemap index can name many children; only this many are followed when sampling. */
const MAX_CHILD_SITEMAPS = 3;

/** Guards against a pathological sitemap. Matches the crawler's own posture on untrusted bodies. */
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const SITEMAP_TIMEOUT_MS = 15_000;

/**
 * Google's own verdict vocabulary, passed through unchanged.
 *
 * NOT remapped into Rankvora AI's HEALTHY/NEEDS_WORK statuses at this layer. `PARTIAL` and `NEUTRAL`
 * both mean something specific that neither of ours expresses, and flattening them here would put
 * a judgement into the data layer that the merchant can no longer see behind.
 */
export type InspectionVerdict = 'VERDICT_UNSPECIFIED' | 'PASS' | 'PARTIAL' | 'FAIL' | 'NEUTRAL';

export interface InspectedUrl {
  url: string;
  /** Google's top-level verdict for indexing. */
  verdict: InspectionVerdict;
  /**
   * Google's plain-language coverage state, e.g. "Submitted and indexed", "Crawled — currently not
   * indexed", "Discovered — currently not indexed". This is the sentence the merchant needs; the
   * verdict alone does not distinguish "not crawled yet" from "crawled and rejected".
   */
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  /** ISO timestamp of Google's last crawl. Null when Google has never fetched this URL. */
  lastCrawlTime: string | null;
  /** The URL Google treats as canonical, which may not be the one submitted. */
  googleCanonical: string | null;
  userCanonical: string | null;
  /** True only when coverageState says indexed. Derived once, here, so no caller re-derives it. */
  indexed: boolean;
  /** Set when this one URL could not be inspected; the others in the batch still return. */
  error: string | null;
}

export interface IndexCoverage {
  siteUrl: string;
  /** URLs found in the sitemap, before sampling. The population the sample describes. */
  sitemapUrlCount: number;
  /** How many were actually inspected. Always ≤ sitemapUrlCount and ≤ MAX_SAMPLE. */
  inspectedCount: number;
  indexedCount: number;
  notIndexedCount: number;
  /** Inspections that failed outright — excluded from both counts above, never counted as failures. */
  errorCount: number;
  /**
   * Indexed as a fraction of successfully inspected (0.92 = 92%).
   *
   * OF THE SAMPLE. Named `sampledIndexRate` rather than `indexRate` so no caller can mistake it for
   * a whole-catalogue figure — see the header.
   *
   * NULL when no inspection succeeded. It used to be 0, which the panel drew as a red "0% indexed"
   * for a run where Google answered for nothing — a verdict on every URL from zero answers.
   */
  sampledIndexRate: number | null;
  results: InspectedUrl[];
  /** True when the sitemap held more URLs than were inspected, so the UI can say so plainly. */
  isSample: boolean;
}

interface InspectionResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      pageFetchState?: string;
      lastCrawlTime?: string;
      googleCanonical?: string;
      userCanonical?: string;
    };
  };
}

/** The connection, refusing early when it cannot serve an inspection. */
async function requireInspectableConnection(storeId: number): Promise<GoogleConnection & { siteUrl: string }> {
  const connection = await getGoogleConnection(storeId);
  if (!connection) {
    throw new ApiError(409, 'Connect Google Search Console first.', 'GOOGLE_NOT_CONNECTED');
  }
  if (!connection.siteUrl) {
    throw new ApiError(
      409,
      'Choose which Search Console property this store reports on before inspecting URLs.',
      'GSC_SITE_NOT_SELECTED',
    );
  }
  return connection as GoogleConnection & { siteUrl: string };
}

/**
 * One inspection.
 *
 * Errors are RETURNED on the row rather than thrown, so one bad URL in a sample of ten does not
 * discard the nine that Google answered for. The two exceptions are 401 and 429: both describe the
 * connection or the quota rather than the URL, and continuing to hammer Google with the rest of the
 * batch would be wrong in each case.
 */
async function inspectOne(
  connection: GoogleConnection,
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<InspectedUrl> {
  const empty: InspectedUrl = {
    url: inspectionUrl,
    verdict: 'VERDICT_UNSPECIFIED',
    coverageState: null,
    robotsTxtState: null,
    indexingState: null,
    pageFetchState: null,
    lastCrawlTime: null,
    googleCanonical: null,
    userCanonical: null,
    indexed: false,
    error: null,
  };

  const response = await fetch(INSPECTION_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'en-US' }),
  });

  if (response.status === 401) {
    // The grant itself failed. Recorded on the shared connection, where providerHealth() reports it.
    await db
      .update(googleConnections)
      .set({ lastError: 'Reconnect Google to continue.' })
      .where(eq(googleConnections.id, connection.id));
    throw new ApiError(401, 'Reconnect Google to continue.', 'GOOGLE_REAUTH_REQUIRED');
  }

  if (response.status === 429) {
    throw new ApiError(
      429,
      'Google’s URL Inspection quota for this property is exhausted for today. It resets on Google’s schedule — roughly 2,000 inspections per property per day.',
      'GSC_INSPECTION_QUOTA',
    );
  }

  if (response.status === 403) {
    const reason =
      'That Google account cannot inspect URLs on this property, or the Search Console API is not enabled for this server.';
    await markIntegrationStatus(connection.storeId, 'search-console', 'needs_attention', reason);
    throw new ApiError(403, reason, 'GSC_ACCESS_DENIED');
  }

  if (!response.ok) {
    // Google's error bodies can name the property and the account, so the body is never surfaced.
    console.error(`[scorelo-google] URL Inspection returned HTTP ${response.status}`);
    return { ...empty, error: `Google returned HTTP ${response.status} for this URL.` };
  }

  const payload = (await response.json()) as InspectionResponse;
  const status = payload.inspectionResult?.indexStatusResult;
  if (!status) {
    return { ...empty, error: 'Google returned no index status for this URL.' };
  }

  const coverageState = status.coverageState ?? null;

  return {
    url: inspectionUrl,
    verdict: (status.verdict as InspectionVerdict) ?? 'VERDICT_UNSPECIFIED',
    coverageState,
    robotsTxtState: status.robotsTxtState ?? null,
    indexingState: status.indexingState ?? null,
    pageFetchState: status.pageFetchState ?? null,
    lastCrawlTime: status.lastCrawlTime ?? null,
    googleCanonical: status.googleCanonical ?? null,
    userCanonical: status.userCanonical ?? null,
    // Read off coverageState rather than the verdict. A PASS verdict accompanies several states
    // that are NOT "in the index" — most importantly "Crawled — currently not indexed", which is
    // the single most common real problem this feature exists to surface.
    indexed: coverageState ? /\bindexed\b/i.test(coverageState) && !/not indexed/i.test(coverageState) : false,
    error: null,
  };
}

/**
 * Runs inspections with a bounded number in flight.
 *
 * THE ACCESS TOKEN IS RESOLVED ONCE, HERE, AND NOT PER REQUEST. getValidGoogleAccessToken() decides
 * whether to refresh from the expiry on the connection object it is handed — so calling it inside
 * each worker would hand every one of them the same stale object, and an expired token would fire
 * CONCURRENCY simultaneous refreshes against Google with the same refresh token. Google rotates
 * refresh tokens, so the races are not harmless: the last write would win and could persist a
 * superseded token, leaving the connection unable to renew itself at all.
 */
async function inspectAll(
  connection: GoogleConnection,
  siteUrl: string,
  urls: string[],
): Promise<InspectedUrl[]> {
  const accessToken = await getValidGoogleAccessToken(connection);
  const results: InspectedUrl[] = new Array(urls.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const index = cursor++;
      results[index] = await inspectOne(connection, accessToken, siteUrl, urls[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return results;
}

/** Fetches one URL as text, bounded in both time and size. */
async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEMAP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Scorelo/1.0 (+https://scorelo.app/bot)' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const body = await response.text();
    return body.length > MAX_SITEMAP_BYTES ? body.slice(0, MAX_SITEMAP_BYTES) : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The store's sitemap URLs, following one level of sitemap index.
 *
 * Shopify publishes an INDEX at /sitemap.xml pointing at per-resource children, so a reader that
 * stopped at the top level would find zero page URLs on essentially every Shopify store and report
 * "no sitemap" for a store whose sitemap is perfectly fine.
 */
async function readSitemapUrls(origin: string): Promise<string[]> {
  const body = await fetchText(new URL('/sitemap.xml', origin).toString());
  if (!body) return [];

  if (!isSitemapIndex(body)) {
    return extractSitemapEntries(body).map((entry) => entry.loc);
  }

  const children = extractSitemapLocations(body).slice(0, MAX_CHILD_SITEMAPS);
  const bodies = await Promise.all(children.map((child) => fetchText(child)));

  const urls: string[] = [];
  for (const childBody of bodies) {
    if (!childBody) continue;
    urls.push(...extractSitemapEntries(childBody).map((entry) => entry.loc));
  }
  return urls;
}

/**
 * Picks an evenly spread sample rather than the first N.
 *
 * Sitemaps are ordered, and the first N URLs of a Shopify sitemap are the oldest products — the
 * ones most likely to be indexed. Sampling them would report a flattering, consistently wrong
 * figure. A stride across the whole list is the cheapest way to make the sample describe the
 * catalogue rather than its best-established corner.
 */
export function evenSample(urls: string[], size: number): string[] {
  if (urls.length <= size) return [...urls];
  const stride = urls.length / size;
  return Array.from({ length: size }, (_, index) => urls[Math.floor(index * stride)]!);
}

/**
 * Real Google index coverage for a sample of the store's own sitemap URLs.
 *
 * `origin` is the storefront the sitemap is read from — the caller passes the store's confirmed
 * primary URL, not the Search Console property, because `sc-domain:` properties carry no scheme
 * and cannot be fetched.
 */
export async function getIndexCoverage(
  storeId: number,
  origin: string,
  sampleSize = DEFAULT_SAMPLE,
): Promise<IndexCoverage> {
  const connection = await requireInspectableConnection(storeId);
  const size = Math.max(1, Math.min(MAX_SAMPLE, Math.trunc(sampleSize) || DEFAULT_SAMPLE));

  const sitemapUrls = await readSitemapUrls(origin);
  if (sitemapUrls.length === 0) {
    throw new ApiError(
      422,
      'No URLs could be read from this store’s sitemap, so there is nothing to inspect. Check that the storefront is public and /sitemap.xml returns XML.',
      'SITEMAP_EMPTY',
    );
  }

  const sample = evenSample(sitemapUrls, size);
  const results = await inspectAll(connection, connection.siteUrl, sample);

  // Google answered, which proves the grant works and the API is enabled — so a refusal recorded
  // earlier no longer describes this connection.
  await clearGoogleRefusal(storeId, 'search-console');

  const succeeded = results.filter((result) => !result.error);
  const indexedCount = succeeded.filter((result) => result.indexed).length;

  return {
    siteUrl: connection.siteUrl,
    sitemapUrlCount: sitemapUrls.length,
    inspectedCount: results.length,
    indexedCount,
    notIndexedCount: succeeded.length - indexedCount,
    errorCount: results.length - succeeded.length,
    // Denominator is successful inspections, not the sample size: a URL Google could not answer for
    // is not evidence that it is unindexed, and counting it as one would understate every run.
    sampledIndexRate: succeeded.length > 0 ? indexedCount / succeeded.length : null,
    results,
    isSample: sitemapUrls.length > results.length,
  };
}
