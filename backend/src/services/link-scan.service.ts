import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { insertReturning } from '../db/returning.js';
import { linkScans, linkScanUrls, shopifyConnections } from '../db/schema.js';
import { hasStoreDataSource } from '../audit-engine/store-data/index.js';
import { runLinkScanToEnd, type ScanSummary } from '../link-scan/engine.js';
import { describeError, describeErrorWithStack } from '../lib/logger.js';
import { ApiError } from '../middleware/error.js';
import type { LinkScanLinksQuery } from '../schemas/link-scan.schema.js';
import { escapeCsv } from './report.service.js';
import { getCurrentStoreId } from './store.service.js';

/**
 * ─── Link scans: starting, reading and stopping them ─────────────────
 *
 * The engine (link-scan/engine.ts) does the scanning. This is everything around it that a request, an
 * audit or the scheduled sweep needs:
 *
 *   start*            create the scan row and hand it to whatever runs scans here — a loop in this process
 *                     on Node, a Cloudflare Workflow on Workers (worker.ts swaps the starter in).
 *   get* / list*      what the Internal Links page shows: the scan, its totals, the addresses with a
 *                     problem, and the pages that contain each one.
 *   cancel / export   stop one; download its results.
 *   failStuck*        close out scans whose heartbeat stopped.
 *
 * Every read is scoped to the caller's own store (getCurrentStoreId), and a scan id from another
 * merchant's store is a plain 404.
 */

export type LinkScanStarter = (scan: { id: number; storeId: number }) => Promise<void>;

const runInThisProcess: LinkScanStarter = async (scan) => {
  // Fire-and-forget, like an audit: the request returns at once and the page polls. runLinkScanToEnd never
  // throws — it writes any failure on the scan — so this catch is only the net under that.
  void runLinkScanToEnd(scan.id).catch((error) => {
    console.error(`[scorelo-links] scan ${scan.id} (store ${scan.storeId}) crashed outside its own error handling — ${describeErrorWithStack(error)}`);
  });
};

let startScan: LinkScanStarter = runInThisProcess;

/** Replaces how scans are run. Called by worker.ts; Node keeps the in-process default. */
export function useLinkScanStarter(starter: LinkScanStarter): void {
  startScan = starter;
}

type ScanRow = typeof linkScans.$inferSelect;
type UrlRow = typeof linkScanUrls.$inferSelect;

/** A scan as the API shows it. The scan's working state (hosts, robots rules) stays inside. */
export function toPublicScan(scan: ScanRow) {
  return {
    id: scan.id,
    status: scan.status,
    trigger: scan.trigger,
    phase: scan.phase,
    origin: scan.origin,
    progress: scan.progress,
    stage: scan.stage,
    limitReached: scan.limitReached,
    summary: (scan.summary ?? null) as ScanSummary | null,
    error: scan.error,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    createdAt: scan.createdAt,
  };
}

function toPublicUrl(row: UrlRow) {
  return {
    id: row.id,
    url: row.url,
    internal: row.internal,
    role: row.role,
    inSitemap: row.inSitemap,
    outcome: row.outcome,
    status: row.status,
    finalUrl: row.finalUrl,
    hops: row.hops,
    reason: row.reason,
    detail: row.detail,
    sourceCount: row.sourceCount,
    checkedAt: row.checkedAt,
  };
}

// ─── Starting ────────────────────────────────────────────────────────

