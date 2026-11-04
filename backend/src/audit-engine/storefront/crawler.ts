import { env } from '../../config/env.js';
import {
  MAX_HTML_BYTES,
  extractCanonicals,
  extractHeadings,
  extractImages,
  extractJsonLd,
  extractLinks,
  extractMetaByName,
  extractRobotsSitemaps,
  extractScripts,
  extractSitemapEntries,
  extractSitemapLocations,
  extractTitle,
  isSitemapIndex,
  visibleText,
} from './html-parser.js';
import { comparableFromString, comparableUrl, resolveCanonical } from './canonical-url.js';
import { PROBEABLE_CRAWLERS } from './ai-crawlers.js';
import type {
  BotAccessProbe,
  CanonicalTargetStatus,
  CrawlFailure,
  CrawlFailureReason,
  CrawledPage,
  FetchedResource,
  SitemapEntry,
  StorefrontCrawl,
} from './types.js';

/**
 * ─── Storefront crawler ──────────────────────────────────────────────
 * Fetches a bounded set of REAL pages from the merchant's own storefront and turns them into
 * structured evidence for the crawl-based checks.
 *
 * SAFETY, BECAUSE THIS IS THE ONLY PART OF RANKVORA AI THAT TOUCHES A LIVE SHOP
 *   · Same-origin only. Targets are built from the merchant's own Admin resources, and any URL
 *     off that origin is refused before a request is made — an audit can never be turned into a
 *     crawler pointed at a third party.
 *   · Bounded by pages, concurrency and a per-request timeout, all configurable, all defaulted to
 *     values that are polite to a shop serving real customers.
 *   · Every failure is recorded and the crawl continues. One 404 must not cost an audit.
 *   · No credentials. The storefront is public; no Shopify token is ever sent here, so a crawl
 *     log can never leak one.
 *
 * THE PASSWORD GATE IS THE SUBTLE ONE
 * A store with "Restrict access" enabled answers EVERY url with HTTP 200 and the password page.
 * Status codes therefore prove nothing on a gated store: `/agents.md` returns 200 and 11KB of
 * real HTML that is not agents.md. Detecting the gate is what stops the whole crawl from
 * producing confident fabrications, so it is checked on every response and, when found,
 * collapses the crawl to `unavailable` rather than yielding pages.
 */

/** Redirect hops tolerated before a chain is treated as a loop. */
const MAX_REDIRECTS = 5;

/** Internal link targets verified per crawl. Status-checking every link on every page would
 * multiply request volume by an order of magnitude for a check that only needs a sample. */
const MAX_LINK_CHECKS = 25;

/** Shopify serves its access gate at this path. */
const PASSWORD_PATH = '/password';

export interface CrawlTarget {
  url: string;
  pageType: CrawledPage['pageType'];
  resourceId: string | null;
}

/**
 * Per-store inputs the crawl cannot discover for itself.
 *
 * `indexNowKey` is the clearest example of why this exists: the IndexNow spec puts the key file at
 * `/<key>.txt`, and there is no way to enumerate a site root. Without being told the key, a
 * verifier has nothing to request — so a crawl given no key reports "not configured" rather than
 * guessing a filename and reporting its 404 as a missing file.
 */
export interface CrawlOptions {
  /** The IndexNow key this store publishes, when the merchant has set one up. */
  indexNowKey?: string | null;
  /** Ask the storefront root for a response as each named AI/search crawler. Off by default. */
  probeBots?: boolean;
}

function classifyError(error: unknown): { reason: CrawlFailureReason; detail: string } {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { reason: 'timeout', detail: `timed out after ${env.crawlTimeoutMs}ms` };
    const cause = (error as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { reason: 'dns', detail: 'host could not be resolved' };
    if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'EPROTO') return { reason: 'ssl', detail: 'TLS handshake failed' };
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return { reason: 'connection', detail: 'connection failed' };
    return { reason: 'connection', detail: 'request failed' };
  }
  return { reason: 'connection', detail: 'request failed' };
}

/** True when a response is Shopify's access gate rather than the resource that was asked for. */
function isPasswordGate(finalUrl: string, status: number): boolean {
  try {
    return new URL(finalUrl).pathname === PASSWORD_PATH && status < 400;
  } catch {
    return false;
  }
}

