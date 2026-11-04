import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, type RowStatus } from '../shared/status.js';
import { notCheckedFinding, redirectsOffHost, unreadableReason } from './unreadable.js';

/**
 * ─── AI Discovery · IndexNow readiness ───────────────────────────────
 * Measures whether this store could actually submit a URL through IndexNow — the free protocol
 * that pings Bing, Yandex, Naver, Seznam and Yep in one call.
 *
 * WHY THIS IS A READINESS CHECK AND NOT A SUBMITTER
 * IndexNow authenticates a submission by asking the submitter to prove it controls the site: you
 * host a file at `https://yourdomain/<key>.txt` whose entire body is the key, and every submission
 * names that key. An engine that cannot fetch and match that file rejects the submission. So the
 * question that decides whether IndexNow can work at all is "is the key file really there, really
 * reachable, and does it really contain the key" — and that is a measurement, answerable by one
 * HTTP request, which is what this performs.
 *
 * THERE IS NO WAY TO DISCOVER THE KEY. The spec puts it at a path named after itself, and a site
 * root cannot be enumerated. So a store that has told Rankvora AI no key is reported as NOT CONFIGURED
 * — never as "the file is missing", which is a claim about a file Rankvora AI never requested.
 *
 * THE SHOPIFY CONSTRAINT IS REAL AND IS STATED, NOT HIDDEN
 * A stock Shopify storefront cannot serve an arbitrary file at its root. The usual workaround is a
 * file under Content → Files plus a URL redirect from the root path to it on Shopify's CDN. The
 * IndexNow spec puts the key file on the site's own host and says nothing about redirects, so
 * whether an engine accepts that is not something this check can know — and it says so rather than
 * calling it either a pass or a failure. An app proxy is NOT an answer: Shopify serves proxies only
 * under /apps/ (and similar prefixes), and a key file there authorises only URLs under that folder,
 * never /products/. What always works is the file served from the merchant's own domain, e.g. by an
 * edge worker in front of it.
 */

/** Set by the crawler from the same pattern the settings service validates against. */
const KEY_PATTERN = /^[a-f0-9]{8,128}$/i;

/** What to do about a key file that redirects to another host — the one honest answer is a test. */
const REDIRECT_ADVICE =
  'IndexNow’s rules place the key file on your own domain and do not say whether a redirect is followed, so Rankvora AI cannot tell whether this works. Submit one of your URLs at api.indexnow.org with this key: HTTP 200 or 202 means the key was accepted, 403 means it was not.';

interface Signal {
  id: string;
  label: string;
  status: RowStatus;
  detail: string;
  recommendation: string;
  /** Excluded from scoring — Rankvora AI could not interpret the response at all. */
  unmeasurable: boolean;
}

