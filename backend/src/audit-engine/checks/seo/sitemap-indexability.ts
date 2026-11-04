import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';

/**
 * ─── SEO · Sitemap & indexability ────────────────────────────────────
 * Scores the three signals that decide whether the store can be indexed AT ALL, from real HTTP
 * probes performed by the provider (never inferred):
 *
 *   1. STOREFRONT REACHABILITY — a password-protected storefront redirects every page to
 *      /password. That is not a measurement gap; it is the single most severe indexability
 *      finding a store can have: no search engine can see any page.
 *   2. robots.txt — present, fetchable, and not disallowing everything.
 *   3. sitemap.xml — present and fetchable.
 *
 * Per-page noindex/canonical coverage needs a full crawl of rendered pages and is explicitly
 * NOT claimed here; the summary says so.
 */

const HEALTHY = 'Healthy';
const BLOCKED = 'Blocked';
const MISSING = 'Missing';

export const sitemapIndexabilityCheck: AuditCheck = {
  id: 'seo.sitemap',
  pillar: 'seo',
  subPillar: 'sitemap',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const storefront = snapshot.storefront;
    if (!snapshot.coverage.storefront || !storefront) {
      return unavailableResult('sitemap', 'The storefront could not be probed, so indexability is unknown.');
    }

    const rows: SubPillarEvidenceRow[] = [];
    const findings: SubPillarFindingResult[] = [];
    let healthy = 0;
    const analyzed = 3; // the three probes below — each a real HTTP request with a real answer

    // ── 1. Storefront gate ──
    const gated = storefront.passwordProtected;
    rows.push({
      id: 'probe:homepage',
      status: gated ? BLOCKED : storefront.homepage.status === 200 ? HEALTHY : MISSING,
      facet: 'Storefront',
      cells: { url: '/', pageType: 'Storefront', title: gated ? 'Redirects to /password' : `HTTP ${storefront.homepage.status}`, length: storefront.homepage.status },
      current: { label: 'Homepage', value: gated ? 'Password-protected' : `HTTP ${storefront.homepage.status}`, meta: 'live probe' },
    });
    // Filled in once the sitemap probe below has answered: the gate accounts for the homepage and,
    // when it hides it, the sitemap too — the one root cause is charged once, for both.
    let gateFinding: SubPillarFindingResult | null = null;
    if (gated) {
      gateFinding = {
        title: 'Storefront is password-protected — invisible to search engines',
        severity: 'critical',
        affectedCount: 1,
        affectedLabel: 'storefront',
        scoreLift: 0,
        resolutionType: 'settings',
        problem: 'Every storefront URL redirects to the password screen.',
        why: 'While the password is on, Google and every other crawler receive the password page instead of your content — nothing on the store can rank, and existing rankings decay. This single setting outweighs every other SEO signal.',
        recommendation: 'Remove the storefront password in Shopify admin → Online Store → Preferences (available once the store is on a paid plan).',
        evidence: [
          `Homepage probe: HTTP ${storefront.homepage.status}, redirected to /password.`,
          `Sitemap probe: HTTP ${storefront.sitemap.status}.`,
        ],
        details: { issueType: BLOCKED },
      };
      findings.push(gateFinding);
    } else if (storefront.homepage.status === 200) {
      healthy += 1;
    }

    // ── 2. robots.txt ──
    const robots = storefront.robots;
    const robotsBody = robots.body ?? '';
    // "Disallow: /" in a group with no Allow overriding it — the blunt everything-blocked case.
    const disallowAll = /^\s*Disallow:\s*\/\s*$/mi.test(robotsBody) && !/^\s*Allow:\s*\//mi.test(robotsBody);
    const robotsHealthy = robots.status === 200 && robotsBody.length > 0 && !disallowAll;
    rows.push({
      id: 'probe:robots',
      status: robots.status !== 200 ? MISSING : disallowAll ? BLOCKED : HEALTHY,
      facet: 'robots.txt',
      cells: { url: '/robots.txt', pageType: 'robots.txt', title: robots.status === 200 ? `${robotsBody.split('\n').length} lines` : `HTTP ${robots.status}`, length: robots.status },
      current: { label: 'robots.txt', value: robots.status === 200 ? (disallowAll ? 'Disallows everything' : 'Present and permissive') : `HTTP ${robots.status}`, meta: 'live probe' },
    });
    if (robotsHealthy) healthy += 1;
    else if (robots.status === 200 && disallowAll) {
      findings.push({
        title: 'robots.txt disallows the entire site',
        severity: 'critical',
        affectedCount: 1,
        affectedLabel: 'robots.txt',
        // One of the three probes. It was a typed-in 67.
        scoreLift: Math.round((1 / analyzed) * 100),
        resolutionType: 'settings',
        problem: 'robots.txt contains a blanket Disallow: / with no overriding Allow.',
        why: 'Compliant crawlers will not fetch any page, so the store cannot be indexed regardless of its content.',
        recommendation: 'Remove the blanket Disallow, or replace robots.txt with Shopify’s default.',
        evidence: ['Blanket "Disallow: /" detected in the live robots.txt.'],
        details: { issueType: BLOCKED },
      });
    }

    // ── 3. sitemap.xml ──
    const sitemap = storefront.sitemap;
    const sitemapHealthy = sitemap.status === 200;
    rows.push({
      id: 'probe:sitemap',
      status: sitemapHealthy ? HEALTHY : gated ? BLOCKED : MISSING,
      facet: 'sitemap.xml',
      cells: { url: '/sitemap.xml', pageType: 'sitemap.xml', title: `HTTP ${sitemap.status}`, length: sitemap.status },
      current: { label: 'sitemap.xml', value: sitemapHealthy ? 'Reachable' : `HTTP ${sitemap.status}${gated ? ' (behind password)' : ''}`, meta: 'live probe' },
    });
    if (sitemapHealthy) healthy += 1;
    else if (!gated) {
      // Behind the password gate the sitemap 404 is a SYMPTOM of the critical finding above —
      // raising a second finding for it would double-charge one root cause.
      findings.push({
        title: 'sitemap.xml is not reachable',
        severity: 'high',
        affectedCount: 1,
        affectedLabel: 'sitemap',
        scoreLift: Math.round((1 / analyzed) * 100),
        resolutionType: 'settings',
        problem: `GET /sitemap.xml returned HTTP ${sitemap.status}.`,
        why: 'Without a sitemap, search engines rely on link discovery alone, so deep products and new pages are indexed late or not at all.',
        recommendation: 'Shopify serves /sitemap.xml automatically on public stores — investigate what is intercepting it.',
        evidence: [`Live probe returned HTTP ${sitemap.status}.`],
        details: { issueType: MISSING },
      });
    }

    if (gateFinding) gateFinding.scoreLift = Math.round(((sitemapHealthy ? 1 : 2) / analyzed) * 100);

    return {
      subPillar: 'sitemap',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${healthy} of ${analyzed} indexability probes passed (storefront reachability, robots.txt, sitemap.xml — all live HTTP checks). Per-page noindex and canonical coverage need a full page crawl and are not claimed here.`,
        healthChip: `${healthy}/${analyzed} probes pass`,
        contextLabel: 'Storefront',
        contextValue: gated ? 'Password-protected' : 'Publicly reachable',
        evidenceRows: rows,
      },
      findings,
    };
  },
};
