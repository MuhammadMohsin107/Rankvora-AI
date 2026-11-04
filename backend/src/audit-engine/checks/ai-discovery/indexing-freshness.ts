import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { isAllowed, parseRobots } from '../../storefront/robots.js';
import { AI_CRAWLERS, VISIBILITY_CRAWLERS, crawlerByTypo, type AiCrawler } from '../../storefront/ai-crawlers.js';
import { formatCount } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, coveragePct, type RowStatus } from '../shared/status.js';
import { isLiveAt, isPublishedProduct } from '../shared/published.js';
import { notCheckedFinding } from './unreadable.js';

/**
 * ─── AI Discovery · Real-time indexing readiness ─────────────────────
 * Measures whether a change to this store can actually reach a search or AI engine promptly.
 *
 * WHY THIS IS NOT A "SUBMIT TO CHATGPT" BUTTON
 * No AI vendor accepts a push. OpenAI, Anthropic, Perplexity and Google all discover content by
 * crawling; there is no endpoint that takes a URL and indexes it, and any product that claims to
 * "feed ChatGPT in real time" is describing a crawl it does not control. What a store CAN control
 * is the two things that decide how fast a crawler notices a change, and both are measurable:
 *
 *   1. CRAWLER ACCESS — is the engine's own crawler allowed in at all? A perfect freshness signal
 *      is worth nothing to a crawler that robots.txt turns away, and this is where the silent
 *      failures live: `GPT-Bot` is not `GPTBot`, so a merchant who carefully wrote a rule for the
 *      wrong string has configured nothing and has no way to find out.
 *   2. CHANGE SIGNALS — does the sitemap publish `<lastmod>`, and does it agree with when the
 *      catalogue actually changed? `lastmod` is the only freshness claim a store makes. Absent, a
 *      crawler must re-fetch blindly on its own schedule. Wrong, and it learns to distrust the
 *      whole sitemap.
 *
 * TWO FACETS, ONE SCORE. Rows carry `facet` so the evidence table groups them, because a merchant
 * fixing a blocked crawler and a merchant fixing a stale sitemap are doing unrelated work.
 *
 * WHAT A LIVE BOT PROBE DOES AND DOES NOT PROVE is documented on the crawler's probeBot method and
 * repeated in the evidence: sending a crawler's User-Agent is not being that crawler, so a 200 is
 * not proof the real bot is served. A BLOCK, however, is real evidence of an edge rule — and that
 * rule is invisible to robots.txt parsing, because it operates above robots.txt.
 */

/** How stale a sitemap `lastmod` may be against the catalogue before it is misleading. */
const LASTMOD_TOLERANCE_HOURS = 48;

/** Products/pages compared against the sitemap. Enough to characterise the sitemap, bounded so a
 * large catalogue does not turn one check into a quadratic scan. */
const FRESHNESS_SAMPLE = 200;

interface Signal {
  id: string;
  facet: 'Crawler access' | 'Change signals';
  label: string;
  status: RowStatus;
  detail: string;
  recommendation: string;
  meta: string;
  /** Excluded from scoring — genuinely not measurable on this run. */
  unmeasurable: boolean;
  /**
   * A real ratio behind this signal, when it has one — lastmod coverage, lastmod agreement. Absent
   * for yes/no signals: a crawler is allowed or it is not, and 100/0 under a Coverage header was
   * that answer restated as a percentage nobody measured.
   */
  coverage?: number;
}

/**
 * A real product path to test robots.txt rules against, or null when the store has none published.
 *
 * It used to be `/products/example-handle` — a path that exists on no store. A rule is matched by
 * prefix, so the made-up handle gave the same answer as a real one in every ordinary case; but the
 * evidence then named a URL the merchant does not have, and a rule written against a specific
 * product would have been judged on a product that is not there.
 */
function sampleProductPath(snapshot: StoreSnapshot): string | null {
  const product = snapshot.products.find(isPublishedProduct);
  if (!product) return null;
  try {
    return new URL(product.url).pathname;
  } catch {
    return null;
  }
}

