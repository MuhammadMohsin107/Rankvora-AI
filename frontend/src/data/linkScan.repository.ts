import { api } from '../lib/api';

/**
 * The complete link scan, as the API reports it (backend/src/services/link-scan.service.ts).
 *
 * Everything here is what a scan really found: the totals come from the scan's own counts and every row is
 * an address that was really requested. Nothing is estimated, sampled or filled in.
 */

export type LinkScanStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** How each address answered: works, works after a redirect, dead end, refused a robot, could not tell, not requested. */
export type LinkOutcome = 'ok' | 'redirect' | 'broken' | 'blocked' | 'unverified' | 'skipped';

export interface LinkTally {
  ok: number;
  redirect: number;
  broken: number;
  blocked: number;
  unverified: number;
  skipped: number;
}

export interface LinkScanSummary {
  pagesCrawled: number;
  pagesPending: number;
  urlsFound: number;
  urlsChecked: number;
  linksFound: number;
  sitemapsRead: number;
  internal: LinkTally;
  external: LinkTally;
}

export interface LinkScan {
  id: number;
  status: LinkScanStatus;
  trigger: 'manual' | 'audit' | 'schedule';
  phase: 'discovering' | 'crawling' | 'checking' | 'finishing';
  origin: string | null;
  /** 0-100, the scan's own progress. */
  progress: number;
  /** What it is doing, with the real counts so far. */
  stage: string | null;
  /** Set when a safety ceiling stopped the scan covering everything. */
  limitReached: 'urls' | null;
  summary: LinkScanSummary | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface LatestLinkScan {
  /** The newest scan in any state, or null when the store has never been scanned. */
  latest: LinkScan | null;
  /** The newest scan that finished — what to keep showing while a new one runs. */
  lastCompleted: LinkScan | null;
}

export interface LinkRow {
  id: number;
  url: string;
  internal: boolean;
  role: 'page' | 'target';
  inSitemap: boolean;
  outcome: LinkOutcome | null;
  status: number | null;
  finalUrl: string | null;
  hops: number;
  reason: string | null;
  /** One sentence saying what happened, written for the merchant. */
  detail: string | null;
  /** How many pages link to it. */
  sourceCount: number | null;
  checkedAt: string | null;
}

export type LinkView = 'broken' | 'redirect' | 'unverified' | 'ok' | 'all';
export type LinkScope = 'all' | 'internal' | 'external';

export interface LinkRowsQuery {
  view: LinkView;
  scope: LinkScope;
  q: string;
  page: number;
  limit: number;
}

export interface LinkRows {
  items: LinkRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface LinkSources {
  url: string;
  inSitemap: boolean;
  total: number;
  sources: Array<{ page: string; anchor: string }>;
}

export const isActive = (scan: LinkScan | null): boolean => scan?.status === 'queued' || scan?.status === 'running';

export function fetchLatestLinkScan(): Promise<LatestLinkScan> {
  return api.get<LatestLinkScan>('/link-scans/latest');
}

export function startLinkScan(): Promise<LinkScan> {
  return api.post<LinkScan>('/link-scans');
}

export function cancelLinkScan(id: number): Promise<LinkScan> {
  return api.post<LinkScan>(`/link-scans/${id}/cancel`);
}

export function fetchLinkRows(id: number, query: LinkRowsQuery): Promise<LinkRows> {
  const params = new URLSearchParams({ view: query.view, scope: query.scope, page: String(query.page), limit: String(query.limit) });
  if (query.q.trim()) params.set('q', query.q.trim());
  return api.get<LinkRows>(`/link-scans/${id}/links?${params}`);
}

export function fetchLinkSources(id: number, urlId: number): Promise<LinkSources> {
  return api.get<LinkSources>(`/link-scans/${id}/links/${urlId}/sources`);
}

/** Downloads the spreadsheet the SERVER builds: every address with a problem, and the pages that contain it. */
export async function downloadLinkScanCsv(id: number): Promise<string> {
  const { blob, filename } = await api.download(`/link-scans/${id}/export`, 'rankvora-ai-link-scan.csv');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: Safari cancels an in-flight download if the URL is released in the click's own task.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
