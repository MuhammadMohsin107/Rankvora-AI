import {
  AI_CRAWLERS,
  PROBEABLE_CRAWLERS,
  crawlerByName,
  type AiCrawler,
} from '../audit-engine/storefront/ai-crawlers.js';
import { EMPTY_ROBOTS, isAllowed, parseRobots } from '../audit-engine/storefront/robots.js';
import { extractTitle, visibleText } from '../audit-engine/storefront/html-parser.js';
import { ApiError } from '../middleware/error.js';

/**
 * ─── Test as a bot · what a named crawler really receives ────────────
 *
 * The audit already probes crawler access on a schedule. This is the same measurement made ON
 * DEMAND, for one crawler and one path the merchant chose, because the two answer different
 * questions. The audit answers "is my store open to AI crawlers" once a run; this answers "I just
 * changed robots.txt — did it work?" in the five seconds a merchant is willing to wait before
 * assuming it did.
 *
 * ─── Two independent facts, never collapsed ──────────────────────────
 *   1. What robots.txt SAYS. A rules question, computed from the live file.
 *   2. What the server DOES. An HTTP question, answered by really requesting the URL with the
 *      crawler's own User-Agent.
 *
 * They disagree more often than merchants expect — a CDN or bot-protection rule can serve a
 * challenge page to a crawler robots.txt admits, and a store can be perfectly crawlable while
 * robots.txt forbids it. Reporting one as the other would hide exactly the case worth finding.
 *
 * ─── A crawler with no published User-Agent is never faked ───────────
 * `Google-Extended` and `anthropic-ai` are robots.txt tokens with no header of their own. They can
 * be evaluated against the rules but CANNOT be probed, and this service refuses to probe them
 * rather than sending an invented string and presenting the result as that crawler's experience.
 * The refusal names the reason — see PROBEABLE_CRAWLERS in ai-crawlers.ts.
 */

const TIMEOUT_MS = 20_000;

/** Enough to judge what a crawler can read without buffering an unbounded body. */
const MAX_BODY_BYTES = 512 * 1024;

/** How much of the extracted text is returned for the merchant to eyeball. */
const PREVIEW_CHARS = 1_200;

export interface BotTestResult {
  bot: {
    name: string;
    vendor: string;
    purpose: AiCrawler['purpose'];
    effect: string;
    /** The exact header sent. Returned so the merchant can reproduce the request themselves. */
    userAgent: string;
  };
  url: string;
  /** ── Fact 1: what robots.txt says ── */
  robots: {
    /** False when robots.txt could not be fetched at all — then `allowed` is the spec default. */
    fetched: boolean;
    allowed: boolean;
    /** Whether a group naming this crawler exactly exists, as opposed to falling through to `*`. */
    hasSpecificGroup: boolean;
    crawlDelaySeconds: number | null;
  };
  /** ── Fact 2: what the server actually did ── */
  response: {
    status: number | null;
    contentType: string | null;
    bytes: number;
    /** Set when the request never completed — DNS, TLS, timeout, connection refused. */
    error: string | null;
    /** True when the response was the Shopify storefront password page rather than the content. */
    passwordGated: boolean;
  };
  /** ── What the crawler could actually read ── */
  content: {
    title: string | null;
    /** Visible text, truncated. This is the substance an assistant would have to work from. */
    textPreview: string | null;
    /** Characters of visible text in the whole response, before truncation. */
    textLength: number;
  };
  /** Plain-language verdict combining both facts. Never a score. */
  summary: string;
  checkedAt: string;
}

/** Every crawler the merchant may choose, and whether a live probe is possible for it. */
export function listTestableBots(): Array<{
  name: string;
  vendor: string;
  purpose: AiCrawler['purpose'];
  effect: string;
  probeable: boolean;
}> {
  return AI_CRAWLERS.map((crawler) => ({
    name: crawler.name,
    vendor: crawler.vendor,
    purpose: crawler.purpose,
    effect: crawler.effect,
    probeable: crawler.userAgent !== null,
  }));
}

