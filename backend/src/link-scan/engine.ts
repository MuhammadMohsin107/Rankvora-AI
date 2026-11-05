import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db, type BatchStatement } from '../db/client.js';
import { chunkForD1, groupForD1 } from '../db/limits.js';
import { linkScans, linkScanUrls, shopifyConnections, stores } from '../db/schema.js';
import { describeError } from '../lib/logger.js';
import { storedFacts } from '../services/store-profile.service.js';
import {
  extractLinks,
  extractSitemapEntries,
  extractSitemapLocations,
  isSitemapIndex,
} from '../audit-engine/storefront/html-parser.js';
import { isAllowed, parseRobots, type RobotsRules } from '../audit-engine/storefront/robots.js';
import { load, probe, type CheckResult, type RequestOptions } from './checker.js';
import { KeyedGate, pooled } from './pool.js';
import { hostsOf, isSitemapUrl, isStoreHost, normalizeLink, roleFor } from './url.js';

/**
 * ─── The complete link scan ──────────────────────────────────────────
 *
 * Loads EVERY page of a storefront, reads EVERY link on them, and requests EVERY distinct address those
 * links lead to — on the store and on other websites — exactly once, recording what each answered. It is
 * the whole store, not a sample, which is why it cannot run inside one request. It runs in BATCHES:
 *
 *   runLinkScanBatch(scanId)   does one bounded slice of the work and says whether more remains. All of
 *                              the scan's state is in link_scans and link_scan_urls, so the slices can run
 *                              anywhere, in any process, one after another: a Node loop (runLinkScanToEnd)
 *                              or a Cloudflare Workflow with a step per batch (worker.ts) — and a scan
 *                              that is interrupted carries on from the rows still 'pending'.
 *
 * What a batch does depends on where the scan is (link_scans.phase):
 *
 *   discovering   find the storefront's real address (a custom domain, a www, a password gate), read its
 *                 robots.txt and queue the homepage and the sitemap.
 *   crawling      load queued pages and sitemaps. A sitemap's addresses become pages; a page's links are
 *                 recorded against it, and every address they lead to is queued — as a PAGE when it is a
 *                 clean address on the store (so the crawl reaches pages no sitemap lists), otherwise as
 *                 a TARGET (another website, a file, a filtered or utility address) to be asked about.
 *   checking      request every queued target, politely: a few at a time, and never more than two to the
 *                 same website.
 *   finishing     total it up, mark the scan complete, tidy old scans.
 *
 * WHAT IT NEVER DOES: call an address broken because a robot was refused (outcome.ts), request an
 * address on a private network (network-guard.ts), or present a partial scan as complete — a ceiling on the
 * number of addresses (LINK_SCAN_MAX_URLS) that stopped it covering everything is recorded and shown.
 *
 * Each page's links are saved on the page's own row (`outlinks`), not as a row per link: a store with
 * 2,000 pages and 80 links on each would otherwise write 160,000 rows. "Which pages link to this broken
 * address?" is answered from that JSON when it is asked (link-scan.service.ts, sourcesOf), and "how many?"
 * is counted as the pages are read (`source_count`).
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ScanHosts {
  /** Every host that is the store. */
  list: string[];
  /** True when the storefront is behind its password and the operator supplied it (CRAWL_STOREFRONT_PASSWORD). */
  gated: boolean;
}

export interface Tally {
  ok: number;
  redirect: number;
  broken: number;
  blocked: number;
  unverified: number;
  skipped: number;
}

export interface ScanSummary {
  pagesCrawled: number;
  pagesPending: number;
  /** Every distinct address the scan has come across, sitemaps included. */
  urlsFound: number;
  /** How many of those have been answered. */
  urlsChecked: number;
  /** Every link found on every page, repeats included. */
  linksFound: number;
  sitemapsRead: number;
  internal: Tally;
  external: Tally;
}

export interface EngineLimits {
  maxUrls: number;
  crawlBatch: number;
  checkBatch: number;
  internalConcurrency: number;
  externalConcurrency: number;
  internalTimeoutMs: number;
  externalTimeoutMs: number;
}

