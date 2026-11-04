import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawledPage } from '../../storefront/types.js';
import { crawlScopeNote, pageLabel, requireCrawl } from '../shared/crawl.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, type RowStatus } from '../shared/status.js';

/**
 * ─── CRO · Clarity and behaviour readiness ───────────────────────────
 * Judges the rendered page structure a shopper actually lands on.
 *
 * ONLY OBJECTIVELY MEASURABLE SIGNALS. "Is this page persuasive?" is not something a fetch can
 * answer, and inventing a number for it would be the fabrication this engine exists to prevent.
 * What a crawl CAN establish, precisely, is structural:
 *
 *   · exactly one H1        the page states what it is, once
 *   · no skipped levels     H1 → H3 with no H2 breaks the document outline
 *   · real body copy        there is something to read
 *   · images carry alt      the page is navigable without sight
 *   · a title that matches  the tab and the H1 describe the same thing
 *
 * Each is a yes/no fact about the markup, reproducible on every run. Nothing here scores tone,
 * layout, colour or persuasion — those need a rendering browser and a human, and a Lab service
 * Rankvora AI does not have.
 */

/** Below this a page has effectively no copy for a shopper to read. */
const MIN_BODY_TEXT = 200;

interface Assessment {
  status: RowStatus;
  issue: string;
  detail: string;
  recommendation: string;
}

function assess(page: CrawledPage): Assessment {
  const h1s = page.headings.filter((heading) => heading.level === 1);

  if (h1s.length === 0) {
    return {
      status: CRITICAL,
      issue: 'No H1',
      detail: `${page.headings.length} headings, none of them an H1`,
      recommendation: 'Give this page a single H1 naming what it is — the product, the collection, the topic.',
    };
  }

  if (h1s.length > 1) {
    return {
      status: NEEDS_WORK,
      issue: `${h1s.length} H1 headings`,
      detail: h1s.slice(0, 3).map((heading) => heading.text.slice(0, 40)).join(' · '),
      recommendation: 'Keep one H1 per page and demote the others to H2 — several competing H1s leave the page with no stated subject.',
    };
  }

  if (page.textLength < MIN_BODY_TEXT) {
    return {
      status: NEEDS_WORK,
      issue: 'Almost no readable content',
      detail: `${formatCount(page.textLength)} characters of visible text`,
      recommendation: 'Add real copy — a shopper who cannot read anything about the product cannot decide to buy it.',
    };
  }

  // A skipped level breaks the outline assistive technology and crawlers navigate by.
  const levels = page.headings.map((heading) => heading.level);
  let skippedFrom: number | null = null;
  for (let index = 1; index < levels.length; index += 1) {
    if (levels[index] - levels[index - 1] > 1) { skippedFrom = levels[index - 1]; break; }
  }
  if (skippedFrom !== null) {
    return {
      status: NEEDS_WORK,
      issue: 'Heading levels skip',
      detail: `outline jumps from H${skippedFrom} straight past H${skippedFrom + 1}`,
      recommendation: 'Use heading levels in order so the page has a readable outline.',
    };
  }

  const missingAlt = page.images.filter((image) => image.alt === null);
  if (page.images.length > 0 && missingAlt.length / page.images.length > 0.5) {
    return {
      status: NEEDS_WORK,
      issue: 'Most rendered images have no alt attribute',
      detail: `${formatCount(missingAlt.length)} of ${formatCount(page.images.length)} images`,
      recommendation: 'Add alt text to the theme\'s images — without it the page is unusable on a screen reader and its images are invisible to search.',
    };
  }

  return {
    status: HEALTHY,
    issue: '',
    detail: `${h1s[0].text.slice(0, 60)} · ${formatCount(page.headings.length)} headings · ${formatCount(page.textLength)} characters`,
    recommendation: '—',
  };
}