/** Hands a freshly created scan to the runner, or closes it out if it cannot be started — so a scan that never started never blocks the next one. */
async function launch(scan: { id: number; storeId: number }): Promise<void> {
  try {
    await startScan(scan);
  } catch (error) {
    console.error(`[scorelo-links] scan ${scan.id} (store ${scan.storeId}) could not be started — ${describeErrorWithStack(error)}`);
    await db
      .update(linkScans)
      .set({ status: 'failed', error: `The link scan could not be started: ${describeError(error)}`, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(linkScans.id, scan.id));
    throw new ApiError(503, 'The link scan could not be started. Please try again in a moment.', 'LINK_SCAN_START_FAILED');
  }
}

/** The myshopify.com domain of the shop connected to a store now, or null when there is none. */
async function connectedShop(storeId: number): Promise<string | null> {
  const [connection] = await db
    .select({ shopDomain: shopifyConnections.shopDomain })
    .from(shopifyConnections)
    .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
    .limit(1);
  return connection?.shopDomain.toLowerCase() ?? null;
}

async function createScan(storeId: number, trigger: 'manual' | 'audit' | 'schedule'): Promise<ScanRow> {
  try {
    return await insertReturning(linkScans, { storeId, trigger, shopDomain: await connectedShop(storeId) });
  } catch (error) {
    // link_scans_store_active_unique_idx: a second active scan for this store, from a request that raced this one.
    if (isUniqueViolation(error)) throw new ApiError(409, 'A link scan is already running for this store', 'LINK_SCAN_IN_PROGRESS');
    throw error;
  }
}

/** Starts a scan for the caller's store. */
export async function startLinkScan(userId: number, storeId?: number) {
  if (!env.linkScanEnabled) throw new ApiError(503, 'Link scans are switched off on this server.', 'LINK_SCAN_DISABLED');
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  if (!(await hasStoreDataSource(resolvedStoreId))) {
    throw new ApiError(400, 'Connect a Shopify store before scanning its links', 'STORE_NOT_CONNECTED');
  }
  const [active] = await db
    .select({ id: linkScans.id })
    .from(linkScans)
    .where(and(eq(linkScans.storeId, resolvedStoreId), inArray(linkScans.status, ['queued', 'running'])))
    .limit(1);
  if (active) throw new ApiError(409, 'A link scan is already running for this store', 'LINK_SCAN_IN_PROGRESS');

  const scan = await createScan(resolvedStoreId, 'manual');
  await launch({ id: scan.id, storeId: resolvedStoreId });
  return toPublicScan(scan);
}

/**
 * Starts a scan on the store's behalf when an audit has just finished — so the results are there
 * without anyone pressing a button. Does nothing, and says so by returning false, when scans are off,
 * the store has no live connection, one is already running, or the last one started less than
 * LINK_SCAN_AUTO_MIN_HOURS ago. Never throws: it runs at the end of an audit, which has already succeeded.
 */
export async function startAutoLinkScan(storeId: number): Promise<boolean> {
  if (!env.linkScanEnabled || !env.linkScanAuto) return false;
  try {
    if (!(await hasStoreDataSource(storeId))) return false;
    const [latest] = await db.select().from(linkScans).where(eq(linkScans.storeId, storeId)).orderBy(desc(linkScans.id)).limit(1);
    if (latest && (latest.status === 'queued' || latest.status === 'running')) return false;
    if (latest && Date.now() - latest.createdAt.getTime() < env.linkScanAutoMinHours * 3_600_000) return false;
    const scan = await createScan(storeId, 'audit');
    await launch({ id: scan.id, storeId });
    return true;
  } catch (error) {
    console.warn(`[scorelo-links] could not start the scan after the audit (store ${storeId}) — ${describeError(error)}`);
    return false;
  }
}

// ─── Reading ─────────────────────────────────────────────────────────

async function ownScan(userId: number, scanId: number, storeId?: number): Promise<ScanRow> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [scan] = await db.select().from(linkScans).where(and(eq(linkScans.id, scanId), eq(linkScans.storeId, resolvedStoreId))).limit(1);
  if (!scan) throw new ApiError(404, 'Link scan not found', 'LINK_SCAN_NOT_FOUND');
  return scan;
}

/**
 * The store's newest scan, whatever state it is in — or null when it has never been scanned, which is a
 * state the page shows, not an error. `lastCompleted` is the newest one that finished, so the page can
 * keep showing real results while a new scan is running.
 *
 * Only scans of the shop connected NOW are shown. A store row keeps its history across Disconnect, and a
 * different shop can be connected to it: the old shop's broken links would otherwise be presented as the new
 * one's. With no connection the store's own history is still its own, and is shown as it was.
 */
export async function getLatestLinkScan(userId: number, storeId?: number) {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const shop = await connectedShop(resolvedStoreId);
  const ofThisStore = shop
    ? and(eq(linkScans.storeId, resolvedStoreId), eq(linkScans.shopDomain, shop))
    : eq(linkScans.storeId, resolvedStoreId);
  const [latest] = await db.select().from(linkScans).where(ofThisStore).orderBy(desc(linkScans.id)).limit(1);
  if (!latest) return { latest: null, lastCompleted: null };
  if (latest.status === 'completed') return { latest: toPublicScan(latest), lastCompleted: toPublicScan(latest) };
  const [completed] = await db
    .select()
    .from(linkScans)
    .where(and(ofThisStore, eq(linkScans.status, 'completed')))
    .orderBy(desc(linkScans.id))
    .limit(1);
  return { latest: toPublicScan(latest), lastCompleted: completed ? toPublicScan(completed) : null };
}

export async function getLinkScan(userId: number, scanId: number, storeId?: number) {
  return toPublicScan(await ownScan(userId, scanId, storeId));
}