export interface EngineDeps {
  /**
   * Where to look for the store: candidate storefront origins in order of preference, and the shop's own
   * myshopify.com host. Production reads these from what SHOPIFY reported for the shop — never from
   * anything a merchant typed — which is what keeps a scan from being pointed at someone else's website.
   */
  resolveEntry?: (storeId: number) => Promise<{ candidates: string[]; shopHost: string | null }>;
  /** Test seam: let the scan request addresses on a private network (the tests' own servers). */
  allowPrivateNetwork?: boolean;
  limits?: Partial<EngineLimits>;
}

type ScanRow = typeof linkScans.$inferSelect;
type UrlRow = typeof linkScanUrls.$inferSelect;

function limitsFor(deps: EngineDeps): EngineLimits {
  return {
    maxUrls: env.linkScanMaxUrls,
    crawlBatch: env.linkScanBatchPages,
    checkBatch: env.linkScanBatchChecks,
    internalConcurrency: env.crawlConcurrency,
    externalConcurrency: env.linkScanExternalConcurrency,
    internalTimeoutMs: env.crawlTimeoutMs,
    externalTimeoutMs: env.linkScanExternalTimeoutMs,
    ...deps.limits,
  };
}

function log(event: string, fields: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  const line = `[scorelo-links] ${event} ${JSON.stringify(fields)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const ACTIVE = ['queued', 'running'] as const;
/** Writes in one db.batch(), so a batch stays well inside what a Worker may send. Each group is complete units of work. */
const STATEMENTS_PER_BATCH = 80;
/** Links kept per page. Past this a page is a link farm, and its row would outgrow D1's row size. */
const MAX_OUTLINKS_PER_PAGE = 2_000;
/**
 * Characters of a page's saved links. D1 refuses a row over 2 MB, and a page of 2,000 links with long query
 * strings can reach it — which would fail the whole batch, every time it was tried. Under this the row always fits.
 */
const MAX_OUTLINKS_CHARACTERS = 900_000;
const ANCHOR_LENGTH = 80;
/** Scans kept per store, newest first. */
const SCANS_KEPT = 3;

// ─── Starting from what Shopify says ─────────────────────────────────

/**
 * The addresses a store's storefront may be found at, from what Shopify reported: its primary domain
 * (stores.shopify_profile.url) and its own myshopify.com address, which redirects to the primary one.
 */
async function defaultResolveEntry(storeId: number): Promise<{ candidates: string[]; shopHost: string | null }> {
  const [connection] = await db
    .select({ shopDomain: shopifyConnections.shopDomain })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  if (!connection) return { candidates: [], shopHost: null };
  const [store] = await db.select({ profile: stores.shopifyProfile }).from(stores).where(eq(stores.id, storeId)).limit(1);
  const facts = storedFacts(store?.profile);
  const candidates: string[] = [];
  // Facts about a DIFFERENT shop (the store was reconnected to another one) are not this shop's address.
  if (facts?.url && facts.shopDomain.toLowerCase() === connection.shopDomain.toLowerCase()) candidates.push(facts.url);
  candidates.push(`https://${connection.shopDomain}`);
  const origins = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
    } catch {
      // An unparseable address is not a candidate.
    }
  }
  return { candidates: [...origins], shopHost: connection.shopDomain.toLowerCase() };
}

// ─── Reading and writing the scan ────────────────────────────────────

async function loadScan(scanId: number): Promise<ScanRow | undefined> {
  const [scan] = await db.select().from(linkScans).where(eq(linkScans.id, scanId)).limit(1);
  return scan;
}

/**
 * One page's (or one answer's) worth of writes.
 *
 * `idempotent` statements may be repeated and may be split across batches: adding addresses the scan
 * already holds changes nothing. `atomic` statements are written together in ONE batch — a page's source
 * counts and the mark that says it is done — because counting a page twice is exactly what a repeated
 * batch must not do. A batch that fails part-way therefore leaves each page either fully recorded, or still
 * pending and safe to do again.
 */
interface Unit {
  idempotent: BatchStatement[];
  atomic: BatchStatement[];
}