export const indexNowCheck: AuditCheck = {
  id: 'ai-discovery.indexnow',
  pillar: 'ai-discovery',
  subPillar: 'indexnow',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const settings = snapshot.aiDiscovery;
    if (!settings) {
      return unavailableResult(
        'indexnow',
        'Rankvora AI could not read this store’s AI Discovery settings, so IndexNow readiness could not be checked.',
      );
    }

    const crawl = snapshot.crawl;
    const key = settings.indexNowKey;
    const origin = crawl?.origin ?? snapshot.shop.primaryUrl;

    // ── No key on file ──
    // NOT MEASURED, not failing. The key is a secret the merchant publishes and then tells Rankvora AI;
    // no amount of reading the store reveals it (see the header above). With none on file there is
    // no path to request, so Rankvora AI knows nothing about the store's IndexNow set-up — another app
    // may well be submitting for it. This used to be scored 0 with a medium "IndexNow is not set
    // up" finding, which lowered AI Discovery and the overall score on the strength of a row in
    // Rankvora AI's own settings table. DATA-SOURCES.md has always said the opposite: "A store that has
    // supplied neither is reported as not configured, never as failing."
    if (!key) {
      return unavailableResult(
        'indexnow',
        'IndexNow is not configured in Rankvora AI for this store, so its readiness has not been measured. Add your IndexNow key in Settings → AI Discovery and the next audit checks that the key file is published and matching.',
      );
    }

    // A key that cannot form a legal path was never requested — say that rather than report a 404.
    if (!KEY_PATTERN.test(key)) {
      return unavailableResult(
        'indexnow',
        'The IndexNow key saved for this store is not valid hexadecimal, so Rankvora AI did not request a key file. Replace it in Settings → AI Discovery.',
      );
    }

    const file = crawl?.indexNowKeyFile ?? null;
    const keyUrl = file?.url ?? `${origin}/${key}.txt`;
    const signals: Signal[] = [];

    // ── 1. The key file itself ──
    if (!crawl) {
      signals.push({
        id: 'file',
        label: `/${key}.txt`,
        status: NEEDS_WORK,
        detail: 'Storefront crawling is switched off, so the key file was not requested',
        recommendation: 'Could not be checked — storefront crawling is disabled for this Rankvora AI instance.',
        unmeasurable: true,
      });
    } else if (crawl.passwordGated || file?.passwordGated) {
      // The gate answers every URL with 200 and the password page. Reading that as the key file
      // would report a verified key on a store that publishes none.
      signals.push({
        id: 'file',
        label: `/${key}.txt`,
        status: NEEDS_WORK,
        detail: 'The storefront password page was returned instead of the key file',
        recommendation: 'Could not be checked while the storefront is password protected.',
        unmeasurable: true,
      });
    } else if (!file || unreadableReason(file) !== null) {
      // No HTTP answer to reason from — including a redirect to another host, which the crawler
      // does not follow. That used to fall through to the status branches and read "HTTP 0".
      signals.push({
        id: 'file',
        label: `/${key}.txt`,
        status: NEEDS_WORK,
        detail: unreadableReason(file) ?? 'Not requested on this run',
        recommendation: redirectsOffHost(file)
          ? REDIRECT_ADVICE
          : 'Could not be checked — the request for the key file did not complete. Run the audit again.',
        unmeasurable: true,
      });
    } else if (file.status === 404 || file.status === 410) {
      signals.push({
        id: 'file',
        label: `/${key}.txt`,
        status: CRITICAL,
        detail: `HTTP ${file.status} — the key file is not published`,
        recommendation: 'Publish the key file at your storefront root. Without it every IndexNow submission is rejected.',
        unmeasurable: false,
      });
    } else if (file.status < 200 || file.status >= 300) {
      signals.push({
        id: 'file',
        label: `/${key}.txt`,
        status: CRITICAL,
        detail: `HTTP ${file.status}`,
        recommendation: `The server answered the key file with HTTP ${file.status}. It must return 200 with the key as its body.`,
        unmeasurable: false,
      });
    } else {
      const body = (file.body ?? '').trim();
      const looksHtml = /^\s*<(!doctype|html)\b/i.test(body) || /text\/html/i.test(file.contentType ?? '');
      if (looksHtml) {
        // 200 + HTML at a .txt path is the theme's catch-all, not the file. Shopify does this.
        signals.push({
          id: 'file',
          label: `/${key}.txt`,
          status: CRITICAL,
          detail: 'The server returned an HTML page rather than the key file',
          recommendation: 'Your theme is answering this path with HTML, which means the key file itself is not published.',
          unmeasurable: false,
        });
      } else if (body.toLowerCase() !== key.toLowerCase()) {
        signals.push({
          id: 'file',
          label: `/${key}.txt`,
          status: CRITICAL,
          // The published body is never echoed: it is somebody's key, and this result is stored.
          detail: `Published, but its contents do not match the key Rankvora AI has on file (${body.length} bytes returned)`,
          recommendation: 'The file must contain the key and nothing else — no heading, no newline-separated extras.',
          unmeasurable: false,
        });
      } else {
        signals.push({
          id: 'file',
          label: `/${key}.txt`,
          status: HEALTHY,
          detail: 'Published and matches the configured key',
          recommendation: '',
          unmeasurable: false,
        });
      }
    }

    // ── 2. A reachable sitemap ──
    // Not required by the IndexNow spec, and not presented as if it were. It is how engines
    // discover and re-check every page between pings, so a store that cannot serve one is relying
    // on submissions and link-following alone.
    const sitemap = crawl?.sitemap ?? null;
    if (!crawl || crawl.passwordGated || !sitemap || sitemap.passwordGated) {
      signals.push({
        id: 'sitemap',
        label: '/sitemap.xml',
        status: NEEDS_WORK,
        detail: 'Not measured on this run',
        recommendation: 'Could not be checked — the sitemap was not readable during this audit.',
        unmeasurable: true,
      });
    } else if (sitemap.status === 200) {
      signals.push({
        id: 'sitemap',
        label: '/sitemap.xml',
        status: HEALTHY,
        detail: `Reachable — ${crawl.sitemapRecords.length || crawl.sitemapEntries.length} URLs listed`,
        recommendation: '',
        unmeasurable: false,
      });
    } else {
      signals.push({
        id: 'sitemap',
        label: '/sitemap.xml',
        status: NEEDS_WORK,
        detail: `HTTP ${sitemap.status}`,
        recommendation: 'Engines read your sitemap to find and re-check pages between submissions. Fix whatever is intercepting it.',
        unmeasurable: false,
      });
    }

    const rows: SubPillarEvidenceRow[] = signals.map((signal) => ({
      id: `indexnow:${signal.id}`,
      status: signal.status,
      facet: signal.status,
      cells: {
        signal: signal.label,
        detail: signal.detail,
        // NO `coverage`: each signal is one yes/no request, and 100/0 restated it as a percentage.
        status: signal.status,
        recommendation: signal.recommendation,
      },
      current: { label: 'Requested', value: signal.detail, meta: signal.id === 'file' ? keyUrl : `${origin}/sitemap.xml` },
      ...(signal.recommendation ? { suggested: { label: 'Recommendation', value: signal.recommendation } } : {}),
    }));

    const measurable = signals.filter((signal) => !signal.unmeasurable);
    if (measurable.length === 0) {
      // Each cause named as what it is. "Could not reach your storefront" used to cover all three,
      // including a server with crawling switched off and a key file that simply redirects.
      return unavailableResult(
        'indexnow',
        !crawl
          ? 'Storefront crawling is switched off on this Rankvora AI server, so the IndexNow key file was not requested.'
          : crawl.passwordGated
            ? 'Your storefront is password protected, so every URL returns the password screen and Rankvora AI cannot tell whether the IndexNow key file exists. Remove the password under Online Store → Preferences, then run the audit again.'
            : redirectsOffHost(file)
              ? `The key file at ${keyUrl} redirects to another host, so Rankvora AI did not read it, and the sitemap could not be read either. ${REDIRECT_ADVICE}`
              : 'Rankvora AI could not reach your storefront, so IndexNow readiness could not be checked.',
      );
    }

    const healthy = measurable.filter((signal) => signal.status === HEALTHY).length;
    const findings: SubPillarFindingResult[] = [];
    const keySignal = signals.find((signal) => signal.id === 'file');

    if (keySignal && !keySignal.unmeasurable && keySignal.status !== HEALTHY) {
      findings.push({
        title: 'IndexNow key file is not verifiable',
        severity: 'high',
        affectedCount: 1,
        affectedLabel: 'key file',
        // One of the measurable signals, as a share — the same arithmetic every other check uses.
        scoreLift: Math.round((1 / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `A key is configured for this store, but ${keyUrl} did not return it. ${keySignal.detail}.`,
        why: 'IndexNow proves you control the site by fetching this exact file and matching its contents against the key in your submission. Until it resolves, every submission is rejected — so the store gets none of the instant-indexing benefit while appearing, in your settings, to be set up for it.',
        recommendation: 'Serve the key file at your storefront root, returning HTTP 200 with the key as the entire body. A stock Shopify storefront cannot host a root file itself: the usual workaround is uploading it under Content → Files and adding a URL redirect from this path to it, which you should then confirm with a test submission at api.indexnow.org. A file served from your own domain — for example by an edge worker in front of the store — always satisfies IndexNow.',
        evidence: [`GET ${keyUrl}: ${keySignal.detail}.`],
        evidenceRows: rows.filter((row) => row.id === 'indexnow:file'),
        details: { issueType: CRITICAL },
      });
    }

    const sitemapSignal = signals.find((signal) => signal.id === 'sitemap');
    if (sitemapSignal && !sitemapSignal.unmeasurable && sitemapSignal.status !== HEALTHY) {
      findings.push({
        title: 'Sitemap is not reachable for IndexNow reconciliation',
        severity: 'medium',
        affectedCount: 1,
        affectedLabel: 'sitemap',
        scoreLift: Math.round((1 / measurable.length) * 100),
        resolutionType: 'settings',
        problem: `${origin}/sitemap.xml did not return HTTP 200. ${sitemapSignal.detail}.`,
        // Stated as what a sitemap is for, not as an IndexNow requirement — the protocol does not
        // require one, and this used to claim engines reconcile every submission against it.
        why: 'IndexNow tells engines that a page changed; the sitemap is how they discover and re-check every page in between. A store whose sitemap cannot be read leaves engines finding pages only by following links, however quickly it pings them.',
        recommendation: 'Shopify serves /sitemap.xml automatically on public stores — investigate what is intercepting it.',
        evidence: [`GET ${origin}/sitemap.xml: ${sitemapSignal.detail}.`],
        details: { issueType: NEEDS_WORK },
      });
    }

    const skipped = signals.filter((signal) => signal.unmeasurable);
    if (skipped.length > 0) {
      const skippedRows = rows.filter((row) => skipped.some((signal) => row.id === `indexnow:${signal.id}`));
      const keyRedirects = skipped.some((signal) => signal.id === 'file') && redirectsOffHost(file);
      findings.push(notCheckedFinding({
        title: keyRedirects ? 'IndexNow key file redirects to another host' : 'Some IndexNow signals could not be checked',
        rows: skippedRows,
        affectedLabel: skipped.length === 1 ? 'signal' : 'signals',
        problem: skipped.map((signal) => `${signal.label}: ${signal.detail}.`).join(' '),
        why: 'Rankvora AI reports only what a request actually returned. These did not return anything it could read, so they are left out of the score — neither passed nor failed.',
        recommendation: keyRedirects
          ? REDIRECT_ADVICE
          : skipped.map((signal) => signal.recommendation).filter((text, index, all) => all.indexOf(text) === index).join(' '),
        evidence: skipped.map((signal) => `${signal.label}: ${signal.detail}.`),
      }));
    }
    const verified = keySignal?.status === HEALTHY;

    return {
      subPillar: 'indexnow',
      status: 'ok',
      score: scoreSubPillar(measurable.length, healthy, findings),
      analyzedCount: measurable.length,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: verified
          ? `IndexNow is ready: the key file at ${keyUrl} returned the configured key, so submissions from this store will authenticate.${skipped.length > 0 ? ` ${skipped.length} signal(s) could not be checked on this run.` : ''}`
          : `${healthy} of ${measurable.length} IndexNow signals passed. Each one is a live HTTP request, not an inference from your settings.${skipped.length > 0 ? ` ${skipped.length} signal(s) could not be checked on this run.` : ''}`,
        healthChip: `${healthy}/${measurable.length} signals pass`,
        contextLabel: 'Key file',
        contextValue: verified ? 'Verified' : 'Not verified',
        evidenceRows: rows,
      },
      findings,
    };
  },
};
