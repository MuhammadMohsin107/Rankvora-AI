import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { suggestDescription } from '../shared/recommend.js';
import {
  buildPageInventory,
  findDuplicateValues,
  formatCount,
  pathOf,
  takeEvidenceSample,
  type InventoryPage,
} from './page-inventory.js';

/**
 * ─── SEO · Meta Descriptions ─────────────────────────────────────────
 * Scores the meta description of every indexable page.
 *
 * WHAT IS ACTUALLY MEASURED — AND THE HONEST LIMIT
 * Unlike a title, a meta description has NO reliable resource-level fallback: Shopify emits the
 * merchant's SEO description when one is set, and when it is not, what happens depends entirely
 * on the theme (some emit nothing, some derive an excerpt). The Admin API cannot tell us which,
 * and this check does not fetch the storefront HTML.
 *
 * So "Missing" here means precisely "no meta description is configured in Shopify" — a real,
 * actionable gap — and NOT a proven absent <meta name="description"> tag. That distinction is
 * stated in the finding copy rather than glossed over.
 *
 * LENGTH THRESHOLDS (70-160 characters) are a snippet-display heuristic, not a ranking rule.
 * Google renders roughly 155-160 characters on desktop before truncating, and a description
 * under ~70 leaves most of the snippet empty. Descriptions are also frequently rewritten by
 * Google to match the query, so these bounds optimize the common case, they do not guarantee it.
 */

const MIN_DESCRIPTION_LENGTH = 70;
const MAX_DESCRIPTION_LENGTH = 160;

const HEALTHY = 'Healthy';
const MISSING = 'Missing';
const TOO_SHORT = 'Too Short';
const TOO_LONG = 'Too Long';
const DUPLICATE = 'Duplicate';

/** Only the configured override counts — see the theme-fallback note in the file header. */
function effectiveDescription(page: InventoryPage): string {
  return page.seoDescription?.trim() ?? '';
}

function classify(description: string, isDuplicate: boolean): string {
  if (!description) return MISSING;
  if (isDuplicate) return DUPLICATE;
  if (description.length < MIN_DESCRIPTION_LENGTH) return TOO_SHORT;
  if (description.length > MAX_DESCRIPTION_LENGTH) return TOO_LONG;
  return HEALTHY;
}