/** Writes units in order, in db.batch() calls of at most STATEMENTS_PER_BATCH statements. */
async function runBatches(units: Unit[]): Promise<void> {
  let group: BatchStatement[] = [];
  const flush = async () => {
    if (group.length > 0) await db.batch(group as [BatchStatement, ...BatchStatement[]]);
    group = [];
  };
  const add = async (statements: BatchStatement[]) => {
    if (group.length > 0 && group.length + statements.length > STATEMENTS_PER_BATCH) await flush();
    group.push(...statements);
  };
  for (const unit of units) {
    for (let start = 0; start < unit.idempotent.length; start += STATEMENTS_PER_BATCH) {
      await add(unit.idempotent.slice(start, start + STATEMENTS_PER_BATCH));
    }
    await add(unit.atomic);
  }
  await flush();
}

function emptyTally(): Tally {
  return { ok: 0, redirect: 0, broken: 0, blocked: 0, unverified: 0, skipped: 0 };
}

/**
 * Counts what the scan holds and writes it, with the progress bar, the stage line and the heartbeat. One
 * grouped read — never a count per outcome. `linksAdded` is how many links the batch just read.
 */
async function tally(scan: ScanRow, phase: ScanRow['phase'], linksAdded = 0, extra: Partial<typeof linkScans.$inferInsert> = {}): Promise<ScanSummary> {
  const groups = await db
    .select({
      internal: linkScanUrls.internal,
      role: linkScanUrls.role,
      state: linkScanUrls.state,
      outcome: linkScanUrls.outcome,
      n: count(),
    })
    .from(linkScanUrls)
    .where(eq(linkScanUrls.scanId, scan.id))
    .groupBy(linkScanUrls.internal, linkScanUrls.role, linkScanUrls.state, linkScanUrls.outcome);

  const previous = (scan.summary ?? null) as Partial<ScanSummary> | null;
  const summary: ScanSummary = {
    pagesCrawled: 0,
    pagesPending: 0,
    urlsFound: 0,
    urlsChecked: 0,
    linksFound: (previous?.linksFound ?? 0) + linksAdded,
    sitemapsRead: 0,
    internal: emptyTally(),
    external: emptyTally(),
  };
  let targetsTotal = 0;
  let targetsDone = 0;
  for (const group of groups) {
    summary.urlsFound += group.n;
    if (group.state === 'done') summary.urlsChecked += group.n;
    if (group.role === 'sitemap') {
      if (group.state === 'done') summary.sitemapsRead += group.n;
      continue;
    }
    if (group.role === 'page') {
      if (group.state === 'done') summary.pagesCrawled += group.n;
      else summary.pagesPending += group.n;
    } else {
      targetsTotal += group.n;
      if (group.state === 'done') targetsDone += group.n;
    }
    if (group.state === 'done' && group.outcome) {
      const bucket = group.internal ? summary.internal : summary.external;
      bucket[group.outcome as keyof Tally] += group.n;
    }
  }

  const pagesTotal = summary.pagesCrawled + summary.pagesPending;
  let progress = 2;
  let stage = 'Finding your pages';
  if (phase === 'crawling') {
    progress = 4 + 56 * (summary.pagesCrawled / Math.max(1, pagesTotal));
    stage = `Loading your pages — ${summary.pagesCrawled.toLocaleString('en-US')} of ${pagesTotal.toLocaleString('en-US')} found so far`;
  } else if (phase === 'checking') {
    progress = 60 + 38 * (targetsDone / Math.max(1, targetsTotal));
    stage = `Checking links — ${targetsDone.toLocaleString('en-US')} of ${targetsTotal.toLocaleString('en-US')}`;
  } else if (phase === 'finishing') {
    progress = 99;
    stage = 'Finishing';
  }

  await db
    .update(linkScans)
    .set({
      phase,
      // The bar never moves backwards: pages found while crawling raise the total it is measured against.
      progress: Math.max(scan.progress, Math.min(99, Math.round(progress))),
      stage,
      summary,
      updatedAt: new Date(),
      ...extra,
    })
    .where(and(eq(linkScans.id, scan.id), inArray(linkScans.status, [...ACTIVE])));
  return summary;
}

