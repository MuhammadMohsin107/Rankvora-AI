import { MAX_HTML_BYTES } from '../audit-engine/storefront/html-parser.js';
import { mayRequest } from './network-guard.js';
import {
  classifyFailure,
  classifyNetworkError,
  classifyResponse,
  NOT_REQUESTED,
  PASSWORD_PROTECTED,
  type Classified,
  type Reason,
} from './outcome.js';

/**
 * ─── Asking one address whether it answers ───────────────────────────
 *
 * The only code in the link scan that makes a request. Two things it is asked to do:
 *
 *   probe(url)      "does this address work?" — for a link target. HEAD first (no body to download), then GET
 *                   when HEAD is refused or says it failed, because many sites answer HEAD badly (403, 404
 *                   or 405) and a link must never be called broken on a HEAD that a browser would never send.
 *   load(url, kind) "give me this document" — a page to read the links of, or a sitemap to read the
 *                   addresses of. GET, with the body, bounded in size.
 *
 * Every request:
 *   · is checked against the network guard first, and so is every redirect it is sent on to;
 *   · follows redirects itself, one hop at a time, so the chain can be counted and a loop recognised;
 *   · has a time limit and is retried once when the failure looks temporary (a timeout, a dropped
 *     connection, a 5xx, a 429 — waiting out a Retry-After of up to five seconds);
 *   · reads its answer through outcome.ts, so what a status MEANS is decided in one place.
 *
 * It never throws: every failure is an answer.
 */

export interface RequestOptions {
  userAgent: string;
  timeoutMs: number;
  /** True for an address on the store itself — it changes what a 4xx means (outcome.ts). */
  internal: boolean;
  /** Test seam: allow addresses on a private network. Production never sets it. */
  allowPrivateNetwork?: boolean;
  /** The storefront-password cookie, sent only to `cookieHosts`. */
  cookie?: string | null;
  cookieHosts?: readonly string[];
  maxHops?: number;
  /** Extra attempts after a temporary failure. Default 1. */
  retries?: number;
}

export interface CheckResult extends Classified {
  /** The HTTP status after redirects, or null when no response arrived. */
  status: number | null;
  /** Where the address ended up, when that is not the address itself. */
  finalUrl: string | null;
  hops: number;
}

export interface LoadedDocument extends CheckResult {
  /** The document, only for a 2xx answer of the kind asked for. */
  body: string | null;
}

type Raw =
  | { kind: 'response'; status: number; finalUrl: string; hops: number; contentType: string | null; challenged: boolean; retryAfterMs: number | null; body: string | null }
  | { kind: 'failure'; reason: Reason; retry: boolean; finalUrl: string; hops: number }
  | { kind: 'skipped'; why: string; finalUrl: string; hops: number };

const DEFAULT_MAX_HOPS = 5;
const RETRY_PAUSE_MS = 400;
const MAX_RETRY_AFTER_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

type BodyKind = 'html' | 'xml' | false;

function wantsBody(kind: BodyKind, contentType: string | null): boolean {
  if (!kind) return false;
  const type = (contentType ?? '').toLowerCase();
  // A missing content-type is read as the kind that was asked for: a sitemap served without one is still a sitemap.
  if (!type) return true;
  return kind === 'html' ? /text\/html|application\/xhtml/.test(type) : /xml|text\/plain/.test(type);
}