function buildFindings(counts: Record<string, number>, analyzed: number): SubPillarFindingResult[] {
  const findings: SubPillarFindingResult[] = [];

  if (counts[MISSING] > 0) {
    findings.push({
      title: 'Pages with no meta description',
      // 'high', deliberately not 'critical': the page still indexes and ranks. What is lost is
      // control of the snippet, which is a serious click-through problem but not a broken page.
      severity: 'high',
      affectedCount: counts[MISSING],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[MISSING] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[MISSING])} pages have no meta description set in Shopify.`,
      why: 'Without a description you hand the search snippet to whatever the theme or search engine improvises, which is often a truncated fragment of page copy that does not persuade anyone to click.',
      recommendation: `Write a unique ${MIN_DESCRIPTION_LENGTH}-${MAX_DESCRIPTION_LENGTH} character description for each page, leading with the benefit and including the terms shoppers search for.`,
      evidence: [
        `${formatCount(counts[MISSING])} of ${formatCount(analyzed)} pages have no description configured.`,
        'Measured from the Shopify SEO description field. A theme may still emit a fallback description that Rankvora AI cannot observe through the Admin API.',
      ],
      details: { issueType: MISSING },
    });
  }

  if (counts[DUPLICATE] > 0) {
    findings.push({
      title: 'Duplicate meta descriptions',
      severity: 'medium',
      affectedCount: counts[DUPLICATE],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[DUPLICATE] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[DUPLICATE])} pages repeat a description used elsewhere on the store.`,
      why: 'Identical snippets make near-identical results in the listing, so shoppers cannot tell which page answers their query and search engines often drop the repeated copy entirely.',
      recommendation: 'Rewrite the repeated descriptions so each one names what is specific to that page.',
      evidence: [`${formatCount(counts[DUPLICATE])} of ${formatCount(analyzed)} descriptions are not unique.`],
      details: { issueType: DUPLICATE },
    });
  }

  if (counts[TOO_LONG] > 0) {
    findings.push({
      title: 'Meta descriptions over the snippet limit',
      severity: 'low',
      affectedCount: counts[TOO_LONG],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[TOO_LONG] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[TOO_LONG])} descriptions exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
      why: 'Anything past the snippet limit is cut off, so a call to action placed at the end is never seen.',
      recommendation: `Tighten these to ${MAX_DESCRIPTION_LENGTH} characters or fewer, front-loading the benefit.`,
      evidence: [`${formatCount(counts[TOO_LONG])} of ${formatCount(analyzed)} descriptions exceed ${MAX_DESCRIPTION_LENGTH} characters.`],
      details: { issueType: TOO_LONG },
    });
  }

  if (counts[TOO_SHORT] > 0) {
    findings.push({
      title: 'Meta descriptions under the recommended length',
      severity: 'low',
      affectedCount: counts[TOO_SHORT],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[TOO_SHORT] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[TOO_SHORT])} descriptions are shorter than ${MIN_DESCRIPTION_LENGTH} characters.`,
      why: 'A short description leaves most of the snippet blank and usually omits the detail that would persuade a shopper to choose this result.',
      recommendation: `Expand these to at least ${MIN_DESCRIPTION_LENGTH} characters with the specifics a buyer needs.`,
      evidence: [`${formatCount(counts[TOO_SHORT])} of ${formatCount(analyzed)} descriptions are under ${MIN_DESCRIPTION_LENGTH} characters.`],
      details: { issueType: TOO_SHORT },
    });
  }

  return findings;
}

export const metaDescriptionsCheck: AuditCheck = {
  id: 'seo.meta-descriptions',
  pillar: 'seo',
  subPillar: 'meta-descriptions',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const { pages, gaps } = buildPageInventory(snapshot);

    if (pages.length === 0) {
      const reason = gaps.missingGroups.length > 0
        ? `Rankvora AI could not read ${gaps.missingGroups.join(', ')} from this store, so meta descriptions could not be checked.`
        : 'This store has no products, collections, pages or articles to check.';
      return unavailableResult('meta-descriptions', reason);
    }

    const duplicated = findDuplicateValues(pages.map((page) => ({ id: page.id, value: effectiveDescription(page) })));

    const counts: Record<string, number> = { [MISSING]: 0, [TOO_SHORT]: 0, [TOO_LONG]: 0, [DUPLICATE]: 0, [HEALTHY]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    // Averaged over pages that HAVE a description — including zeros would report an "average
    // length" that describes no real page.
    let describedLength = 0;
    let describedCount = 0;

    for (const page of pages) {
      const description = effectiveDescription(page);
      const status = classify(description, duplicated.has(description.toLowerCase()));
      counts[status] += 1;
      if (description) {
        describedLength += description.length;
        describedCount += 1;
      }

      // Excerpted from the page's OWN body copy (or a truncation of the existing value) —
      // deterministic and store-authored, never invented. Null when the page has no usable copy.
      const suggestion = status !== HEALTHY && status !== DUPLICATE
        ? suggestDescription(description, page.bodyHtml, MIN_DESCRIPTION_LENGTH, MAX_DESCRIPTION_LENGTH)
        : null;

      rows.push({
        id: page.id,
        status,
        facet: page.facet,
        cells: {
          // This check needs the name more than any other: its `current` value is the DESCRIPTION,
          // and on a store that has set none every row's value is empty. Without the name the only
          // thing identifying a row in the fix editor is a truncated URL — so a merchant editing
          // 25 descriptions could not tell which product each box belonged to.
          name: page.title,
          url: page.url,
          path: pathOf(page.url),
          pageType: page.facet,
          description,
          length: description.length,
        },
        current: {
          label: 'Current description',
          value: description,
          meta: `${page.title} · ${description.length} characters · ${page.facet}`,
        },
        ...(suggestion ? { suggested: { label: 'Suggested description', value: suggestion, meta: `${suggestion.length} characters · excerpted from this page's own copy` } } : {}),
      });
    }

    const analyzed = pages.length;
    const healthy = counts[HEALTHY];
    const findings = buildFindings(counts, analyzed);
    const score = scoreSubPillar(analyzed, healthy, findings);
    const healthPercent = ((healthy / analyzed) * 100).toFixed(1);

    const summaryParts = [
      `${formatCount(healthy)} of ${formatCount(analyzed)} pages have a usable description.`,
    ];
    if (analyzed - healthy > 0) summaryParts.push(`${formatCount(analyzed - healthy)} need attention.`);
    if (counts[MISSING] > 0) summaryParts.push(`${formatCount(counts[MISSING])} have none at all.`);
    if (gaps.missingGroups.length > 0) summaryParts.push(`${gaps.missingGroups.join(', ')} could not be read and are excluded.`);
    if (snapshot.scope.productsTruncated) summaryParts.push(`Product scan was capped at ${formatCount(snapshot.scope.productLimit)} products.`);

    return {
      subPillar: 'meta-descriptions',
      status: 'ok',
      score,
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: summaryParts.join(' '),
        healthChip: `${healthPercent}% healthy`,
        contextLabel: 'Average length',
        // "—" rather than "0 chars" when nothing has a description: an average of no values is
        // undefined, not zero.
        contextValue: describedCount > 0 ? `${Math.round(describedLength / describedCount)} chars` : '—',
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