// ─── Requests ────────────────────────────────────────────────────────

function requestOptions(scan: ScanRow, deps: EngineDeps, limits: EngineLimits, internal: boolean, cookie: string | null): RequestOptions {
  const hosts = (scan.hosts as ScanHosts | null)?.list ?? [];
  return {
    userAgent: env.crawlUserAgent,
    timeoutMs: internal ? limits.internalTimeoutMs : limits.externalTimeoutMs,
    internal,
    allowPrivateNetwork: deps.allowPrivateNetwork,
    cookie,
    cookieHosts: hosts,
  };
}

/** Opens a password-protected storefront with the password the operator supplied. Returns the cookie, or null. */
async function unlock(origin: string, limits: EngineLimits): Promise<string | null> {
  const password = env.crawlStorefrontPassword;
  if (!password) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.internalTimeoutMs);
  try {
    const response = await fetch(`${origin}/password`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': env.crawlUserAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
    });
    const digest = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]!).filter((entry) => entry.startsWith('storefront_digest='));
    return digest.length > 0 ? digest.join('; ') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Starting ────────────────────────────────────────────────────────

async function failScan(scanId: number, message: string): Promise<void> {
  await db
    .update(linkScans)
    .set({ status: 'failed', error: message, stage: 'Stopped', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(linkScans.id, scanId), inArray(linkScans.status, [...ACTIVE])));
  log('scan.failed', { scanId, error: message }, 'warn');
}

/** Inserts addresses, ignoring any the scan already holds. Groups stay inside D1's bound-value limit. */
function insertStatements(scanId: number, rows: Array<{ url: string; role: 'page' | 'sitemap' | 'target'; internal: boolean; inSitemap: boolean }>): BatchStatement[] {
  const values = rows.map((row) => ({ scanId, url: row.url, role: row.role, internal: row.internal, inSitemap: row.inSitemap }));
  const groups = groupForD1(values, (row) => db.insert(linkScanUrls).values(row).toSQL().params.length);
  return groups.map((group) => db.insert(linkScanUrls).values(group).onConflictDoNothing());
}