/** Runs tasks with a fixed number in flight. Keeps request pressure on one shop predictable. */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export class StorefrontCrawler {
  private readonly origin: string;
  private readonly options: CrawlOptions;
  /** Cookie jar for the storefront password, when one is configured. Public-page cookies only —
   * no Shopify Admin credential ever enters this class. */
  private cookie: string | null = null;

  constructor(origin: string, options: CrawlOptions = {}) {
    const url = new URL(origin);
    this.origin = url.origin;
    this.options = options;
  }

  /**
   * The IndexNow key file path, or null when this store has no key on file.
   *
   * The key is validated here rather than trusted: it becomes a URL path, so anything that is not
   * the spec's hexadecimal string is refused outright instead of being interpolated into a
   * request. A malformed key is a configuration error to report, never a path to fetch.
   */
  private indexNowKeyPath(): string | null {
    const key = this.options.indexNowKey?.trim();
    if (!key) return null;
    return /^[a-f0-9]{8,128}$/i.test(key) ? `/${key}.txt` : null;
  }

  /** Refuses anything off the merchant's own storefront before a request is made. */
  private sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': env.crawlUserAgent, Accept: accept };
    if (this.cookie) headers.Cookie = this.cookie;
    return headers;
  }

  /**
   * One request, following redirects manually so the chain can be recorded and a loop detected.
   * Manual following is also what lets the password gate be seen as a redirect TARGET rather than
   * discovered only by inspecting the final body.
   */
  private async request(url: string, accept: string): Promise<
    | { ok: true; status: number; finalUrl: string; chain: string[]; body: string; contentType: string | null; ms: number }
    | { ok: false; reason: CrawlFailureReason; status: number; detail: string; finalUrl: string }
  > {
    const chain: string[] = [];
    let current = url;
    const started = Date.now();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!this.sameOrigin(current)) {
        return { ok: false, reason: 'blocked', status: 0, detail: 'redirected off the storefront origin', finalUrl: current };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.crawlTimeoutMs);
      try {
        const response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: this.headers(accept),
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return { ok: false, reason: 'http_error', status: response.status, detail: `redirect with no location`, finalUrl: current };
          }
          const next = new URL(location, current).toString();
          if (chain.includes(next)) {
            return { ok: false, reason: 'redirect_loop', status: response.status, detail: 'redirect loop', finalUrl: next };
          }
          chain.push(next);
          current = next;
          continue;
        }

        const contentType = response.headers.get('content-type');
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_HTML_BYTES) {
          return { ok: false, reason: 'too_large', status: response.status, detail: `${declared} bytes exceeds the parse ceiling`, finalUrl: current };
        }

        const body = await response.text();
        if (body.length > MAX_HTML_BYTES) {
          return { ok: false, reason: 'too_large', status: response.status, detail: `${body.length} bytes exceeds the parse ceiling`, finalUrl: current };
        }

        return { ok: true, status: response.status, finalUrl: current, chain, body, contentType, ms: Date.now() - started };
      } catch (error) {
        const { reason, detail } = classifyError(error);
        return { ok: false, reason, status: 0, detail, finalUrl: current };
      } finally {
        clearTimeout(timer);
      }
    }

    return { ok: false, reason: 'redirect_loop', status: 0, detail: `more than ${MAX_REDIRECTS} redirects`, finalUrl: current };
  }

  /**
   * Attempts to unlock a password-protected storefront, when a password is configured.
   *
   * Shopify's gate accepts a form POST and answers with a `storefront_digest` cookie. This is the
   * documented way a merchant lets a tool see their pre-launch store; it is only ever attempted
   * with a password the operator supplied for their own shop. Returns true when the gate opened.
   */
  private async unlock(): Promise<boolean> {
    const password = env.crawlStorefrontPassword;
    if (!password) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.crawlTimeoutMs);
    try {
      const response = await fetch(`${this.origin}${PASSWORD_PATH}`, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': env.crawlUserAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
      });

      // Cookies are captured, never logged — the digest is as good as the password.
      const setCookie = response.headers.getSetCookie?.() ?? [];
      const digest = setCookie.map((entry) => entry.split(';')[0]).filter((entry) => entry.startsWith('storefront_digest='));
      if (digest.length === 0) return false;
      this.cookie = digest.join('; ');
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchResource(path: string, accept: string): Promise<FetchedResource> {
    const url = `${this.origin}${path}`;
    const response = await this.request(url, accept);
    if (!response.ok) {
      return { url, finalUrl: response.finalUrl, status: response.status, body: null, contentType: null, passwordGated: false, reason: response.reason };
    }
    const passwordGated = isPasswordGate(response.finalUrl, response.status);
    return {
      url,
      finalUrl: response.finalUrl,
      status: response.status,
      // A gated response body is Shopify's password page. Returning it as the resource's content
      // is exactly the fabrication this flag exists to prevent, so it is withheld.
      body: passwordGated ? null : response.body,
      contentType: response.contentType,
      passwordGated,
      reason: passwordGated ? 'password_gated' : null,
    };
  }

  private async fetchPage(target: CrawlTarget): Promise<{ page: CrawledPage } | { failure: CrawlFailure }> {
    const response = await this.request(target.url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');

    if (!response.ok) {
      return { failure: { url: target.url, pageType: target.pageType, resourceId: target.resourceId, reason: response.reason, status: response.status, detail: response.detail } };
    }
    if (isPasswordGate(response.finalUrl, response.status)) {
      return { failure: { url: target.url, pageType: target.pageType, resourceId: target.resourceId, reason: 'password_gated', status: response.status, detail: 'storefront is password protected' } };
    }
    if (response.status >= 400) {
      return { failure: { url: target.url, pageType: target.pageType, resourceId: target.resourceId, reason: 'http_error', status: response.status, detail: `HTTP ${response.status}` } };
    }
    if (response.contentType && !/text\/html|application\/xhtml/i.test(response.contentType)) {
      return { failure: { url: target.url, pageType: target.pageType, resourceId: target.resourceId, reason: 'not_html', status: response.status, detail: `content-type ${response.contentType}` } };
    }

    const html = response.body;
    const canonicals = extractCanonicals(html);
    const robots = extractMetaByName(html, 'robots');
    const text = visibleText(html);

    return {
      page: {
        url: target.url,
        finalUrl: response.finalUrl,
        pageType: target.pageType,
        resourceId: target.resourceId,
        status: response.status,
        redirectChain: response.chain,
        responseTimeMs: response.ms,
        bytes: Buffer.byteLength(html, 'utf8'),
        title: extractTitle(html),
        metaDescription: extractMetaByName(html, 'description'),
        // Every canonical is kept: more than one is a defect the canonicals check reports from
        // the page's own markup, and one outside <head> is ignored by search engines.
        canonical: canonicals.head[0] ?? null,
        canonicals: canonicals.head,
        canonicalsOutsideHead: canonicals.outsideHead,
        robots: robots ? robots.toLowerCase() : null,
        noindex: /noindex/i.test(robots ?? ''),
        headings: extractHeadings(html),
        links: extractLinks(html, response.finalUrl, this.origin),
        images: extractImages(html, response.finalUrl),
        scripts: extractScripts(html, response.finalUrl, this.origin),
        jsonLd: extractJsonLd(html),
        textLength: text.length,
        text: text.slice(0, 20_000).toLowerCase(),
      },
    };
  }

  /** HEAD-first status check for internal link targets, falling back to GET when HEAD is refused
   * (Shopify answers 405 on some routes, which is not evidence of a broken link). */
  private async checkLink(url: string): Promise<number> {
    if (!this.sameOrigin(url)) return 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.crawlTimeoutMs);
    try {
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: this.headers('*/*') });
      if (head.status !== 405 && head.status !== 501) return head.status;
      const get = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: this.headers('text/html') });
      return get.status;
    } catch {
      // 0 means "not verified" — never reported as a broken link.
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What one canonical target answers, redirects NOT followed — a canonical that points at a
   * redirect is itself the finding, so following it would hide the very thing being measured.
   * HEAD first, GET when HEAD is refused, and the body is never read.
   */
  private async probeCanonical(url: string): Promise<CanonicalTargetStatus> {
    if (!this.sameOrigin(url)) return { status: 0, location: null, reason: 'blocked' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.crawlTimeoutMs);
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal, headers: this.headers('text/html') });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: this.headers('text/html') });
        await response.body?.cancel();
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      return { status: response.status, location: location ? new URL(location, url).toString() : null, reason: null };
    } catch (error) {
      return { status: 0, location: null, reason: classifyError(error).reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Asks the storefront root for a page as one named crawler, and records what came back.
   *
   * WHAT THIS CAN AND CANNOT SHOW, STATED PLAINLY
   * Sending a crawler's User-Agent is not impersonating it — the real crawlers are also identified
   * by IP and reverse DNS, which Rankvora AI neither has nor forges. So a 200 here does NOT prove the
   * real GPTBot is served; a bot manager doing reverse-DNS verification would reject this request
   * exactly as it rejects any other unverified client.
   *
   * What it DOES show, and what nothing else in Rankvora AI can: a WAF, CDN rule or bot-manager that
   * answers a crawler user-agent with a block page or a challenge. That happens above robots.txt
   * and is completely invisible to parsing robots.txt — a store can have a perfect Allow rule and
   * still serve GPTBot a 403. Only a real request finds that.
   *
   * Redirects are followed, because a redirect to the real page is not a block.
   */
  private async probeBot(bot: string, userAgent: string): Promise<BotAccessProbe> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.crawlTimeoutMs);
    try {
      const response = await fetch(`${this.origin}/`, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        // Deliberately NOT this.headers(): the storefront-password cookie must not be sent here.
        // A gated store should answer a bot exactly as it answers the public, and borrowing our
        // unlocked session would report an open door that no crawler can actually walk through.
        headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      });
      const body = await response.text();
      return {
        bot,
        userAgent,
        status: response.status,
        bytes: Buffer.byteLength(body, 'utf8'),
        passwordGated: isPasswordGate(response.url || `${this.origin}/`, response.status),
        reason: null,
      };
    } catch (error) {
      // Status 0 with a reason is "not measured". A timeout is not evidence of a block.
      return { bot, userAgent, status: 0, bytes: 0, passwordGated: false, reason: classifyError(error).reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One probe per crawler that publishes a real User-Agent, pooled like every other request. */
  private async probeBots(): Promise<BotAccessProbe[]> {
    if (!this.options.probeBots) return [];
    return pooled(PROBEABLE_CRAWLERS, env.crawlConcurrency, (crawler) =>
      this.probeBot(crawler.name, crawler.userAgent as string),
    );
  }

  /**
   * Requests every canonical target that is NOT the page declaring it, once each.
   *
   * A self-referencing canonical needs no request: the page it names is the one just loaded. Nor
   * does a target another crawled page already answered. Off-origin targets are never requested —
   * the crawler only ever talks to the merchant's own storefront — and the check reports those
   * from the URL alone. Bounded by the page budget, since each page contributes at most one.
   */
  private async verifyCanonicalTargets(pages: CrawledPage[]): Promise<Record<string, CanonicalTargetStatus>> {
    const loaded = new Set(pages.map((page) => comparableFromString(page.finalUrl)).filter(Boolean));
    const targets: string[] = [];
    for (const page of pages) {
      const target = resolveCanonical(page.canonical ?? '', page.finalUrl);
      if (!target || !this.sameOrigin(target.toString())) continue;
      if (loaded.has(comparableUrl(target)) || targets.includes(target.toString())) continue;
      targets.push(target.toString());
    }
    const statuses = await pooled(targets, env.crawlConcurrency, (url) => this.probeCanonical(url));
    return Object.fromEntries(targets.map((url, index) => [url, statuses[index]]));
  }

  /**
   * Fetches the resources Shopify serves whether or not the storefront is gated.
   *
   * robots.txt comes from the CDN edge and is readable on a password-protected store; the others
   * are attempted too and self-report gating, so a gated store still yields whatever real
   * evidence exists rather than none at all. Each resource carries its own `passwordGated` flag,
   * which is what stops the gate's HTML being mistaken for the file's contents.
   */
  private async fetchGateIndependentResources(): Promise<Pick<StorefrontCrawl, 'robots' | 'sitemap' | 'agentsMd' | 'llmsTxt' | 'sitemapUrls' | 'sitemapEntries' | 'sitemapRecords' | 'indexNowKeyFile'>> {
    const keyPath = this.indexNowKeyPath();
    const [robots, sitemap, agentsMd, llmsTxt, indexNowKeyFile] = await Promise.all([
      this.fetchResource('/robots.txt', 'text/plain,*/*;q=0.8'),
      this.fetchResource('/sitemap.xml', 'application/xml,text/xml;q=0.9,*/*;q=0.8'),
      this.fetchResource('/agents.md', 'text/markdown,text/plain;q=0.9,*/*;q=0.8'),
      this.fetchResource('/llms.txt', 'text/plain,*/*;q=0.8'),
      keyPath ? this.fetchResource(keyPath, 'text/plain,*/*;q=0.8') : Promise.resolve(null),
    ]);

    const sitemapUrls: string[] = [];
    const sitemapRecords: SitemapEntry[] = [];
    if (robots.body) sitemapUrls.push(...extractRobotsSitemaps(robots.body));
    if (sitemap.body) {
      if (isSitemapIndex(sitemap.body)) sitemapUrls.push(...extractSitemapLocations(sitemap.body));
      else sitemapRecords.push(...extractSitemapEntries(sitemap.body));
    }

    return {
      robots,
      sitemap,
      agentsMd,
      llmsTxt,
      indexNowKeyFile,
      sitemapUrls: [...new Set(sitemapUrls)],
      sitemapEntries: sitemapRecords.map((entry) => entry.loc),
      sitemapRecords,
    };
  }

  /**
   * `onPage` is called as each page request settles (loaded or failed), with how many of the
   * chosen pages have been attempted — for progress reporting only.
   */
  async crawl(targets: CrawlTarget[], onPage?: (attempted: number, total: number) => Promise<void> | void): Promise<StorefrontCrawl> {
    const startedAt = new Date();
    const warnings: string[] = [];
    const budget = {
      maxPages: env.crawlMaxPages,
      concurrency: env.crawlConcurrency,
      timeoutMs: env.crawlTimeoutMs,
      pagesFetched: 0,
      truncated: false,
    };

    const base: StorefrontCrawl = {
      origin: this.origin,
      startedAt,
      available: false,
      unavailableReason: null,
      passwordGated: false,
      pages: [],
      failures: [],
      robots: null,
      sitemap: null,
      sitemapUrls: [],
      sitemapEntries: [],
      sitemapRecords: [],
      agentsMd: null,
      llmsTxt: null,
      indexNowKeyFile: null,
      botAccess: [],
      linkStatuses: {},
      canonicalTargets: {},
      budget,
      warnings,
    };

    const allowed = targets.filter((target) => this.sameOrigin(target.url));
    if (allowed.length !== targets.length) {
      warnings.push(`${targets.length - allowed.length} crawl target(s) were refused for being off-origin.`);
    }
    if (allowed.length === 0) {
      return { ...base, unavailableReason: 'no_targets' };
    }

    // ── Reachability first ──
    // One request decides whether the rest of the crawl is worth making. A gated store is asked
    // once to open, and only if the operator supplied that store's own password.
    const homeProbe = await this.request(`${this.origin}/`, 'text/html');
    if (homeProbe.ok && isPasswordGate(homeProbe.finalUrl, homeProbe.status)) {
      const opened = await this.unlock();
      if (!opened) {
        // No rendered page can be read — but robots.txt is served from the CDN edge and reaches
        // us regardless of the gate, so it is still fetched. Skipping it would report a store's
        // robots.txt as unmeasurable when it is sitting right there, readable.
        const gatedResources = await this.fetchGateIndependentResources();
        return {
          ...base,
          passwordGated: true,
          unavailableReason: 'password_gated',
          ...gatedResources,
          warnings: [...warnings, 'The storefront is password protected, so no rendered page could be read. Remove the password under Online Store → Preferences, or set CRAWL_STOREFRONT_PASSWORD.'],
        };
      }
      warnings.push('The storefront is password protected; Rankvora AI authenticated with the configured storefront password.');
    } else if (!homeProbe.ok) {
      return {
        ...base,
        unavailableReason: 'unreachable',
        failures: [{ url: `${this.origin}/`, pageType: 'home', resourceId: null, reason: homeProbe.reason, status: homeProbe.status, detail: homeProbe.detail }],
        warnings: [...warnings, `The storefront could not be reached (${homeProbe.detail}).`],
      };
    }

    // ── Pages ──
    const capped = allowed.slice(0, env.crawlMaxPages);
    budget.truncated = allowed.length > capped.length;

    let attempted = 0;
    const outcomes = await pooled(capped, env.crawlConcurrency, async (target) => {
      const outcome = await this.fetchPage(target);
      attempted += 1;
      await onPage?.(attempted, capped.length);
      return outcome;
    });
    const pages: CrawledPage[] = [];
    const failures: CrawlFailure[] = [];
    for (const outcome of outcomes) {
      if ('page' in outcome) pages.push(outcome.page);
      else failures.push(outcome.failure);
    }
    budget.pagesFetched = pages.length;

    // Every page gated means the unlock did not really work — report it as gated rather than as
    // a store with no pages, which would read as a different (and wrong) problem.
    if (pages.length === 0 && failures.every((failure) => failure.reason === 'password_gated') && failures.length > 0) {
      return { ...base, passwordGated: true, unavailableReason: 'password_gated', failures, warnings };
    }

    // ── Non-HTML resources, in parallel with each other ──
    const keyPath = this.indexNowKeyPath();
    const [robots, sitemap, agentsMd, llmsTxt, indexNowKeyFile] = await Promise.all([
      this.fetchResource('/robots.txt', 'text/plain,*/*;q=0.8'),
      this.fetchResource('/sitemap.xml', 'application/xml,text/xml;q=0.9,*/*;q=0.8'),
      this.fetchResource('/agents.md', 'text/markdown,text/plain;q=0.9,*/*;q=0.8'),
      this.fetchResource('/llms.txt', 'text/plain,*/*;q=0.8'),
      keyPath ? this.fetchResource(keyPath, 'text/plain,*/*;q=0.8') : Promise.resolve(null),
    ]);

    const sitemapUrls: string[] = [];
    const sitemapRecords: SitemapEntry[] = [];
    if (robots.body) sitemapUrls.push(...extractRobotsSitemaps(robots.body));
    if (sitemap.body) {
      if (isSitemapIndex(sitemap.body)) {
        const locations = extractSitemapLocations(sitemap.body);
        sitemapUrls.push(...locations);
        // One level of the index is followed so "the sitemap lists URLs" can be answered from
        // real content rather than inferred from the index alone.
        const children = locations.filter((url) => this.sameOrigin(url)).slice(0, 3);
        const fetched = await pooled(children, env.crawlConcurrency, async (url) => {
          const response = await this.request(url, 'application/xml,text/xml');
          return response.ok && !isPasswordGate(response.finalUrl, response.status) ? response.body : null;
        });
        for (const body of fetched) if (body) sitemapRecords.push(...extractSitemapEntries(body));
      } else {
        sitemapRecords.push(...extractSitemapEntries(sitemap.body));
      }
    }

    // ── Crawler access probes ──
    // Last, and only when asked for: these are extra requests to a live shop, so they are opt-in
    // rather than something every audit pays for.
    const botAccess = await this.probeBots();

    // ── Internal link verification ──
    // A sample, taken across pages so one link-heavy page cannot consume the whole budget.
    const linkStatuses: Record<string, number> = {};
    const crawledUrls = new Set(pages.map((page) => page.finalUrl));
    const candidates: string[] = [];
    for (const page of pages) {
      for (const link of page.links) {
        if (!link.internal || crawledUrls.has(link.url) || candidates.includes(link.url)) continue;
        candidates.push(link.url);
        if (candidates.length >= MAX_LINK_CHECKS) break;
      }
      if (candidates.length >= MAX_LINK_CHECKS) break;
    }
    const statuses = await pooled(candidates, env.crawlConcurrency, (url) => this.checkLink(url));
    candidates.forEach((url, index) => { linkStatuses[url] = statuses[index]; });
    // Pages already fetched are known-good targets; including them means a link to a crawled page
    // is never reported as unverified.
    for (const page of pages) linkStatuses[page.finalUrl] = page.status;

    // ── Canonical targets ──
    const canonicalTargets = await this.verifyCanonicalTargets(pages);

    return {
      origin: this.origin,
      startedAt,
      available: pages.length > 0,
      unavailableReason: pages.length > 0 ? null : 'unreachable',
      passwordGated: false,
      pages,
      failures,
      robots,
      sitemap,
      sitemapUrls: [...new Set(sitemapUrls)],
      sitemapEntries: sitemapRecords.map((entry) => entry.loc),
      sitemapRecords,
      agentsMd,
      llmsTxt,
      indexNowKeyFile,
      botAccess,
      linkStatuses,
      canonicalTargets,
      budget,
      warnings,
    };
  }
}