/** SQL for "addresses whose answer is of this kind", for the list and the export. */
function viewCondition(view: LinkScanLinksQuery['view']): SQL | undefined {
  switch (view) {
    case 'broken': return eq(linkScanUrls.outcome, 'broken');
    case 'redirect': return eq(linkScanUrls.outcome, 'redirect');
    case 'unverified': return inArray(linkScanUrls.outcome, ['blocked', 'unverified', 'skipped']);
    case 'ok': return eq(linkScanUrls.outcome, 'ok');
    default: return isNotNull(linkScanUrls.outcome);
  }
}

/** Escapes LIKE's own wildcards, so a search for "100%" finds "100%" and not everything. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The scan's addresses with the answer asked for: dead ends first, those most pages link to first among them. */
export async function listLinkScanUrls(userId: number, scanId: number, query: LinkScanLinksQuery, storeId?: number) {
  const scan = await ownScan(userId, scanId, storeId);
  const conditions: SQL[] = [eq(linkScanUrls.scanId, scan.id), eq(linkScanUrls.state, 'done')];
  const view = viewCondition(query.view);
  if (view) conditions.push(view);
  if (query.scope !== 'all') conditions.push(eq(linkScanUrls.internal, query.scope === 'internal'));
  // A sitemap document is the scan's own working material, not a link of the store's.
  conditions.push(inArray(linkScanUrls.role, ['page', 'target']));
  if (query.q) conditions.push(sql`${linkScanUrls.url} LIKE ${likePattern(query.q)} ESCAPE '\\'`);
  const where = and(...conditions);

  const offset = (query.page - 1) * query.limit;
  const [items, [{ total }]] = await Promise.all([
    db.select().from(linkScanUrls).where(where).orderBy(desc(linkScanUrls.sourceCount), asc(linkScanUrls.id)).limit(query.limit).offset(offset),
    db.select({ total: count() }).from(linkScanUrls).where(where),
  ]) as [UrlRow[], [{ total: number }]];

  return {
    items: items.map(toPublicUrl),
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
  };
}

/** The text a page's `outlinks` JSON holds for one address: `["address",` starts that link's [address, anchor] pair, and nothing inside an anchor can spell it (a quote there is escaped). */
function outlinkNeedle(url: string): string {
  return `[${JSON.stringify(url)},`;
}

/** The pages that contain a link to one address, with the text of the link — what lets a merchant find it. */
export async function listLinkSources(userId: number, scanId: number, urlId: number, storeId?: number) {
  const scan = await ownScan(userId, scanId, storeId);
  const [target] = await db.select().from(linkScanUrls).where(and(eq(linkScanUrls.id, urlId), eq(linkScanUrls.scanId, scan.id))).limit(1);
  if (!target) throw new ApiError(404, 'Link not found', 'LINK_NOT_FOUND');

  const needle = outlinkNeedle(target.url);
  const pages = await db
    .select({ url: linkScanUrls.url, outlinks: linkScanUrls.outlinks })
    .from(linkScanUrls)
    .where(and(eq(linkScanUrls.scanId, scan.id), eq(linkScanUrls.role, 'page'), sql`instr(${linkScanUrls.outlinks}, ${needle}) > 0`))
    .orderBy(asc(linkScanUrls.id))
    .limit(50);

  const sources = pages.map((page) => {
    let anchor = '';
    try {
      const pairs = JSON.parse(page.outlinks ?? '[]') as Array<[string, string]>;
      anchor = pairs.find(([address]) => address === target.url)?.[1] ?? '';
    } catch {
      // A damaged row still names the page.
    }
    return { page: page.url, anchor };
  });
  return { url: target.url, inSitemap: target.inSitemap, total: target.sourceCount ?? sources.length, sources };
}

// ─── Stopping ────────────────────────────────────────────────────────

export async function cancelLinkScan(userId: number, scanId: number, storeId?: number) {
  const scan = await ownScan(userId, scanId, storeId);
  if (scan.status !== 'queued' && scan.status !== 'running') return toPublicScan(scan);
  const [updated] = await db
    .update(linkScans)
    .set({ status: 'cancelled', stage: 'Cancelled', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(linkScans.id, scan.id), inArray(linkScans.status, ['queued', 'running'])))
    .returning();
  return toPublicScan(updated ?? scan);
}

// ─── Export ──────────────────────────────────────────────────────────

const OUTCOME_WORDS: Record<string, string> = {
  broken: 'Broken',
  redirect: 'Redirects',
  blocked: 'Blocked — could not test',
  unverified: 'Could not verify',
  skipped: 'Not requested',
  ok: 'Works',
};

/**
 * Every address with a problem — broken, redirecting, blocked, unverified — as a spreadsheet: where it
 * points, what came back, how many pages link to it and the first few of them. Built by reading the pages
 * once, in order, and keeping the first three sources of each address; the scan's links are never loaded
 * all at once.
 */