async function discover(scan: ScanRow, deps: EngineDeps, limits: EngineLimits): Promise<void> {
  const entry = await (deps.resolveEntry ?? defaultResolveEntry)(scan.storeId);
  if (entry.candidates.length === 0) {
    await failScan(scan.id, 'This store is not connected to Shopify, so there is no storefront to check.');
    return;
  }

  let origin: string | null = null;
  let gated = false;
  let cookie: string | null = null;
  let lastProblem = 'it did not answer';

  for (const candidate of entry.candidates) {
    const host = new URL(candidate).host.toLowerCase();
    const options: RequestOptions = {
      userAgent: env.crawlUserAgent,
      timeoutMs: limits.internalTimeoutMs,
      internal: true,
      allowPrivateNetwork: deps.allowPrivateNetwork,
      cookieHosts: [host],
    };
    let result = await load(`${candidate}/`, 'html', options);
    if (result.reason === 'password_protected') {
      cookie = await unlock(candidate, limits);
      if (cookie) {
        gated = true;
        result = await load(`${candidate}/`, 'html', { ...options, cookie, cookieHosts: [host, new URL(result.finalUrl ?? candidate).host.toLowerCase()] });
      }
    }
    if (result.outcome === 'ok' || result.outcome === 'redirect') {
      origin = new URL(result.finalUrl ?? `${candidate}/`).origin;
      break;
    }
    if (result.reason === 'password_protected') {
      await failScan(
        scan.id,
        'Your storefront is password protected, so Rankvora AI cannot load any of your pages. Remove the password under Online Store → Preferences in Shopify, then scan again.',
      );
      return;
    }
    lastProblem = result.detail ?? lastProblem;
  }

  if (!origin) {
    await failScan(scan.id, `Rankvora AI could not open your storefront — ${lastProblem.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())} — so no links could be checked. Try again in a few minutes.`);
    return;
  }

  const originHost = new URL(origin).host.toLowerCase();
  const hosts: ScanHosts = {
    list: hostsOf(originHost, entry.shopHost, ...entry.candidates.map((candidate) => new URL(candidate).host)),
    gated,
  };

  // robots.txt decides which pages may be LOADED to read their links. Shopify's default one fences off the cart,
  // checkout, account, search and filtered collection addresses, which hold no content to find. It does not
  // decide which addresses may be ASKED ABOUT: a status check of a link is what a browser's prefetch does.
  const robotsDoc = await load(`${origin}/robots.txt`, 'xml', {
    userAgent: env.crawlUserAgent,
    timeoutMs: limits.internalTimeoutMs,
    internal: true,
    allowPrivateNetwork: deps.allowPrivateNetwork,
    cookie,
    cookieHosts: hosts.list,
  });
  const parsed = robotsDoc.body ? parseRobots(robotsDoc.body, env.crawlUserAgent) : { rules: [], crawlDelaySeconds: null, sitemaps: [] };

  const sitemaps = new Set<string>([`${origin}/sitemap.xml`]);
  for (const found of parsed.sitemaps) {
    const normalized = normalizeLink(found);
    if (normalized && isStoreHost(hosts.list, new URL(normalized).host)) sitemaps.add(normalized);
  }

  const seeds: BatchStatement[] = [
    ...insertStatements(scan.id, [
      { url: `${origin}/`, role: 'page', internal: true, inSitemap: false },
      ...[...sitemaps].map((url) => ({ url, role: 'sitemap' as const, internal: true, inSitemap: false })),
    ]),
    db
      .update(linkScans)
      .set({ origin, hosts, robots: { rules: parsed.rules, crawlDelaySeconds: parsed.crawlDelaySeconds, sitemaps: [...sitemaps] }, updatedAt: new Date() })
      .where(eq(linkScans.id, scan.id)),
  ];
  await db.batch(seeds as [BatchStatement, ...BatchStatement[]]);
  await tally({ ...scan, origin, hosts }, 'crawling');
  log('scan.discovered', { scanId: scan.id, origin, hosts: hosts.list.length, sitemaps: sitemaps.size, gated });
}

// ─── Crawling ────────────────────────────────────────────────────────

interface Found {
  url: string;
  role: 'page' | 'sitemap' | 'target';
  internal: boolean;
  inSitemap: boolean;
}

interface Crawled {
  row: UrlRow;
  result: CheckResult;
  found: Found[];
  /** The links on the page, [address, anchor], first sighting of each address only. */
  outlinks: Array<[string, string]> | null;
  linkCount: number;
}

function foundIsPage(url: string, robots: RobotsRules): boolean {
  if (roleFor(url) !== 'page') return false;
  try {
    return isAllowed(robots, new URL(url).pathname);
  } catch {
    return false;
  }
}