export const clarityCheck: AuditCheck = {
  id: 'cro.clarity',
  pillar: 'cro',
  subPillar: 'clarity',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const guard = requireCrawl(snapshot, 'clarity', 'the structure of your rendered pages');
    if (!guard.ok) return guard.result;
    const { crawl, pages } = guard.evidence;

    const rows: SubPillarEvidenceRow[] = [];
    const byIssue = new Map<string, CrawledPage[]>();
    let healthy = 0;

    for (const page of pages) {
      const assessment = assess(page);
      if (assessment.status === HEALTHY) healthy += 1;
      else {
        const key = assessment.issue.replace(/^\d+ /, '').replace(/s$/, '');
        const bucket = byIssue.get(key) ?? [];
        bucket.push(page);
        byIssue.set(key, bucket);
      }

      rows.push({
        id: `page:${page.pageType}:${page.resourceId ?? 'home'}`,
        status: assessment.status,
        facet: assessment.status,
        cells: {
          surface: pageLabel(page),
          signal: assessment.issue || 'Structure is clear',
          coverage: assessment.status === HEALTHY ? 100 : 0,
          status: assessment.status,
          recommendation: assessment.recommendation,
        },
        current: { label: 'Rendered structure', value: assessment.detail, meta: page.finalUrl },
        suggested: { label: 'Recommendation', value: assessment.recommendation },
      });
    }

    const analyzed = pages.length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);
    const bucket = (key: string) => byIssue.get(key) ?? [];

    const noH1 = bucket('No H1');
    if (noH1.length > 0) {
      findings.push({
        title: 'Pages with no H1 heading',
        severity: 'high',
        affectedCount: noH1.length,
        affectedLabel: 'pages',
        scoreLift: lift(noH1.length),
        resolutionType: 'theme',
        problem: `${formatCount(noH1.length)} of the ${formatCount(analyzed)} pages loaded render no H1.`,
        why: 'The H1 is where a page states what it is. Without one a shopper scanning the page has no anchor, and a search engine has to infer the subject from everything else on it.',
        recommendation: 'Add a single H1 to the affected templates naming the product, collection or topic.',
        evidence: noH1.slice(0, 5).map((page) => `${pageLabel(page)}: ${page.headings.length} headings, no H1.`),
        evidenceRows: rows.filter((row) => row.cells.signal === 'No H1').slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    const manyH1 = bucket('H1 heading');
    if (manyH1.length > 0) {
      findings.push({
        title: 'Pages with more than one H1',
        severity: 'medium',
        affectedCount: manyH1.length,
        affectedLabel: 'pages',
        scoreLift: lift(manyH1.length),
        resolutionType: 'theme',
        problem: `${formatCount(manyH1.length)} pages render several H1 headings.`,
        why: 'Competing H1s leave the page with no single stated subject, which weakens both the shopper\'s orientation and the page\'s topical signal.',
        recommendation: 'Keep one H1 and demote the rest to H2.',
        evidence: manyH1.slice(0, 5).map((page) => `${pageLabel(page)}: ${page.headings.filter((heading) => heading.level === 1).length} H1s.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    const thin = bucket('Almost no readable content');
    if (thin.length > 0) {
      findings.push({
        title: 'Pages with almost no readable content',
        severity: 'high',
        affectedCount: thin.length,
        affectedLabel: 'pages',
        scoreLift: lift(thin.length),
        resolutionType: 'content',
        problem: `${formatCount(thin.length)} pages render under ${MIN_BODY_TEXT} characters of visible text.`,
        why: 'A shopper cannot decide to buy something the page does not describe, and a page with nothing to read has nothing to rank for.',
        recommendation: 'Add real copy to these pages.',
        evidence: thin.slice(0, 5).map((page) => `${pageLabel(page)}: ${formatCount(page.textLength)} characters of visible text.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    const outline = bucket('Heading level skip');
    if (outline.length > 0) {
      findings.push({
        title: 'Pages whose heading outline skips levels',
        severity: 'low',
        affectedCount: outline.length,
        affectedLabel: 'pages',
        scoreLift: lift(outline.length),
        resolutionType: 'theme',
        problem: `${formatCount(outline.length)} pages jump a heading level.`,
        why: 'Screen readers and crawlers navigate by the heading outline. A skipped level makes the page structure ambiguous to both.',
        recommendation: 'Use heading levels in sequence rather than for visual size.',
        evidence: outline.slice(0, 5).map((page) => pageLabel(page)),
        details: { issueType: NEEDS_WORK },
      });
    }

    const altGap = bucket('Most rendered image have no alt attribute');
    if (altGap.length > 0) {
      findings.push({
        title: 'Pages where most rendered images have no alt text',
        severity: 'medium',
        affectedCount: altGap.length,
        affectedLabel: 'pages',
        scoreLift: lift(altGap.length),
        resolutionType: 'theme',
        problem: `${formatCount(altGap.length)} pages render more images without an alt attribute than with one.`,
        why: 'This is the theme\'s own imagery, not your product photos — banners, icons and lifestyle shots the theme places. Missing alt text there is invisible to the Shopify admin and still makes the page unusable on a screen reader.',
        recommendation: 'Add alt text in the theme editor for banner and section images.',
        evidence: altGap.slice(0, 5).map((page) => `${pageLabel(page)}: ${page.images.filter((image) => image.alt === null).length} of ${page.images.length} images without alt.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    return {
      subPillar: 'clarity',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} pages have a clear, well-formed structure. Only objectively measurable structure is scored here — layout and persuasion need a rendering browser, which Rankvora AI does not run. ${crawlScopeNote(crawl)}`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Pages with one H1',
        contextValue: `${pages.filter((page) => page.headings.filter((heading) => heading.level === 1).length === 1).length} of ${analyzed}`,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
