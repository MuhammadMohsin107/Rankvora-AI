import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { suggestTitle } from '../shared/recommend.js';
import {
  buildPageInventory,
  findDuplicateValues,
  formatCount,
  pathOf,
  takeEvidenceSample,
  type InventoryPage,
} from './page-inventory.js';

/**
 * ─── SEO · Title Tags ────────────────────────────────────────────────
 * Scores the title tag of every indexable page (products, collections, pages, articles).
 *
 * WHAT IS ACTUALLY MEASURED
 * The storefront's rendered <title> is not readable through the Admin API, so this check scores
 * the value that determines it: Shopify's SEO title override when set, and otherwise the
 * resource's own title, which is what a stock theme falls back to. That fallback is why a null
 * override is NOT reported as "missing" — the page still renders a title.
 *
 * LENGTH THRESHOLDS (30-60 characters) are an SEO readability heuristic, not a Google ranking
 * rule: Google truncates the displayed title at roughly 600px, so very long titles get cut off in
 * the snippet and very short ones waste the space. The same two constants are used by the
 * frontend's bulk-fix validator (BulkFixWorkflow.tsx) so the audit and the editor never disagree
 * about what "acceptable" means.
 */

/** Keep in step with MIN_TITLE_LENGTH / MAX_TITLE_LENGTH in
 * frontend/src/components/seo/subpillar/BulkFixWorkflow.tsx. */
const MIN_TITLE_LENGTH = 30;
const MAX_TITLE_LENGTH = 60;

const HEALTHY = 'Healthy';
const MISSING = 'Missing';
const TOO_SHORT = 'Too Short';
const TOO_LONG = 'Too Long';
const DUPLICATE = 'Duplicate';

/** The value Shopify holds for this page: the override if set, else the resource title. */
function effectiveTitle(page: InventoryPage): string {
  const override = page.seoTitle?.trim();
  if (override) return override;
  return page.title.trim();
}

/**
 * ─── The theme's title suffix ────────────────────────────────────────
 *
 * Most Shopify themes render `<title>` as the page's title followed by the shop name — "Krasa
 * Charcoal Facewash – Deep Clean, Clear & Oil-Free Skin – My Nutrition Store". Those trailing
 * characters count against the same truncation budget as the merchant's own words, so scoring the
 * Shopify field alone under-reports every page on the store by the length of the suffix. A title
 * measured at 59 characters and called healthy can be 80 on the rendered page and get cut off.
 *
 * IT IS MEASURED, NEVER ASSUMED. Nothing here knows the shop's name, the separator, or whether
 * the theme appends anything at all — some do not, and some prepend instead. The suffix is
 * recovered by comparing what the crawl actually LOADED against what the Admin API holds for the
 * same resource, and it is only believed when several independent pages agree on the same string.
 * Without a crawl, or without agreement, there is no suffix and the check scores exactly as it
 * did before.
 *
 * This is the one thing this check reads from rendered output, and it respects the rule in
 * storefront/types.ts: the rendered value is read from the crawl, never inferred from Admin data.
 */
const SUFFIX_MIN_OBSERVATIONS = 3;

export interface TitleSuffix {
  /** The literal trailing text, separator included, e.g. " – My Nutrition Store". */
  value: string;
  /** How many crawled pages showed it. */
  observedOn: number;
  /** How many crawled pages could be compared against Admin data at all. */
  comparedPages: number;
}

function deriveTitleSuffix(snapshot: StoreSnapshot, pages: InventoryPage[]): TitleSuffix | null {
  const crawl = snapshot.crawl;
  if (!crawl?.available || crawl.pages.length === 0) return null;

  // Keyed on the bare Admin id: crawl targets carry `resource.id` while the inventory prefixes it
  // with the resource type. Shopify ids are globally unique, so the bare id is the safe join.
  const adminTitleById = new Map<string, string>();
  for (const page of pages) {
    const separator = page.id.indexOf(':');
    adminTitleById.set(separator > 0 ? page.id.slice(separator + 1) : page.id, effectiveTitle(page));
  }

  const counts = new Map<string, number>();
  let comparedPages = 0;

  for (const crawled of crawl.pages) {
    if (!crawled.resourceId || !crawled.title) continue;
    const adminTitle = adminTitleById.get(crawled.resourceId);
    if (!adminTitle) continue;

    comparedPages += 1;

    // extractTitle() already decoded entities and collapsed whitespace, so a theme's "&ndash;"
    // and the Admin API's "–" compare equal here without this check re-implementing either.
    const rendered = crawled.title.trim();
    if (!rendered.startsWith(adminTitle) || rendered.length <= adminTitle.length) continue;

    const suffix = rendered.slice(adminTitle.length);
    if (!suffix.trim()) continue;
    counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  }

  let best: TitleSuffix | null = null;
  for (const [value, observedOn] of counts) {
    if (!best || observedOn > best.observedOn) best = { value, observedOn, comparedPages };
  }

  // Enough pages, and a majority of the ones we could compare. A suffix seen on two pages out of
  // twenty is a coincidence in two titles, not a theme template.
  if (!best || best.observedOn < SUFFIX_MIN_OBSERVATIONS || best.observedOn * 2 <= comparedPages) return null;
  return best;
}