/** One request, following redirects by hand. */
async function requestOnce(method: 'GET' | 'HEAD', start: string, options: RequestOptions, bodyKind: BodyKind): Promise<Raw> {
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const seen = new Set<string>([start]);
  let current = start;
  let hops = 0;

  for (;;) {
    const verdict = await mayRequest(current, { allowPrivateNetwork: options.allowPrivateNetwork });
    if (!verdict.ok) return { kind: 'skipped', why: verdict.why, finalUrl: current, hops };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'User-Agent': options.userAgent,
        Accept: bodyKind === 'xml' ? 'application/xml,text/xml;q=0.9,*/*;q=0.8' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      };
      if (options.cookie && options.cookieHosts?.includes(new URL(current).host.toLowerCase())) headers.Cookie = options.cookie;

      const response = await fetch(current, { method, redirect: 'manual', signal: controller.signal, headers });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) return { kind: 'response', status: response.status, finalUrl: current, hops, contentType: null, challenged: false, retryAfterMs: null, body: null };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { kind: 'failure', reason: 'bad_redirect', retry: false, finalUrl: current, hops };
        }
        if (seen.has(next)) return { kind: 'failure', reason: 'redirect_loop', retry: false, finalUrl: next, hops: hops + 1 };
        if (hops >= maxHops) return { kind: 'failure', reason: 'too_many_redirects', retry: false, finalUrl: next, hops: hops + 1 };
        seen.add(next);
        current = next;
        hops += 1;
        continue;
      }

      const contentType = response.headers.get('content-type');
      const facts = {
        kind: 'response' as const,
        status: response.status,
        finalUrl: current,
        hops,
        contentType,
        challenged: (response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge',
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      };

      if (method === 'GET' && bodyKind && response.status >= 200 && response.status < 300 && wantsBody(bodyKind, contentType)) {
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_HTML_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          return { ...facts, body: null };
        }
        const text = await response.text();
        return { ...facts, body: text.length > MAX_HTML_BYTES ? null : text };
      }

      // The body is never wanted here: closing it frees the connection without downloading a video.
      await response.body?.cancel().catch(() => undefined);
      return { ...facts, body: null };
    } catch (error) {
      const { reason, retry } = classifyNetworkError(error);
      return { kind: 'failure', reason, retry, finalUrl: current, hops };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A request, tried again once when the failure looks temporary. */
async function attempt(method: 'GET' | 'HEAD', url: string, options: RequestOptions, bodyKind: BodyKind): Promise<Raw> {
  const retries = options.retries ?? 1;
  let result = await requestOnce(method, url, options, bodyKind);
  for (let tried = 0; tried < retries; tried += 1) {
    const temporary =
      (result.kind === 'failure' && result.retry)
      || (result.kind === 'response' && (result.status >= 500 || result.status === 429));
    if (!temporary) break;
    await sleep(result.kind === 'response' && result.retryAfterMs !== null ? Math.min(result.retryAfterMs, MAX_RETRY_AFTER_MS) : RETRY_PAUSE_MS);
    result = await requestOnce(method, url, options, bodyKind);
  }
  return result;
}

/** What a raw answer means for the address that was asked about. */
function judge(raw: Raw, url: string, options: RequestOptions): CheckResult {
  const finalUrl = (address: string) => (address !== url ? address : null);
  if (raw.kind === 'skipped') {
    return { ...NOT_REQUESTED(raw.why), status: null, finalUrl: finalUrl(raw.finalUrl), hops: raw.hops };
  }
  if (raw.kind === 'failure') {
    return { ...classifyFailure(raw.reason), status: null, finalUrl: finalUrl(raw.finalUrl), hops: raw.hops };
  }
  // A store behind its password answers EVERY address with 200 and the password page: that says nothing
  // about the address, so it is never read as "works".
  if (options.internal && raw.status < 400) {
    try {
      if (new URL(raw.finalUrl).pathname === '/password') {
        return { ...PASSWORD_PROTECTED, status: raw.status, finalUrl: finalUrl(raw.finalUrl), hops: raw.hops };
      }
    } catch {
      // An unparseable final address cannot be the password page.
    }
  }
  return {
    ...classifyResponse({ status: raw.status, hops: raw.hops, internal: options.internal, challenged: raw.challenged }),
    status: raw.status,
    finalUrl: finalUrl(raw.finalUrl),
    hops: raw.hops,
  };
}

/**
 * Does this address work? HEAD, then GET when HEAD is refused or fails — and only a GET's answer
 * can call a link broken, because a server that mishandles HEAD is common and a browser never sends one.
 */
export async function probe(url: string, options: RequestOptions): Promise<CheckResult> {
  const head = await attempt('HEAD', url, options, false);
  const headWorked = head.kind === 'response' && head.status < 400;
  if (headWorked || head.kind === 'skipped') return judge(head, url, options);
  const get = await attempt('GET', url, options, false);
  return judge(get, url, options);
}

/** Loads a document — a page (`html`) or a sitemap (`xml`) — and returns it with what the request meant. */
export async function load(url: string, kind: 'html' | 'xml', options: RequestOptions): Promise<LoadedDocument> {
  const raw = await attempt('GET', url, options, kind);
  const result = judge(raw, url, options);
  return { ...result, body: raw.kind === 'response' && result.outcome !== 'unverified' ? raw.body : null };
}
