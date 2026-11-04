import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { crawlScopeNote, pageLabel, pageName, requireCrawl } from '../shared/crawl.js';
import { formatCount, takeEvidenceSample } from './page-inventory.js';

/**
 * ─── SEO · Internal links ────────────────────────────────────────────
 * Reads the anchors the theme actually renders, and verifies where the internal ones lead.
 *
 * A LINK IS ONLY CALLED BROKEN WHEN ITS TARGET WAS ACTUALLY REQUESTED AND ANSWERED WITH AN ERROR.
 * The crawler verifies a sample of internal targets and records the status it received; a target
 * that was never checked, or whose check failed at the network level, is recorded as status 0 and
 * is reported as UNVERIFIED, never as broken. Telling a merchant a link is dead when Rankvora AI
 * simply did not look is the exact failure this whole engine is built to avoid — and it is the
 * easiest mistake to make here, because "not 200" reads like "broken".
 *
 * WHAT IS MEASURED
 *   · orphan-ish pages   crawled pages that nothing else links to
 *   · broken targets     internal links whose target really returned 4xx/5xx
 *   · thin linking       pages with almost no internal links out
 *   · anchor quality     "click here" / "read more" links, which carry no signal
 *
 * The unit is the PAGE, so the score answers "how many of my pages link well?".
 */

const HEALTHY = 'Healthy';
const NEEDS_WORK = 'Needs Work';
const CRITICAL = 'Critical';

/** Below this a page is a dead end — it receives link equity and passes almost none on. */
const MIN_INTERNAL_LINKS = 3;

/** Anchor text that describes the click rather than the destination. */
const WEAK_ANCHOR = /^(click here|here|read more|more|learn more|this|link|shop now|view|see more|details)$/i;