/**
 * Classifies on the RENDERED length — the merchant's field plus whatever the theme appends —
 * because that is the string a search engine truncates. `title` is still what decides MISSING: a
 * page with no title of its own has no title, whatever the theme adds after it.
 */
function classify(title: string, renderedLength: number, isDuplicate: boolean): string {
  if (!title) return MISSING;
  // Duplication outranks length: two pages competing for the same query is a worse problem than
  // a title being a few characters off, and the merchant should see that first.
  if (isDuplicate) return DUPLICATE;
  if (renderedLength < MIN_TITLE_LENGTH) return TOO_SHORT;
  if (renderedLength > MAX_TITLE_LENGTH) return TOO_LONG;
  return HEALTHY;
}

function buildFindings(counts: Record<string, number>, analyzed: number): SubPillarFindingResult[] {
  const findings: SubPillarFindingResult[] = [];

  if (counts[MISSING] > 0) {
    findings.push({
      title: 'Pages with no title tag',
      severity: 'critical',
      affectedCount: counts[MISSING],
      affectedLabel: 'pages',
      // scoreLift is the points this sub-pillar would regain if every affected page were fixed.
      // Derived from the real ratio, never a guessed constant.
      scoreLift: Math.round((counts[MISSING] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[MISSING])} pages render with no title text at all.`,
      why: 'A page with no title gives search engines nothing to display or rank. Browsers and search results fall back to the bare URL, which almost never earns a click.',
      recommendation: 'Give every affected page a descriptive title of 30-60 characters that names the product or topic.',
      evidence: [`${formatCount(counts[MISSING])} of ${formatCount(analyzed)} pages have an empty title.`],
      details: { issueType: MISSING },
    });
  }

  if (counts[DUPLICATE] > 0) {
    findings.push({
      title: 'Duplicate title tags',
      severity: 'high',
      affectedCount: counts[DUPLICATE],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[DUPLICATE] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[DUPLICATE])} pages share a title with at least one other page.`,
      why: 'When several pages carry the same title, search engines cannot tell them apart and typically pick one to show while suppressing the rest, so the others lose their own visibility.',
      recommendation: 'Make each title unique — add the variant, category or model that distinguishes the page from its siblings.',
      evidence: [`${formatCount(counts[DUPLICATE])} of ${formatCount(analyzed)} pages use a non-unique title.`],
      details: { issueType: DUPLICATE },
    });
  }

  if (counts[TOO_LONG] > 0) {
    findings.push({
      title: 'Title tags over the display limit',
      severity: 'medium',
      affectedCount: counts[TOO_LONG],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[TOO_LONG] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[TOO_LONG])} titles are longer than ${MAX_TITLE_LENGTH} characters.`,
      why: `Search results truncate long titles, so the end of the title — often the part that distinguishes the page — is replaced with an ellipsis and never read.`,
      recommendation: `Trim these titles to ${MAX_TITLE_LENGTH} characters or fewer, keeping the most distinctive words first.`,
      evidence: [`${formatCount(counts[TOO_LONG])} of ${formatCount(analyzed)} titles exceed ${MAX_TITLE_LENGTH} characters.`],
      details: { issueType: TOO_LONG },
    });
  }

  if (counts[TOO_SHORT] > 0) {
    findings.push({
      title: 'Title tags under the recommended length',
      severity: 'low',
      affectedCount: counts[TOO_SHORT],
      affectedLabel: 'pages',
      scoreLift: Math.round((counts[TOO_SHORT] / analyzed) * 100),
      resolutionType: 'content',
      problem: `${formatCount(counts[TOO_SHORT])} titles are shorter than ${MIN_TITLE_LENGTH} characters.`,
      why: 'A very short title leaves most of the available space in the search snippet unused and usually omits the terms a shopper would actually search for.',
      recommendation: `Expand these to at least ${MIN_TITLE_LENGTH} characters by adding the category, key attribute or brand.`,
      evidence: [`${formatCount(counts[TOO_SHORT])} of ${formatCount(analyzed)} titles are under ${MIN_TITLE_LENGTH} characters.`],
      details: { issueType: TOO_SHORT },
    });
  }

  return findings;
}

export const titleTagsCheck: AuditCheck = {
  id: 'seo.title-tags',
  pillar: 'seo',
  subPillar: 'title-tags',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const { pages, gaps } = buildPageInventory(snapshot);

    // Nothing readable at all -> 'unavailable', never a zero. A zero here would claim we looked
    // and found every page broken, which is the opposite of what happened.
    if (pages.length === 0) {
      const reason = gaps.missingGroups.length > 0
        ? `Rankvora AI could not read ${gaps.missingGroups.join(', ')} from this store, so titles could not be checked.`
        : 'This store has no products, collections, pages or articles to check.';
      return unavailableResult('title-tags', reason);
    }

    const duplicated = findDuplicateValues(pages.map((page) => ({ id: page.id, value: effectiveTitle(page) })));

    const titleSuffix = deriveTitleSuffix(snapshot, pages);
    const suffixLength = titleSuffix?.value.length ?? 0;
    // What the merchant's own field may run to once the theme has appended its suffix. Every
    // target in this check is derived from it, so the audit and the fix editor aim at the same
    // rendered result rather than one of them quietly working to the pre-suffix number.
    const fieldMaxLength = Math.max(1, MAX_TITLE_LENGTH - suffixLength);

    const counts: Record<string, number> = { [MISSING]: 0, [TOO_SHORT]: 0, [TOO_LONG]: 0, [DUPLICATE]: 0, [HEALTHY]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let totalLength = 0;

    for (const page of pages) {
      const title = effectiveTitle(page);
      // A page with no title of its own renders no title for the suffix to follow, so it is not
      // credited with the suffix's characters.
      const renderedLength = title ? title.length + suffixLength : 0;
      const status = classify(title, renderedLength, duplicated.has(title.toLowerCase()));
      counts[status] += 1;
      totalLength += renderedLength;

      // Deterministic recommendation from the page's own text — null (omitted) when no rule
      // can produce a defensible value, e.g. duplicates. See checks/shared/recommend.ts.
      // Trimmed to the FIELD budget, so the suggested value still renders within the limit once
      // the theme has appended its suffix.
      const suggestion = status === TOO_LONG || status === TOO_SHORT
        ? suggestTitle(title, fieldMaxLength)
        : null;

      rows.push({
        id: page.id,
        status,
        facet: page.facet,
        cells: {
          // The resource's OWN name, which is what identifies the row. Deliberately separate from
          // `title` below: that is the VALUE being judged and rewritten, this is the thing being
          // changed. They read the same on a store that sets no SEO overrides, and diverge the
          // moment one is set — at which point a table showing only the override cannot say which
          // product it belongs to.
          name: page.title,
          url: page.url,
          path: pathOf(page.url),
          pageType: page.facet,
          title,
          // The rendered length, because that is what the status was decided on and what a search
          // engine truncates. Showing the field length beside a "Too Long" verdict derived from a
          // different number is how this table used to contradict itself.
          length: renderedLength,
        },
        current: {
          label: 'Current title',
          value: title,
          meta: suffixLength > 0
            ? `${renderedLength} characters as rendered (${title.length} in Shopify + ${suffixLength} added by your theme) · ${page.facet}`
            : `${renderedLength} characters · ${page.facet}`,
        },
        ...(suggestion ? { suggested: { label: 'Suggested title', value: suggestion, meta: `${suggestion.length} characters` } } : {}),
      });
    }

    const analyzed = pages.length;
    const healthy = counts[HEALTHY];
    const findings = buildFindings(counts, analyzed);
    const score = scoreSubPillar(analyzed, healthy, findings);
    const averageLength = Math.round(totalLength / analyzed);
    const healthPercent = ((healthy / analyzed) * 100).toFixed(1);

    const summaryParts = [
      `${formatCount(healthy)} of ${formatCount(analyzed)} pages have a title in the ${MIN_TITLE_LENGTH}-${MAX_TITLE_LENGTH} character range.`,
    ];
    if (analyzed - healthy > 0) summaryParts.push(`${formatCount(analyzed - healthy)} need attention.`);
    if (counts[MISSING] > 0) summaryParts.push(`${formatCount(counts[MISSING])} have no title at all.`);
    // Stated outright: the lengths above are not the numbers in Shopify, and a merchant comparing
    // the two needs to know why before they conclude the audit is wrong.
    if (titleSuffix) {
      summaryParts.push(
        `Your theme appends "${titleSuffix.value}" (${suffixLength} characters) to every page title — `
        + `seen on ${titleSuffix.observedOn} of ${titleSuffix.comparedPages} pages Rankvora AI loaded — `
        + `so lengths here are measured as rendered and your Shopify field has ${fieldMaxLength} characters to work with.`,
      );
    }
    // Be explicit when part of the store was unreadable, so the numbers are never mistaken for
    // a full-store result.
    if (gaps.missingGroups.length > 0) summaryParts.push(`${gaps.missingGroups.join(', ')} could not be read and are excluded.`);
    if (snapshot.scope.productsTruncated) summaryParts.push(`Product scan was capped at ${formatCount(snapshot.scope.productLimit)} products.`);

    return {
      subPillar: 'title-tags',
      status: 'ok',
      score,
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: summaryParts.join(' '),
        healthChip: `${healthPercent}% healthy`,
        contextLabel: 'Average length',
        contextValue: `${averageLength} chars`,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
        // Persisted so everything that later WRITES a title aims at the same rendered result the
        // audit scored: the AI fix planner tightens its length rule by this, and the bulk-fix
        // editor validates against it. Null when no suffix was observed, which leaves every one
        // of those paths on the plain 30-60 range exactly as before.
        titleSuffix,
      },
      findings,
    };
  },
};