export async function exportLinkScanCsv(userId: number, scanId: number, storeId?: number): Promise<{ csv: string; filename: string }> {
  const scan = await ownScan(userId, scanId, storeId);
  const problems = await db
    .select()
    .from(linkScanUrls)
    .where(and(
      eq(linkScanUrls.scanId, scan.id),
      eq(linkScanUrls.state, 'done'),
      inArray(linkScanUrls.role, ['page', 'target']),
      inArray(linkScanUrls.outcome, ['broken', 'redirect', 'blocked', 'unverified', 'skipped']),
    ))
    .orderBy(asc(linkScanUrls.id));

  const wanted = new Set(problems.map((row) => row.url));
  const sources = new Map<string, Array<{ page: string; anchor: string }>>();
  let cursor = 0;
  while (wanted.size > 0) {
    const pages = await db
      .select({ id: linkScanUrls.id, url: linkScanUrls.url, outlinks: linkScanUrls.outlinks })
      .from(linkScanUrls)
      .where(and(eq(linkScanUrls.scanId, scan.id), eq(linkScanUrls.role, 'page'), isNotNull(linkScanUrls.outlinks), gt(linkScanUrls.id, cursor)))
      .orderBy(asc(linkScanUrls.id))
      .limit(100);
    if (pages.length === 0) break;
    for (const page of pages) {
      cursor = page.id;
      let pairs: Array<[string, string]> = [];
      try {
        pairs = JSON.parse(page.outlinks ?? '[]') as Array<[string, string]>;
      } catch {
        continue;
      }
      for (const [address, anchor] of pairs) {
        if (!wanted.has(address)) continue;
        const list = sources.get(address) ?? [];
        if (list.length < 3) {
          list.push({ page: page.url, anchor });
          sources.set(address, list);
        }
      }
    }
  }

  const order = ['broken', 'redirect', 'blocked', 'unverified', 'skipped'];
  const sorted = [...problems].sort((a, b) => order.indexOf(a.outcome ?? '') - order.indexOf(b.outcome ?? '') || (b.sourceCount ?? 0) - (a.sourceCount ?? 0));
  const lines = [
    ['Result', 'Points to', 'Link', 'HTTP status', 'What happened', 'Ends at', 'Pages linking to it', 'Listed in sitemap', 'Found on (first three pages)'].map(escapeCsv).join(','),
    ...sorted.map((row) =>
      [
        OUTCOME_WORDS[row.outcome ?? ''] ?? row.outcome,
        row.internal ? 'Your store' : 'Another website',
        row.url,
        row.status,
        row.detail,
        row.finalUrl,
        row.sourceCount ?? 0,
        row.inSitemap ? 'Yes' : 'No',
        (sources.get(row.url) ?? []).map((source) => (source.anchor ? `${source.page} ("${source.anchor}")` : source.page)).join(' | '),
      ].map(escapeCsv).join(',')),
  ];
  const stamp = (scan.finishedAt ?? scan.createdAt).toISOString().slice(0, 10);
  return { csv: lines.join('\r\n'), filename: `rankvora-ai-link-scan-${stamp}.csv` };
}

// ─── Scans that can no longer be alive ───────────────────────────────

/**
 * Closes out scans whose heartbeat stopped — the Cloudflare counterpart of failInterruptedLinkScans().
 * Every batch writes `updated_at`, so a scan quiet for LINK_SCAN_STUCK_MS is not running any more: its
 * Workflow died without reaching the engine's own error handling. Left alone it would also block every
 * later scan for the store with 409. The results already read stay readable; nothing is lost but the rest of the run.
 */
export async function failStuckLinkScans(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.linkScanStuckMs);
  const stuck = await db
    .update(linkScans)
    .set({ status: 'failed', error: 'The link scan stopped before it finished and was closed out. Run it again.', stage: 'Stopped', finishedAt: now, updatedAt: now })
    .where(and(inArray(linkScans.status, ['queued', 'running']), lt(linkScans.updatedAt, cutoff)))
    .returning({ id: linkScans.id });
  return stuck.length;
}

/** Closes out every scan a previous Node process left running — its loop died with it. Called once at start-up. */
export async function failInterruptedLinkScans(): Promise<number> {
  const interrupted = await db
    .update(linkScans)
    .set({ status: 'failed', error: 'The link scan was interrupted because the Rankvora AI server restarted. Run it again.', stage: 'Stopped', finishedAt: new Date(), updatedAt: new Date() })
    .where(inArray(linkScans.status, ['queued', 'running']))
    .returning({ id: linkScans.id });
  return interrupted.length;
}