export const internalLinksCheck: AuditCheck = {
  id: 'seo.internal-links',
  pillar: 'seo',
  subPillar: 'internal-links',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const guard = requireCrawl(snapshot, 'internal-links', 'the links your pages render');
    if (!guard.ok) return guard.result;
    const { crawl, pages } = guard.evidence;

    // Which crawled pages are linked to from somewhere else in the crawl.
    const linkedTo = new Set<string>();
    for (const page of pages) {
      for (const link of page.links) {
        if (link.internal && link.url !== page.finalUrl) linkedTo.add(link.url);
      }
    }

    const rows: SubPillarEvidenceRow[] = [];
    const brokenByPage = new Map<string, Array<{ url: string; status: number }>>();
    const thin: string[] = [];
    const weakAnchors: string[] = [];
    const orphans: string[] = [];
    let healthy = 0;
    let totalInternal = 0;
    let verifiedTargets = 0;
    let brokenTargets = 0;

    for (const page of pages) {
      const internal = page.links.filter((link) => link.internal);
      totalInternal += internal.length;

      // Only a target Rankvora AI actually requested and that answered with an error counts. Status 0
      // means "not verified" and is deliberately excluded from both numerator and denominator.
      const broken: Array<{ url: string; status: number }> = [];
      for (const link of internal) {
        const status = crawl.linkStatuses[link.url];
        if (status === undefined || status === 0) continue;
        verifiedTargets += 1;
        if (status >= 400) {
          broken.push({ url: link.url, status });
          brokenTargets += 1;
        }
      }

      const weak = internal.filter((link) => WEAK_ANCHOR.test(link.text.trim()));
      const isOrphan = page.pageType !== 'home' && !linkedTo.has(page.finalUrl);

      let status = HEALTHY;
      let issue = '';
      let recommendation = '—';

      if (broken.length > 0) {
        status = CRITICAL;
        issue = `${broken.length} broken internal link${broken.length === 1 ? '' : 's'}`;
        recommendation = 'Repoint or remove these links — each one sends a shopper to an error page.';
        brokenByPage.set(page.finalUrl, broken);
      } else if (internal.length < MIN_INTERNAL_LINKS) {
        status = NEEDS_WORK;
        issue = 'Almost no internal links';
        recommendation = 'Link out to related products, collections or guides so this page passes visitors and crawlers onward.';
        thin.push(pageLabel(page));
      } else if (isOrphan) {
        status = NEEDS_WORK;
        issue = 'Not linked from any other crawled page';
        recommendation = 'Link to this page from a collection, the navigation, or a related page.';
        orphans.push(pageLabel(page));
      } else if (weak.length > 0) {
        status = NEEDS_WORK;
        issue = `${weak.length} uninformative anchor${weak.length === 1 ? '' : 's'}`;
        recommendation = 'Replace "click here"-style anchors with text naming the destination.';
        weakAnchors.push(pageLabel(page));
      } else {
        healthy += 1;
      }

      rows.push({
        id: `page:${page.pageType}:${page.resourceId ?? 'home'}`,
        status,
        facet: status,
        cells: {
          // What identifies the row in the table: the resource's name as it is in Shopify. `url`
          // stays for search and as the fallback when the page maps to no snapshot resource.
          name: pageName(snapshot, page),
          url: pageLabel(page),
          pageType: page.pageType,
          internalLinks: internal.length,
          externalLinks: page.links.length - internal.length,
          status,
          recommendation,
        },
        current: {
          label: 'Links on this page',
          value: `${formatCount(internal.length)} internal, ${formatCount(page.links.length - internal.length)} external`,
          meta: issue || 'Links out to the rest of the store',
        },
        suggested: { label: 'Recommendation', value: recommendation },
      });
    }

    const analyzed = pages.length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);

    if (brokenByPage.size > 0) {
      const examples: string[] = [];
      for (const [pageUrl, links] of brokenByPage) {
        for (const link of links.slice(0, 2)) examples.push(`${pageUrl} → ${link.url} (HTTP ${link.status})`);
        if (examples.length >= 5) break;
      }
      findings.push({
        title: 'Internal links pointing at pages that return an error',
        severity: 'critical',
        affectedCount: brokenByPage.size,
        affectedLabel: 'pages',
        scoreLift: lift(brokenByPage.size),
        resolutionType: 'content',
        problem: `${formatCount(brokenTargets)} internal links across ${formatCount(brokenByPage.size)} pages lead to an error page.`,
        why: 'A shopper who follows one lands on an error and usually leaves. Crawlers treat repeated internal 404s as a quality signal, and the link equity spent on that link is simply lost.',
        recommendation: 'Repoint each link at the resource that replaced it, or add a URL redirect for the old address.',
        evidence: [`Rankvora AI requested ${formatCount(verifiedTargets)} internal link targets; ${formatCount(brokenTargets)} returned 4xx or 5xx.`, ...examples],
        evidenceRows: rows.filter((row) => row.cells.status === CRITICAL).slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    if (thin.length > 0) {
      findings.push({
        title: 'Pages that link almost nowhere',
        severity: 'medium',
        affectedCount: thin.length,
        affectedLabel: 'pages',
        scoreLift: lift(thin.length),
        resolutionType: 'content',
        problem: `${formatCount(thin.length)} pages render fewer than ${MIN_INTERNAL_LINKS} internal links.`,
        why: 'A page with no onward links is a dead end: it absorbs authority and passes none on, and a shopper who reaches it has nowhere to go but back.',
        recommendation: 'Add links to related products, the parent collection, or a relevant guide.',
        evidence: [`${formatCount(thin.length)} of ${formatCount(analyzed)} crawled pages link out fewer than ${MIN_INTERNAL_LINKS} times.`, ...thin.slice(0, 5)],
        details: { issueType: NEEDS_WORK },
      });
    }

    if (orphans.length > 0) {
      findings.push({
        title: 'Pages nothing else links to',
        severity: 'medium',
        affectedCount: orphans.length,
        affectedLabel: 'pages',
        scoreLift: lift(orphans.length),
        resolutionType: 'content',
        problem: `${formatCount(orphans.length)} crawled pages were not linked from any other page Rankvora AI loaded.`,
        why: 'A page reachable only from the sitemap is one a crawler finds late and ranks low, and one a shopper never stumbles into. Note this is measured across the pages Rankvora AI sampled, so a link from an unsampled page would not be seen.',
        recommendation: 'Link these pages from the navigation, a collection, or related content.',
        evidence: orphans.slice(0, 5),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (weakAnchors.length > 0) {
      findings.push({
        title: 'Links whose anchor text describes nothing',
        severity: 'low',
        affectedCount: weakAnchors.length,
        affectedLabel: 'pages',
        scoreLift: lift(weakAnchors.length),
        resolutionType: 'content',
        problem: `${formatCount(weakAnchors.length)} pages use anchors like "click here" or "read more".`,
        why: 'Anchor text is one of the few signals that says what the destination is about. "Read more" describes the click rather than the page, and is unusable for anyone navigating by links alone.',
        recommendation: 'Rewrite anchors to name the destination — "our returns policy" rather than "click here".',
        evidence: weakAnchors.slice(0, 5),
        details: { issueType: NEEDS_WORK },
      });
    }

    const unverified = totalInternal - verifiedTargets;

    return {
      subPillar: 'internal-links',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} pages link well to the rest of the store. Rankvora AI verified ${formatCount(verifiedTargets)} internal link targets${unverified > 0 ? `; ${formatCount(unverified)} more were found but not requested, and are not counted either way` : ''}. ${crawlScopeNote(crawl)}`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Internal links found',
        contextValue: formatCount(totalInternal),
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