/** Reads robots.txt once, as the named crawler. Never throws — an unreachable file is a real state. */
async function readRobots(origin: string, userAgentToken: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/robots.txt', origin).toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Scorelo/1.0 (+https://scorelo.app/bot)' },
      redirect: 'follow',
    });
    if (!response.ok) return { ...EMPTY_ROBOTS, text: '' };
    const text = await response.text();
    return { ...parseRobots(text, userAgentToken), fetched: true, text };
  } catch {
    return { ...EMPTY_ROBOTS, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether robots.txt contains a group naming this crawler exactly.
 *
 * Distinct from `allowed`, and the distinction is what the merchant acts on: a crawler that is
 * allowed only because it fell through to `*` is one `Disallow` away from being blocked by a rule
 * aimed at somebody else.
 */
function hasSpecificGroup(robotsText: string, name: string): boolean {
  const lower = name.toLowerCase();
  return robotsText
    .split(/\r?\n/)
    .some((line) => {
      const cleaned = line.replace(/#.*$/, '').trim().toLowerCase();
      return cleaned.startsWith('user-agent:') && cleaned.slice('user-agent:'.length).trim() === lower;
    });
}

/** Shopify's storefront password page answers every URL with 200 — detected, never counted as content. */
function looksPasswordGated(url: string, finalUrl: string, html: string): boolean {
  if (/\/password\b/.test(new URL(finalUrl, url).pathname)) return true;
  return /name=["']password["']/i.test(html) && /storefront|enter\s+using\s+password/i.test(html);
}

/**
 * Really requests one URL as one named crawler, and reports both what robots.txt said and what
 * came back.
 *
 * `path` is resolved against the store's own origin, so this can never be pointed at a third-party
 * host — the merchant tests their own store, not an arbitrary target.
 */
export async function runBotTest(origin: string, botName: string, path: string): Promise<BotTestResult> {
  const crawler = crawlerByName(botName);
  if (!crawler) {
    throw new ApiError(
      400,
      `“${botName}” is not a crawler Rankvora AI knows. Choose one of the ${AI_CRAWLERS.length} listed.`,
      'BOT_UNKNOWN',
    );
  }

  if (!crawler.userAgent) {
    throw new ApiError(
      422,
      `${crawler.name} publishes no User-Agent of its own — it is a robots.txt token only, so there is no request to make as it. Rankvora AI will not invent a header and present the result as ${crawler.name}’s. ${PROBEABLE_CRAWLERS.length} of the ${AI_CRAWLERS.length} crawlers can be probed live.`,
      'BOT_NOT_PROBEABLE',
    );
  }

  // Resolved against the store's origin: a caller-supplied absolute URL cannot redirect this probe
  // at somebody else's server.
  let target: URL;
  try {
    target = new URL(path || '/', origin);
    const base = new URL(origin);
    if (target.origin !== base.origin) target = new URL(path.replace(/^https?:\/\/[^/]+/i, '') || '/', origin);
  } catch {
    throw new ApiError(400, 'That path could not be resolved against your storefront.', 'BOT_PATH_INVALID');
  }

  const robots = await readRobots(origin, crawler.name);
  const allowed = isAllowed({ ...robots, fetched: robots.fetched }, target.pathname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let status: number | null = null;
  let contentType: string | null = null;
  let bytes = 0;
  let error: string | null = null;
  let html = '';
  let finalUrl = target.toString();

  try {
    const response = await fetch(target.toString(), {
      signal: controller.signal,
      // The crawler's own published string, verbatim. This is the whole point of the probe.
      headers: { 'User-Agent': crawler.userAgent, Accept: 'text/html,application/xhtml+xml,*/*' },
      redirect: 'follow',
    });
    status = response.status;
    contentType = response.headers.get('content-type');
    finalUrl = response.url || finalUrl;

    const body = await response.text();
    bytes = Buffer.byteLength(body);
    html = body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body;
  } catch (caught) {
    error =
      caught instanceof Error && caught.name === 'AbortError'
        ? `No response within ${TIMEOUT_MS / 1000} seconds.`
        : 'The request did not complete — DNS, TLS or the connection failed.';
  } finally {
    clearTimeout(timer);
  }

  const passwordGated = html.length > 0 && looksPasswordGated(target.toString(), finalUrl, html);
  const isHtml = /text\/html/i.test(contentType ?? '');
  const text = html && isHtml ? visibleText(html) : '';

  return {
    bot: {
      name: crawler.name,
      vendor: crawler.vendor,
      purpose: crawler.purpose,
      effect: crawler.effect,
      userAgent: crawler.userAgent,
    },
    url: target.toString(),
    robots: {
      fetched: robots.fetched,
      allowed,
      hasSpecificGroup: hasSpecificGroup(robots.text, crawler.name),
      crawlDelaySeconds: robots.crawlDelaySeconds,
    },
    response: { status, contentType, bytes, error, passwordGated },
    content: {
      title: html && isHtml ? extractTitle(html) : null,
      textPreview: text ? text.slice(0, PREVIEW_CHARS) : null,
      textLength: text.length,
    },
    summary: buildSummary({ crawler, allowed, robotsFetched: robots.fetched, status, error, passwordGated, textLength: text.length }),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The sentence the merchant reads first.
 *
 * Ordered by what actually blocks them: a failed request tells you nothing about robots.txt, a
 * password gate makes every other signal meaningless, and a robots.txt block matters even when the
 * server happily serves the page — because a compliant crawler will never ask.
 */
function buildSummary(input: {
  crawler: AiCrawler;
  allowed: boolean;
  robotsFetched: boolean;
  status: number | null;
  error: string | null;
  passwordGated: boolean;
  textLength: number;
}): string {
  const { crawler, allowed, robotsFetched, status, error, passwordGated, textLength } = input;

  if (error) return `The request as ${crawler.name} did not complete, so what this crawler receives could not be measured. ${error}`;
  if (passwordGated) {
    return `Your storefront is password protected: ${crawler.name} received the password page, not your content. Nothing can read this store until the password is removed under Online Store → Preferences.`;
  }
  if (!allowed) {
    return `robots.txt disallows ${crawler.name} for this path. The server answered HTTP ${status}, but a compliant crawler never sends the request — so in practice ${crawler.name} sees nothing here. ${crawler.effect}`;
  }
  if (status === null || status >= 400) {
    return `robots.txt admits ${crawler.name}, but the server answered HTTP ${status ?? '—'} — so there is nothing for it to read at this URL.`;
  }
  if (status >= 300) {
    return `robots.txt admits ${crawler.name}, and the server redirected the request (HTTP ${status}). Check that the destination is the page you expect.`;
  }
  if (textLength === 0) {
    return `robots.txt admits ${crawler.name} and the server returned HTTP ${status}, but no readable text was found in the response. An assistant fetching this URL would have nothing to quote.`;
  }
  const robotsNote = robotsFetched ? '' : ' (robots.txt could not be fetched, so the spec default — allow — was applied.)';
  return `${crawler.name} can read this page: robots.txt admits it, the server returned HTTP ${status}, and ${textLength.toLocaleString()} characters of readable text came back.${robotsNote}`;
}