async function crawlOne(row: UrlRow, scan: ScanRow, robots: RobotsRules, hosts: ScanHosts, options: RequestOptions): Promise<Crawled> {
  const origin = scan.origin!;
  const found: Found[] = [];

  if (row.role === 'sitemap') {
    const document = await load(row.url, 'xml', options);
    if (document.body) {
      if (isSitemapIndex(document.body)) {
        for (const location of extractSitemapLocations(document.body)) {
          const url = normalizeLink(location);
          if (url && isStoreHost(hosts.list, new URL(url).host)) found.push({ url, role: 'sitemap', internal: true, inSitemap: false });
        }
      } else {
        for (const entry of extractSitemapEntries(document.body)) {
          const url = normalizeLink(entry.loc);
          if (!url || !isStoreHost(hosts.list, new URL(url).host)) continue;
          // A sitemap lists addresses the store itself says are pages. One robots.txt fences off is still listed — and still asked about.
          found.push({ url, role: isSitemapUrl(url) ? 'sitemap' : foundIsPage(url, robots) ? 'page' : 'target', internal: true, inSitemap: true });
        }
      }
    }
    return { row, result: document, found, outlinks: null, linkCount: 0 };
  }

  const document = await load(row.url, 'html', options);
  let outlinks: Array<[string, string]> | null = null;
  let linkCount = 0;
  if (document.body) {
    const pageUrl = document.finalUrl ?? row.url;
    const landedOn = normalizeLink(pageUrl) ?? pageUrl;
    if (!isStoreHost(hosts.list, new URL(pageUrl).host)) {
      // A page that redirected to another website has nothing of the store's to read.
    } else if (landedOn !== (normalizeLink(row.url) ?? row.url)) {
      // A redirect to another page of the store. That page is read once, under its own address: reading its
      // links here as well would count every one of them twice (and again for each address that redirects to it).
      found.push({ url: landedOn, role: foundIsPage(landedOn, robots) ? 'page' : 'target', internal: true, inSitemap: false });
    } else {
      const seen = new Set<string>([landedOn]);
      outlinks = [];
      let characters = 0;
      for (const link of extractLinks(document.body, pageUrl, origin)) {
        linkCount += 1;
        const url = normalizeLink(link.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const anchor = link.text.slice(0, ANCHOR_LENGTH);
        characters += url.length + anchor.length + 8;
        if (outlinks.length >= MAX_OUTLINKS_PER_PAGE || characters > MAX_OUTLINKS_CHARACTERS) continue;
        outlinks.push([url, anchor]);
        const internal = isStoreHost(hosts.list, new URL(url).host);
        found.push({ url, role: internal ? (isSitemapUrl(url) ? 'target' : foundIsPage(url, robots) ? 'page' : 'target') : 'target', internal, inSitemap: false });
      }
    }
  }
  return { row, result: document, found, outlinks, linkCount };
}

async function crawlBatch(scan: ScanRow, rows: UrlRow[], deps: EngineDeps, limits: EngineLimits): Promise<void> {
  const hosts = scan.hosts as ScanHosts;
  const rules = scan.robots as { rules: RobotsRules['rules']; crawlDelaySeconds: number | null; sitemaps: string[] } | null;
  const robots: RobotsRules = { rules: rules?.rules ?? [], crawlDelaySeconds: rules?.crawlDelaySeconds ?? null, sitemaps: rules?.sitemaps ?? [], fetched: Boolean(rules) };
  const cookie = hosts.gated ? await unlock(scan.origin!, limits) : null;
  const options = requestOptions(scan, deps, limits, true, cookie);

  const crawled = await pooled(rows, limits.internalConcurrency, (row) => crawlOne(row, scan, robots, hosts, options));

  // Room left for new addresses. Counted once, then spent as pages are planned.
  const [{ total }] = (await db.select({ total: count() }).from(linkScanUrls).where(eq(linkScanUrls.scanId, scan.id))) as [{ total: number }];
  let room = Math.max(0, limits.maxUrls - total);
  let limitHit = false;
  const planned = new Set<string>();
  const now = new Date();
  const units: Unit[] = [];
  let linksAdded = 0;

  for (const page of crawled) {
    const unit: Unit = { idempotent: [], atomic: [] };
    // New addresses first, and only ones nobody in this batch has already queued: a navigation menu is on every page.
    const fresh: Found[] = [];
    const sitemapListed: string[] = [];
    for (const item of page.found) {
      if (item.inSitemap) sitemapListed.push(item.url);
      if (planned.has(item.url)) continue;
      if (room <= 0) {
        limitHit = true;
        continue;
      }
      planned.add(item.url);
      room -= 1;
      fresh.push(item);
    }
    // Pages and sitemaps are queued before targets, so when the ceiling bites it is the targets that are left out.
    fresh.sort((a, b) => Number(b.role !== 'target') - Number(a.role !== 'target'));
    unit.idempotent.push(...insertStatements(scan.id, fresh));
    // An address the sitemap lists is marked so, even when a page's link had queued it first.
    for (const group of chunkForD1(sitemapListed, 80)) {
      unit.atomic.push(db.update(linkScanUrls).set({ inSitemap: true }).where(and(eq(linkScanUrls.scanId, scan.id), inArray(linkScanUrls.url, group))));
    }
    // One more page links to each address this page links to.
    if (page.outlinks && page.outlinks.length > 0) {
      for (const group of chunkForD1(page.outlinks.map(([url]) => url), 80)) {
        unit.atomic.push(
          db
            .update(linkScanUrls)
            .set({ sourceCount: sql`COALESCE(${linkScanUrls.sourceCount}, 0) + 1` })
            .where(and(eq(linkScanUrls.scanId, scan.id), inArray(linkScanUrls.url, group))),
        );
      }
    }
    unit.atomic.push(
      db
        .update(linkScanUrls)
        .set({
          state: 'done',
          outcome: page.result.outcome,
          status: page.result.status,
          finalUrl: page.result.finalUrl,
          hops: page.result.hops,
          reason: page.result.reason,
          detail: page.result.detail,
          outlinks: page.outlinks ? JSON.stringify(page.outlinks) : null,
          checkedAt: now,
        })
        // 'pending' is re-checked so a page already recorded (a repeated batch) is never counted twice.
        .where(and(eq(linkScanUrls.id, page.row.id), eq(linkScanUrls.state, 'pending'))),
    );
    linksAdded += page.linkCount;
    units.push(unit);
  }

  await runBatches(units);
  await tally(scan, 'crawling', linksAdded, limitHit ? { limitReached: 'urls' } : {});
}

// ─── Checking ────────────────────────────────────────────────────────

/** Orders addresses so that neighbouring ones are on different hosts — a pool then never queues behind one host. */
function interleaveByHost(rows: UrlRow[]): UrlRow[] {
  const byHost = new Map<string, UrlRow[]>();
  for (const row of rows) {
    let host = '';
    try {
      host = new URL(row.url).hostname;
    } catch {
      // An unparseable address groups with the others like it.
    }
    byHost.set(host, [...(byHost.get(host) ?? []), row]);
  }
  const queues = [...byHost.values()];
  const ordered: UrlRow[] = [];
  for (let round = 0; ordered.length < rows.length; round += 1) {
    for (const queue of queues) if (queue[round]) ordered.push(queue[round]!);
  }
  return ordered;
}

async function checkBatch(scan: ScanRow, rows: UrlRow[], deps: EngineDeps, limits: EngineLimits): Promise<void> {
  const hosts = scan.hosts as ScanHosts;
  const cookie = hosts.gated ? await unlock(scan.origin!, limits) : null;
  const internalOptions = requestOptions(scan, deps, limits, true, cookie);
  const externalOptions = requestOptions(scan, deps, limits, false, null);

  const internalRows = rows.filter((row) => row.internal);
  const externalRows = interleaveByHost(rows.filter((row) => !row.internal));
  // Two requests to one website at a time, however many of its links there are.
  const gate = new KeyedGate(2);

  const [internal, external] = await Promise.all([
    pooled(internalRows, limits.internalConcurrency, async (row) => ({ row, result: await probe(row.url, internalOptions) })),
    pooled(externalRows, limits.externalConcurrency, async (row) => {
      let host = row.url;
      try {
        host = new URL(row.url).hostname;
      } catch {
        // Keyed by the whole address when it has no host.
      }
      return gate.run(host, async () => ({ row, result: await probe(row.url, externalOptions) }));
    }),
  ]);

  const now = new Date();
  const units: Unit[] = [...internal, ...external].map(({ row, result }) => ({
    idempotent: [],
    atomic: [
      db
        .update(linkScanUrls)
        .set({
          state: 'done',
          outcome: result.outcome,
          status: result.status,
          finalUrl: result.finalUrl,
          hops: result.hops,
          reason: result.reason,
          detail: result.detail,
          checkedAt: now,
        })
        .where(and(eq(linkScanUrls.id, row.id), eq(linkScanUrls.state, 'pending'))),
    ],
  }));
  await runBatches(units);
  await tally(scan, 'checking');
}

// ─── Finishing ───────────────────────────────────────────────────────

async function finish(scan: ScanRow): Promise<void> {
  const summary = await tally(scan, 'finishing');
  const done = await db
    .update(linkScans)
    .set({ status: 'completed', phase: 'finishing', progress: 100, stage: 'Complete', finishedAt: new Date(), updatedAt: new Date(), summary })
    .where(and(eq(linkScans.id, scan.id), eq(linkScans.status, 'running')))
    .returning({ id: linkScans.id });
  if (done.length === 0) return;
  log('scan.completed', { scanId: scan.id, storeId: scan.storeId, pages: summary.pagesCrawled, urls: summary.urlsFound, brokenInternal: summary.internal.broken, brokenExternal: summary.external.broken, limitReached: scan.limitReached });

  // Old scans go: only the newest few are ever shown, and each holds a row for every address of a store.
  try {
    const keep = await db.select({ id: linkScans.id }).from(linkScans).where(eq(linkScans.storeId, scan.storeId)).orderBy(desc(linkScans.id)).limit(SCANS_KEPT);
    await db.delete(linkScans).where(and(eq(linkScans.storeId, scan.storeId), notInArray(linkScans.id, keep.map((row) => row.id)), notInArray(linkScans.status, [...ACTIVE])));
  } catch (error) {
    log('scan.cleanup_failed', { scanId: scan.id, error: describeError(error) }, 'warn');
  }
}

// ─── The batch ───────────────────────────────────────────────────────

/**
 * Does one slice of a scan's work. Resolves `{ done: true }` when there is nothing left to do — the scan
 * completed, failed, or was cancelled — and `{ done: false }` when another call is needed.
 *
 * Safe to call again after it threw part-way: every row it changes is only changed from 'pending', and a
 * page's changes are written together, so a repeated batch repeats nothing that was already recorded.
 */
export async function runLinkScanBatch(scanId: number, deps: EngineDeps = {}): Promise<{ done: boolean }> {
  const limits = limitsFor(deps);
  let scan = await loadScan(scanId);
  if (!scan || !ACTIVE.includes(scan.status as (typeof ACTIVE)[number])) return { done: true };

  if (scan.status === 'queued') {
    await db.update(linkScans).set({ status: 'running', startedAt: new Date(), updatedAt: new Date(), stage: 'Finding your pages' }).where(and(eq(linkScans.id, scanId), eq(linkScans.status, 'queued')));
    scan = (await loadScan(scanId))!;
    if (scan.status !== 'running') return { done: true };
  }

  if (!scan.origin) {
    await discover(scan, deps, limits);
    return { done: (await loadScan(scanId))?.status !== 'running' };
  }

  const pages = await db
    .select()
    .from(linkScanUrls)
    .where(and(eq(linkScanUrls.scanId, scanId), eq(linkScanUrls.state, 'pending'), inArray(linkScanUrls.role, ['page', 'sitemap'])))
    .orderBy(asc(linkScanUrls.id))
    .limit(limits.crawlBatch);
  if (pages.length > 0) {
    await crawlBatch(scan, pages, deps, limits);
    return { done: false };
  }

  const targets = await db
    .select()
    .from(linkScanUrls)
    .where(and(eq(linkScanUrls.scanId, scanId), eq(linkScanUrls.state, 'pending'), eq(linkScanUrls.role, 'target')))
    .orderBy(asc(linkScanUrls.id))
    .limit(limits.checkBatch);
  if (targets.length > 0) {
    await checkBatch(scan, targets, deps, limits);
    return { done: false };
  }

  await finish(scan);
  return { done: true };
}

/**
 * Runs a whole scan in this process: batch after batch until it is done. For Node — a Cloudflare Workflow
 * runs the same batches, one per step (worker.ts). Never throws: a failure is written on the scan.
 */
export async function runLinkScanToEnd(scanId: number, deps: EngineDeps = {}): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const { done } = await runLinkScanBatch(scanId, deps);
      if (done) return;
      failures = 0;
    } catch (error) {
      failures += 1;
      log('scan.batch_failed', { scanId, attempt: failures, error: describeError(error) }, 'warn');
      // A batch that failed is repeated — it repeats nothing that was recorded — but not for ever.
      if (failures >= 3) {
        await failScan(scanId, 'The link scan stopped because of an error on the Rankvora AI server. Please run it again.');
        return;
      }
    }
  }
}
