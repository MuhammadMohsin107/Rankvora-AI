import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { EVIDENCE_ROW_LIMIT, formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { contentFingerprint, htmlToText, wordCount } from '../shared/html.js';

/**
 * ─── Content · Product & Collection descriptions ─────────────────────
 * Two checks sharing one implementation, because the question is identical for both resource
 * types: does this page carry enough of its own prose to be useful?
 *
 * WHAT IS MEASURED
 * `descriptionHtml` from the Admin API, converted to plain text and counted in words. This is the
 * merchant's authored copy — it is what the theme renders into the page body.
 *
 * THRESHOLDS are word counts, not character counts, and are deliberately modest:
 *   < 1 word    Missing     — nothing to render
 *   < 50 words  Too Short   — thin content; little for a shopper or a crawler to work with
 *   otherwise   Good
 * Plus Duplicate when the normalized text is byte-identical to another resource's.
 *
 * "50 words" is an editorial floor, not a ranking rule — Google publishes no minimum. It is set
 * where a description stops being a stub and starts answering a question. The status vocabulary
 * (Missing / Too Short / Duplicate / Good) matches the filters the Content tables already declare
 * in frontend/src/pages/pillarCatalogs/contentTables.ts, so the UI's filter chips work unchanged.
 *
 * DUPLICATE DETECTION is exact-match on a normalized fingerprint (see contentFingerprint). It
 * finds templated copy pasted across products. It does NOT do fuzzy similarity — that is the
 * `dup-templated` sub-pillar's job and needs a different algorithm.
 */

const MIN_DESCRIPTION_WORDS = 50;

const GOOD = 'Good';
const MISSING = 'Missing';
const TOO_SHORT = 'Too Short';
const DUPLICATE = 'Duplicate';

interface DescribedResource {
  id: string;
  label: string;
  url: string;
  bodyHtml: string;
  /** Facts recorded on the row without being columns of the table (see the collection check). */
  extra?: Record<string, string | number | null>;
}

function classify(words: number, isDuplicate: boolean): string {
  if (words === 0) return MISSING;
  if (isDuplicate) return DUPLICATE;
  if (words < MIN_DESCRIPTION_WORDS) return TOO_SHORT;
  return GOOD;
}

function recommendationFor(status: string): string {
  if (status === MISSING) return 'Write an original description for this page.';
  if (status === TOO_SHORT) return `Expand to at least ${MIN_DESCRIPTION_WORDS} words with specifics a buyer needs.`;
  if (status === DUPLICATE) return 'Rewrite so this page does not reuse another page’s copy verbatim.';
  return '—';
}

function issueFor(status: string, words: number): string {
  if (status === MISSING) return 'No description';
  if (status === TOO_SHORT) return `Only ${words} words`;
  if (status === DUPLICATE) return 'Identical copy used elsewhere';
  return '—';
}

function buildFindings(
  counts: Record<string, number>,
  analyzed: number,
  noun: string,
): SubPillarFindingResult[] {
  const findings: SubPillarFindingResult[] = [];
  const lift = (n: number) => Math.round((n / analyzed) * 100);

  if (counts[MISSING] > 0) {
    findings.push({
      title: `${noun}s with no description`,
      severity: 'high',
      affectedCount: counts[MISSING],
      affectedLabel: `${noun.toLowerCase()}s`,
      scoreLift: lift(counts[MISSING]),
      resolutionType: 'content',
      problem: `${formatCount(counts[MISSING])} ${noun.toLowerCase()}s have an empty description.`,
      why: 'An empty description gives a shopper no reason to buy and gives search engines almost no text to understand the page by, so it competes poorly for any query beyond its exact name.',
      recommendation: `Write an original description for each ${noun.toLowerCase()}, covering what it is, who it suits and what makes it different.`,
      evidence: [`${formatCount(counts[MISSING])} of ${formatCount(analyzed)} ${noun.toLowerCase()}s have no description text.`],
      details: { issueType: MISSING },
    });
  }

  if (counts[DUPLICATE] > 0) {
    findings.push({
      title: `${noun}s reusing another ${noun.toLowerCase()}’s description`,
      severity: 'medium',
      affectedCount: counts[DUPLICATE],
      affectedLabel: `${noun.toLowerCase()}s`,
      scoreLift: lift(counts[DUPLICATE]),
      resolutionType: 'content',
      problem: `${formatCount(counts[DUPLICATE])} ${noun.toLowerCase()}s share a description word-for-word with at least one other.`,
      why: 'Verbatim reuse means these pages carry no information that distinguishes them, so search engines commonly index one and ignore the rest.',
      recommendation: 'Give each page copy that describes only that page.',
      evidence: [
        `${formatCount(counts[DUPLICATE])} of ${formatCount(analyzed)} descriptions are byte-identical to another after normalization.`,
        'Exact-match detection — near-duplicate/templated copy is scored separately under Duplicate/templated copy.',
      ],
      details: { issueType: DUPLICATE },
    });
  }

  if (counts[TOO_SHORT] > 0) {
    findings.push({
      title: `${noun}s with thin descriptions`,
      severity: 'low',
      affectedCount: counts[TOO_SHORT],
      affectedLabel: `${noun.toLowerCase()}s`,
      scoreLift: lift(counts[TOO_SHORT]),
      resolutionType: 'content',
      problem: `${formatCount(counts[TOO_SHORT])} descriptions are under ${MIN_DESCRIPTION_WORDS} words.`,
      why: 'Very short copy usually leaves the buyer’s practical questions — sizing, materials, compatibility, delivery — unanswered, which costs conversions as well as search coverage.',
      recommendation: `Expand these past ${MIN_DESCRIPTION_WORDS} words with the details shoppers actually ask about.`,
      evidence: [`${formatCount(counts[TOO_SHORT])} of ${formatCount(analyzed)} descriptions are under ${MIN_DESCRIPTION_WORDS} words.`],
      details: { issueType: TOO_SHORT },
    });
  }

  return findings;
}

/** Shared body used by both the product and collection description checks. */
function evaluate(
  subPillar: string,
  resources: DescribedResource[],
  covered: boolean,
  noun: 'Product' | 'Collection',
  labelKey: 'product' | 'collection',
): SubPillarResult {
  if (!covered) {
    return unavailableResult(subPillar, `Rankvora AI could not read ${noun.toLowerCase()}s from this store, so descriptions could not be checked.`);
  }
  if (resources.length === 0) {
    return unavailableResult(subPillar, `This store has no ${noun.toLowerCase()}s to check.`);
  }

  const seen = new Map<string, number>();
  for (const resource of resources) {
    const fingerprint = contentFingerprint(resource.bodyHtml);
    if (!fingerprint) continue;
    seen.set(fingerprint, (seen.get(fingerprint) ?? 0) + 1);
  }

  const counts: Record<string, number> = { [MISSING]: 0, [TOO_SHORT]: 0, [DUPLICATE]: 0, [GOOD]: 0 };
  const rows: SubPillarEvidenceRow[] = [];
  let totalWords = 0;

  for (const resource of resources) {
    const words = wordCount(resource.bodyHtml);
    const fingerprint = contentFingerprint(resource.bodyHtml);
    const isDuplicate = Boolean(fingerprint) && (seen.get(fingerprint) ?? 0) > 1;
    const status = classify(words, isDuplicate);
    counts[status] += 1;
    totalWords += words;

    rows.push({
      id: resource.id,
      status,
      facet: status,
      cells: {
        [labelKey]: resource.label,
        // Trimmed preview — the full body can be kilobytes and this column renders one line.
        description: htmlToText(resource.bodyHtml).slice(0, 160),
        ...(resource.extra ?? {}),
        words,
        issue: issueFor(status, words),
        recommendation: recommendationFor(status),
      },
      current: { label: 'Current description', value: htmlToText(resource.bodyHtml).slice(0, 300), meta: `${words} words` },
    });
  }

  const analyzed = resources.length;
  const healthy = counts[GOOD];
  const findings = buildFindings(counts, analyzed, noun);
  const averageWords = Math.round(totalWords / analyzed);

  return {
    subPillar,
    status: 'ok',
    score: scoreSubPillar(analyzed, healthy, findings),
    analyzedCount: analyzed,
    healthyCount: healthy,
    details: {
      status: 'ok',
      summary: [
        `${formatCount(healthy)} of ${formatCount(analyzed)} ${noun.toLowerCase()}s have an original description of at least ${MIN_DESCRIPTION_WORDS} words.`,
        counts[MISSING] > 0 ? `${formatCount(counts[MISSING])} have none at all.` : '',
      ].filter(Boolean).join(' '),
      healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
      contextLabel: 'Average length',
      contextValue: `${averageWords} words`,
      healthyStatus: GOOD,
      evidenceRows: takeEvidenceSample(rows, GOOD),
    },
    findings,
  };
}

export const productDescriptionsCheck: AuditCheck = {
  id: 'content.product-descriptions',
  pillar: 'content',
  subPillar: 'product-descriptions',
  execute(snapshot: StoreSnapshot): SubPillarResult {
    return evaluate(
      'product-descriptions',
      snapshot.products.map((product) => ({ id: `product:${product.id}`, label: product.title, url: product.url, bodyHtml: product.bodyHtml })),
      snapshot.coverage.products,
      'Product',
      'product',
    );
  },
};

export const collectionDescriptionsCheck: AuditCheck = {
  id: 'content.collection-descriptions',
  pillar: 'content',
  subPillar: 'collection-descriptions',
  execute(snapshot: StoreSnapshot): SubPillarResult {
    return evaluate(
      'collection-descriptions',
      snapshot.collections.map((collection) => ({
        id: `collection:${collection.id}`,
        label: collection.title,
        url: collection.url,
        bodyHtml: collection.bodyHtml,
        // Not columns of this check's table: the Collections page reads them for a row's photo,
        // its "Last updated" and how many products it holds. Null when Shopify did not say.
        extra: { imageSrc: collection.image?.src ?? null, updatedAt: collection.updatedAt, productCount: collection.productCount },
      })),
      snapshot.coverage.collections,
      'Collection',
      'collection',
    );
  },
};

export { EVIDENCE_ROW_LIMIT };