/** Normalises a URL for comparison against a sitemap entry: origin + path, no query, no trailing slash. */
function comparablePath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

/** Every `User-agent:` token declared in a robots.txt, in order, de-duplicated. */
function declaredAgents(robotsBody: string): string[] {
  const agents: string[] = [];
  for (const line of robotsBody.split(/\r?\n/)) {
    const match = /^\s*user-agent\s*:\s*(\S+)/i.exec(line.replace(/#.*$/, ''));
    if (match && !agents.includes(match[1])) agents.push(match[1]);
  }
  return agents;
}

export const indexingFreshnessCheck: AuditCheck = {
  id: 'ai-discovery.indexing-freshness',
  pillar: 'ai-discovery',
  subPillar: 'indexing-freshness',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const crawl = snapshot.crawl;
    if (!crawl) {
      return unavailableResult(
        'indexing-freshness',
        'Storefront crawling is switched off for this Rankvora AI instance, so crawler access and sitemap freshness could not be checked.',
      );
    }

    const origin = crawl.origin;
    const signals: Signal[] = [];
    const blockedCrawlers: AiCrawler[] = [];
    const typos: Array<{ written: string; meant: AiCrawler }> = [];

    // ── Facet 1 · Crawler access, from the real robots.txt ──
    const robotsBody = crawl.robots?.body ?? null;
    const robotsReadable = Boolean(robotsBody) && !crawl.robots?.passwordGated && crawl.robots?.status === 200;

    if (!robotsReadable) {
      // robots.txt comes from Shopify's CDN edge and reaches us even on a gated store, so failing
      // to read it is genuinely unusual — and is reported as unmeasured, not as "nothing blocked".
      signals.push({
        id: 'robots',
        facet: 'Crawler access',
        label: 'robots.txt',
        status: NEEDS_WORK,
        detail: crawl.robots ? `HTTP ${crawl.robots.status}` : 'Not fetched on this run',
        recommendation: 'Could not be checked — robots.txt was not readable, so no crawler rule could be evaluated.',
        meta: `${origin}/robots.txt`,
        unmeasurable: true,
      });
    } else {
      const body = robotsBody as string;
      const productPath = sampleProductPath(snapshot);

      for (const crawler of AI_CRAWLERS) {
        // Parsed per crawler, because robots.txt group selection is per user-agent: the rules that
        // apply to GPTBot may be a different group from the ones that apply to Googlebot.
        const rules = { ...parseRobots(body, crawler.name), fetched: true };
        const allowed = isAllowed(rules, '/');
        // With no published product there is no product URL to test, so only the root is judged.
        const productsAllowed = productPath === null ? allowed : isAllowed(rules, productPath);
        const fullyAllowed = allowed && productsAllowed;
        if (!fullyAllowed) blockedCrawlers.push(crawler);

        signals.push({
          id: `crawler:${crawler.name}`,
          facet: 'Crawler access',
          label: crawler.name,
          status: fullyAllowed ? HEALTHY : crawler.purpose === 'search' || crawler.purpose === 'user-action' ? CRITICAL : NEEDS_WORK,
          detail: fullyAllowed
            ? `Allowed (${crawler.vendor} · ${crawler.purpose.replace('-', ' ')})`
            : allowed
              ? `Homepage allowed, but product URLs are disallowed (${productPath})`
              : 'Disallowed site-wide',
          recommendation: fullyAllowed ? '' : crawler.effect,
          meta: `${origin}/robots.txt · ${crawler.vendor}`,
          unmeasurable: false,
        });
      }

      // ── Misspelled crawler tokens ──
      // The whole reason this check is worth running. A merchant who wrote `GPT-Bot` believes they
      // made a decision; robots.txt silently ignored it, and nothing else would ever tell them.
      for (const token of declaredAgents(body)) {
        const meant = crawlerByTypo(token);
        if (meant && !typos.some((entry) => entry.written.toLowerCase() === token.toLowerCase())) {
          typos.push({ written: token, meant });
        }
      }
      for (const typo of typos) {
        signals.push({
          id: `typo:${typo.written}`,
          facet: 'Crawler access',
          label: typo.written,
          status: NEEDS_WORK,
          detail: `Not a real crawler name — ${typo.meant.vendor}’s is "${typo.meant.name}"`,
          recommendation: `Rename this group to "${typo.meant.name}". As written it matches no crawler, so whatever you intended here is not in effect.`,
          meta: `${origin}/robots.txt`,
          unmeasurable: false,
        });
      }

      // ── Live edge behaviour, when probes ran ──
      for (const probe of crawl.botAccess) {
        if (probe.reason !== null) {
          signals.push({
            id: `probe:${probe.bot}`,
            facet: 'Crawler access',
            label: `${probe.bot} (live request)`,
            status: NEEDS_WORK,
            detail: `Request did not complete (${probe.reason})`,
            recommendation: 'Could not be checked — the live request for this crawler did not complete.',
            meta: probe.userAgent,
            unmeasurable: true,
          });
          continue;
        }
        if (probe.passwordGated) continue; // The gate, not an edge rule. Already reported elsewhere.

        const blocked = probe.status === 403 || probe.status === 401 || probe.status === 429 || probe.status >= 500;
        signals.push({
          id: `probe:${probe.bot}`,
          facet: 'Crawler access',
          label: `${probe.bot} (live request)`,
          status: blocked ? CRITICAL : HEALTHY,
          detail: blocked
            ? `Your server answered HTTP ${probe.status} to this crawler’s user-agent`
            : `HTTP ${probe.status}, ${formatCount(probe.bytes)} bytes returned`,
          recommendation: blocked
            ? 'Something above robots.txt — a WAF, CDN rule or bot manager — is refusing this crawler. robots.txt cannot fix it; the rule has to be changed where it lives.'
            : '',
          meta: `${probe.userAgent} · a user-agent header only, not a verified crawler identity`,
          unmeasurable: false,
        });
      }
    }

    // ── Facet 2 · Change signals ──
    const records = crawl.sitemapRecords;
    const sitemapReadable = crawl.sitemap?.status === 200 && !crawl.sitemap.passwordGated;

    if (!sitemapReadable) {
      signals.push({
        id: 'sitemap',
        facet: 'Change signals',
        label: 'sitemap.xml',
        status: NEEDS_WORK,
        detail: crawl.sitemap ? `HTTP ${crawl.sitemap.status}` : 'Not fetched on this run',
        recommendation: 'Could not be checked — the sitemap was not readable, so no freshness signal could be evaluated.',
        meta: `${origin}/sitemap.xml`,
        unmeasurable: true,
      });
    } else if (records.length === 0) {
      signals.push({
        id: 'sitemap',
        facet: 'Change signals',
        label: 'sitemap.xml',
        status: NEEDS_WORK,
        detail: 'Reachable, but no URL entries were parsed from it',
        recommendation: 'The sitemap returned 200 but listed no pages Rankvora AI could read. Check what it is actually serving.',
        meta: `${origin}/sitemap.xml`,
        unmeasurable: false,
      });
    } else {
      const withLastmod = records.filter((entry) => entry.lastmod !== null);
      const coverage = Math.round((withLastmod.length / records.length) * 100);

      signals.push({
        id: 'lastmod-coverage',
        facet: 'Change signals',
        label: '<lastmod> coverage',
        status: coverage >= 90 ? HEALTHY : coverage > 0 ? NEEDS_WORK : CRITICAL,
        detail: `${formatCount(withLastmod.length)} of ${formatCount(records.length)} sitemap entries publish a last-modified date (${coverage}%)`,
        recommendation: coverage >= 90
          ? ''
          : 'Without <lastmod>, a crawler has no way to tell a changed page from an unchanged one and must re-fetch on its own schedule.',
        meta: `${origin}/sitemap.xml`,
        unmeasurable: false,
        // A real ratio, and the one the row's own detail states. The table used to show 100 or 0
        // here, so an 85% sitemap read "(85%)" in Detail and 0 in Coverage on the same line.
        coverage,
      });

      // ── lastmod vs. what the catalogue actually says ──
      // The only comparison here that can catch a sitemap that LOOKS fresh and is not.
      const lastmodByPath = new Map<string, Date>();
      for (const entry of withLastmod) {
        const path = comparablePath(entry.loc);
        const parsed = new Date(entry.lastmod as string);
        if (path && !Number.isNaN(parsed.getTime())) lastmodByPath.set(path, parsed);
      }

      // Published resources only. A sitemap lists what is live, so comparing a draft against it
      // would report the draft as "missing from the sitemap" — correctly absent, wrongly flagged.
      const catalogue = [
        ...snapshot.products.filter(isPublishedProduct).map((product) => ({ url: product.url, title: product.title, updatedAt: product.updatedAt, kind: 'product' })),
        ...snapshot.pages.filter((page) => isLiveAt(page.publishedAt, snapshot.capturedAt)).map((page) => ({ url: page.url, title: page.title, updatedAt: page.updatedAt, kind: 'page' })),
        ...snapshot.articles.filter((article) => isLiveAt(article.publishedAt, snapshot.capturedAt)).map((article) => ({ url: article.url, title: article.title, updatedAt: article.updatedAt, kind: 'article' })),
      ]
        .filter((item) => item.updatedAt !== null)
        .slice(0, FRESHNESS_SAMPLE);

      const stale: Array<{ title: string; url: string; sitemapDate: Date; realDate: Date }> = [];
      const absent: Array<{ title: string; url: string }> = [];
      let compared = 0;

      for (const item of catalogue) {
        const path = comparablePath(item.url);
        if (!path) continue;
        const declared = lastmodByPath.get(path);
        const real = new Date(item.updatedAt as string);
        if (Number.isNaN(real.getTime())) continue;

        if (!declared) {
          // Only meaningful when the sitemap is a complete list. A truncated sitemap index (we
          // follow three children) would otherwise report every unvisited child's pages as absent.
          if (crawl.sitemapUrls.length === 0) absent.push({ title: item.title, url: item.url });
          continue;
        }
        compared += 1;
        if (declared < real && hoursBetween(declared, real) > LASTMOD_TOLERANCE_HOURS) {
          stale.push({ title: item.title, url: item.url, sitemapDate: declared, realDate: real });
        }
      }

      if (compared > 0) {
        signals.push({
          id: 'lastmod-accuracy',
          facet: 'Change signals',
          label: '<lastmod> accuracy',
          status: stale.length === 0 ? HEALTHY : NEEDS_WORK,
          detail: stale.length === 0
            ? `${formatCount(compared)} pages compared against Shopify’s own updated-at — all agree`
            : `${formatCount(stale.length)} of ${formatCount(compared)} compared pages publish a last-modified date older than their real last edit`,
          recommendation: stale.length === 0
            ? ''
            : 'A sitemap that under-reports its own freshness teaches crawlers to skip it. Investigate what generates these dates.',
          meta: `${origin}/sitemap.xml vs. Shopify updatedAt`,
          unmeasurable: false,
          // A real ratio: compared pages whose sitemap date agrees with Shopify's.
          coverage: coveragePct(compared - stale.length, compared),
        });
      }

      if (absent.length > 0) {
        signals.push({
          id: 'sitemap-absent',
          facet: 'Change signals',
          label: 'Sitemap completeness',
          status: NEEDS_WORK,
          detail: `${formatCount(absent.length)} published resources were not found in the sitemap`,
          recommendation: 'A page absent from the sitemap is discovered only by link-following, which is slower and less reliable.',
          meta: `${origin}/sitemap.xml`,
          unmeasurable: false,
        });
      }
    }

    const measurable = signals.filter((signal) => !signal.unmeasurable);
    if (measurable.length === 0) {
      return unavailableResult(
        'indexing-freshness',
        crawl.passwordGated
          ? 'Your storefront is password protected, so Rankvora AI could not evaluate crawler access or sitemap freshness. Remove the password under Online Store → Preferences, then run the audit again.'
          : 'Rankvora AI could not read robots.txt or your sitemap, so real-time indexing readiness could not be checked.',
      );
    }

    const rows: SubPillarEvidenceRow[] = signals.map((signal) => ({
      id: signal.id,
      status: signal.status,
      facet: signal.facet,
      cells: {
        signal: signal.label,
        detail: signal.detail,
        ...(signal.coverage !== undefined ? { coverage: signal.coverage } : {}),
        status: signal.status,
        recommendation: signal.recommendation,
      },
      current: { label: 'Measured', value: signal.detail, meta: signal.meta },
      ...(signal.recommendation ? { suggested: { label: 'Recommendation', value: signal.recommendation } } : {}),
    }));

    const healthy = measurable.filter((signal) => signal.status === HEALTHY).length;
    const findings: SubPillarFindingResult[] = [];

    // ── Findings ──
    const blockedVisibility = blockedCrawlers.filter((crawler) =>
      VISIBILITY_CRAWLERS.some((visible) => visible.name === crawler.name),
    );
    if (blockedVisibility.length > 0) {
      findings.push({
        title: 'Search and AI crawlers are disallowed in robots.txt',
        severity: 'critical',
        affectedCount: blockedVisibility.length,
        affectedLabel: blockedVisibility.length === 1 ? 'crawler' : 'crawlers',
        scoreLift: Math.round((blockedVisibility.length / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `robots.txt disallows ${blockedVisibility.map((crawler) => crawler.name).join(', ')}.`,
        why: 'These are the crawlers that put a store in front of people — Google Search, Bing, ChatGPT search results, Perplexity citations. A disallowed crawler does not rank the store lower; it never fetches the page at all, so the store cannot appear in that surface under any query.',
        recommendation: `Allow each of these in robots.txt. ${blockedVisibility.map((crawler) => `${crawler.name}: ${crawler.effect}`).join(' ')}`,
        evidence: blockedVisibility.map((crawler) => `${crawler.name} (${crawler.vendor}): disallowed by ${origin}/robots.txt.`),
        evidenceRows: rows.filter((row) => blockedVisibility.some((crawler) => row.id === `crawler:${crawler.name}`)),
        details: { issueType: CRITICAL },
      });
    }

    const blockedTraining = blockedCrawlers.filter((crawler) =>
      !VISIBILITY_CRAWLERS.some((visible) => visible.name === crawler.name),
    );
    if (blockedTraining.length > 0) {
      findings.push({
        title: 'Training crawlers are disallowed',
        // Low on purpose. Opting out of model training is a legitimate business decision, and a
        // check that scored it as a defect would mark a merchant down for a choice they made.
        severity: 'low',
        affectedCount: blockedTraining.length,
        affectedLabel: 'crawlers',
        scoreLift: Math.round((blockedTraining.length / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `robots.txt disallows ${blockedTraining.map((crawler) => crawler.name).join(', ')}.`,
        why: 'These crawlers collect content for model training rather than for search results. Blocking them is a deliberate and reasonable choice; it is listed here so the decision is visible and intentional, not so it is corrected.',
        recommendation: 'No action needed if this was deliberate. If it was not, allow these crawlers — being present in training data is how a brand becomes something an assistant knows about unprompted.',
        evidence: blockedTraining.map((crawler) => `${crawler.name} (${crawler.vendor}): disallowed. ${crawler.effect}`),
        evidenceRows: rows.filter((row) => blockedTraining.some((crawler) => row.id === `crawler:${crawler.name}`)),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (typos.length > 0) {
      findings.push({
        title: 'robots.txt names crawlers that do not exist',
        severity: 'high',
        affectedCount: typos.length,
        affectedLabel: typos.length === 1 ? 'rule' : 'rules',
        scoreLift: Math.round((typos.length / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `robots.txt declares ${typos.map((typo) => `"${typo.written}"`).join(', ')}, which ${typos.length === 1 ? 'matches no crawler' : 'match no crawler'}.`,
        why: 'robots.txt matching is literal. A group naming a string no crawler sends is inert — the crawler it was written for never sees it and falls back to the wildcard group instead. The merchant believes they configured something; nothing anywhere reports that they did not.',
        recommendation: typos.map((typo) => `Rename "${typo.written}" to "${typo.meant.name}" (${typo.meant.vendor}).`).join(' '),
        evidence: typos.map((typo) => `"${typo.written}" in ${origin}/robots.txt — ${typo.meant.vendor}’s crawler is named "${typo.meant.name}".`),
        evidenceRows: rows.filter((row) => row.id.startsWith('typo:')),
        details: { issueType: NEEDS_WORK },
      });
    }

    const edgeBlocked = crawl.botAccess.filter(
      (probe) => probe.reason === null && !probe.passwordGated && (probe.status === 403 || probe.status === 401 || probe.status === 429 || probe.status >= 500),
    );
    if (edgeBlocked.length > 0) {
      findings.push({
        title: 'Your server refuses crawler user-agents',
        severity: 'critical',
        affectedCount: edgeBlocked.length,
        affectedLabel: 'crawlers',
        scoreLift: Math.round((edgeBlocked.length / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `${edgeBlocked.map((probe) => `${probe.bot} received HTTP ${probe.status}`).join('; ')}.`,
        why: 'This happens above robots.txt, so a perfectly written Allow rule cannot fix it and no robots.txt checker will ever report it. Something in the request path — a WAF, a CDN rule, a bot manager — is turning these user-agents away before the storefront is reached.',
        recommendation: 'Find the rule refusing these user-agents in your CDN, WAF or bot-management settings and allow them. Note that Rankvora AI sent the crawler’s user-agent only; a block here is real, but a pass does not prove the verified crawler is served.',
        evidence: edgeBlocked.map((probe) => `GET ${origin}/ as ${probe.bot}: HTTP ${probe.status}.`),
        evidenceRows: rows.filter((row) => edgeBlocked.some((probe) => row.id === `probe:${probe.bot}`)),
        details: { issueType: CRITICAL },
      });
    }

    const lastmodSignal = signals.find((signal) => signal.id === 'lastmod-coverage');
    if (lastmodSignal && !lastmodSignal.unmeasurable && lastmodSignal.status !== HEALTHY) {
      findings.push({
        title: 'Sitemap does not publish reliable last-modified dates',
        severity: lastmodSignal.status === CRITICAL ? 'high' : 'medium',
        affectedCount: 1,
        affectedLabel: 'sitemap',
        scoreLift: Math.round((1 / measurable.length) * 100),
        resolutionType: 'settings',
        problem: lastmodSignal.detail,
        why: '<lastmod> is the only freshness claim a store publishes. Without it a crawler cannot distinguish a page you edited an hour ago from one untouched for two years, so it re-fetches on its own schedule — which for a deep product page can be weeks after the change.',
        recommendation: 'Serve a <lastmod> for every sitemap entry, set from the resource’s real last edit. Shopify does this automatically on its generated sitemap; a custom or app-generated sitemap may not.',
        evidence: [`${origin}/sitemap.xml: ${lastmodSignal.detail}.`],
        evidenceRows: rows.filter((row) => row.id === 'lastmod-coverage'),
        // Taken from the row rather than fixed, because the row is CRITICAL when no entry carries
        // a lastmod at all and NEEDS_WORK when only some do. A hardcoded issueType would not match
        // its own evidence row in the first case, and the UI filters evidence BY issueType — so
        // "Review evidence" would filter this finding's table down to nothing.
        details: { issueType: lastmodSignal.status },
      });
    }

    const accuracySignal = signals.find((signal) => signal.id === 'lastmod-accuracy');
    if (accuracySignal && !accuracySignal.unmeasurable && accuracySignal.status !== HEALTHY) {
      findings.push({
        title: 'Sitemap last-modified dates disagree with the catalogue',
        severity: 'medium',
        affectedCount: 1,
        affectedLabel: 'sitemap',
        scoreLift: Math.round((1 / measurable.length) * 100),
        resolutionType: 'settings',
        problem: accuracySignal.detail,
        why: 'Shopify records when each resource was really last edited. Where the sitemap claims an older date than that, it is under-reporting its own freshness — and a crawler that fetches a page and finds it newer than advertised learns to trust the whole sitemap less.',
        recommendation: 'Check whatever generates your sitemap. A cached or app-generated sitemap that is not regenerated on edit is the usual cause.',
        evidence: [accuracySignal.detail],
        evidenceRows: rows.filter((row) => row.id === 'lastmod-accuracy'),
        details: { issueType: NEEDS_WORK },
      });
    }

    const absentSignal = signals.find((signal) => signal.id === 'sitemap-absent');
    if (absentSignal) {
      findings.push({
        title: 'Published pages are missing from the sitemap',
        severity: 'medium',
        affectedCount: 1,
        affectedLabel: 'sitemap',
        scoreLift: Math.round((1 / measurable.length) * 100),
        resolutionType: 'settings',
        problem: absentSignal.detail,
        why: 'A page listed nowhere has to be found by following a link to it. That is slower, depends on the page being linked at all, and gives the crawler no freshness signal when it changes.',
        recommendation: 'Confirm these resources are published and that nothing is excluding them from the sitemap.',
        evidence: [absentSignal.detail],
        evidenceRows: rows.filter((row) => row.id === 'sitemap-absent'),
        details: { issueType: NEEDS_WORK },
      });
    }

    const skipped = signals.filter((signal) => signal.unmeasurable);
    if (skipped.length > 0) {
      findings.push(notCheckedFinding({
        title: skipped.length === 1 ? 'One indexing signal could not be checked' : 'Some indexing signals could not be checked',
        rows: rows.filter((row) => skipped.some((signal) => signal.id === row.id)),
        affectedLabel: skipped.length === 1 ? 'signal' : 'signals',
        problem: skipped.map((signal) => `${signal.label}: ${signal.detail}.`).join(' '),
        why: 'Rankvora AI reports only what a request actually returned. These requests returned nothing it could read, so they are left out of the score — neither passed nor failed.',
        recommendation: [...new Set(skipped.map((signal) => signal.recommendation))].join(' '),
        evidence: skipped.map((signal) => `${signal.label}: ${signal.detail}.`),
      }));
    }
    const probeNote = crawl.botAccess.length > 0
      ? ` ${formatCount(crawl.botAccess.length)} crawlers were also sent a real request; a user-agent header is not a verified crawler identity, so a refusal is evidence and a pass is not proof.`
      : '';

    return {
      subPillar: 'indexing-freshness',
      status: 'ok',
      score: scoreSubPillar(measurable.length, healthy, findings),
      analyzedCount: measurable.length,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${healthy} of ${formatCount(measurable.length)} indexing signals pass — which named crawlers robots.txt actually admits, and whether your sitemap publishes freshness dates that match your catalogue.${probeNote}${skipped.length > 0 ? ` ${skipped.length} signal(s) could not be checked on this run.` : ''}`,
        // Whole percent: a decimal place implies a precision these counts do not carry.
        healthChip: `${coveragePct(healthy, measurable.length)}% healthy`,
        contextLabel: 'Crawlers allowed',
        contextValue: robotsReadable ? `${AI_CRAWLERS.length - blockedCrawlers.length} of ${AI_CRAWLERS.length}` : 'Not measured',
        evidenceRows: rows,
      },
      findings,
    };
  },
};
