import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { htmlToText } from '../shared/html.js';

/**
 * ─── Content · Duplicate & templated copy ────────────────────────────
 * Finds product descriptions that are near-copies of each other.
 *
 * ALGORITHM — MinHash-free banded shingling
 * Naive pairwise similarity is O(n²): at 10,000 products that is 50 million comparisons per
 * audit, which is not viable inside a request-scoped job. Instead:
 *
 *   1. Reduce each description to a set of word 5-grams (shingles).
 *   2. Keep only the k lowest shingle hashes per document (a "sketch" — a deterministic,
 *      order-independent sample of the document's content).
 *   3. Bucket documents by each sketch value. Only documents that COLLIDE in at least one bucket
 *      are compared properly.
 *   4. For those candidate pairs only, compute exact Jaccard similarity on the sketches.
 *
 * This is standard locality-sensitive hashing. It is approximate by construction: two documents
 * that share content but happen not to collide are missed. It is therefore a RECALL-limited
 * detector — everything it reports is genuinely similar, but it does not promise to find every
 * similar pair. The summary says so rather than implying exhaustiveness.
 *
 * The similarity figure shown in the UI is a real Jaccard coefficient over shingle sketches, not
 * an invented percentage.
 *
 * BANDS (status vocabulary matches contentTables.ts):
 *   ≥ 90% similar   Highly Templated
 *   ≥ 60% similar   Potential Duplicate
 *   otherwise       Unique
 */

const SHINGLE_SIZE = 5;
const SKETCH_SIZE = 24;
const HIGHLY_TEMPLATED_MIN = 0.9;
const POTENTIAL_DUPLICATE_MIN = 0.6;
/** Documents shorter than this have too few shingles for similarity to mean anything. */
const MIN_WORDS_FOR_COMPARISON = 20;

const UNIQUE = 'Unique';
const POTENTIAL_DUPLICATE = 'Potential Duplicate';
const HIGHLY_TEMPLATED = 'Highly Templated';

/** FNV-1a — small, fast, deterministic. No crypto strength needed for bucketing. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** The k smallest shingle hashes, ascending. Deterministic for identical input. */
function sketchOf(words: string[]): number[] {
  const hashes = new Set<number>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i += 1) {
    hashes.add(hash(words.slice(i, i + SHINGLE_SIZE).join(' ')));
  }
  return [...hashes].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

function jaccard(a: number[], b: number[]): number {
  const setB = new Set(b);
  let intersection = 0;
  for (const value of a) if (setB.has(value)) intersection += 1;
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const dupTemplatedCheck: AuditCheck = {
  id: 'content.dup-templated',
  pillar: 'content',
  subPillar: 'dup-templated',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('dup-templated', 'Rankvora AI could not read products from this store, so duplicate copy could not be checked.');
    }

    const docs = snapshot.products
      .map((product) => {
        const words = htmlToText(product.bodyHtml).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
        return { id: `product:${product.id}`, title: product.title, url: product.url, words };
      })
      .filter((doc) => doc.words.length >= MIN_WORDS_FOR_COMPARISON);

    if (docs.length < 2) {
      return unavailableResult(
        'dup-templated',
        `Fewer than two products have at least ${MIN_WORDS_FOR_COMPARISON} words of description, so there is nothing to compare.`,
      );
    }

    const sketches = docs.map((doc) => sketchOf(doc.words));

    // Bucket by individual sketch values so only plausible pairs are ever compared.
    const buckets = new Map<number, number[]>();
    sketches.forEach((sketch, index) => {
      for (const value of sketch) {
        const bucket = buckets.get(value);
        if (bucket) bucket.push(index);
        else buckets.set(value, [index]);
      }
    });

    // Best similarity found for each document, and which document it matched.
    const best = new Array(docs.length).fill(0);
    const bestMatch: Array<number | null> = new Array(docs.length).fill(null);
    const compared = new Set<string>();

    for (const bucket of buckets.values()) {
      // A shingle shared by a huge number of products is boilerplate (shipping blurb, size
      // chart) rather than a duplicate signal; comparing that whole bucket pairwise would
      // reintroduce the O(n²) cost this design exists to avoid.
      if (bucket.length < 2 || bucket.length > 50) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const a = bucket[i]!;
          const b = bucket[j]!;
          const key = `${a}:${b}`;
          if (compared.has(key)) continue;
          compared.add(key);
          const similarity = jaccard(sketches[a]!, sketches[b]!);
          if (similarity > best[a]) { best[a] = similarity; bestMatch[a] = b; }
          if (similarity > best[b]) { best[b] = similarity; bestMatch[b] = a; }
        }
      }
    }

    const counts: Record<string, number> = { [UNIQUE]: 0, [POTENTIAL_DUPLICATE]: 0, [HIGHLY_TEMPLATED]: 0 };
    const rows: SubPillarEvidenceRow[] = [];

    docs.forEach((doc, index) => {
      const similarity = best[index];
      const status = similarity >= HIGHLY_TEMPLATED_MIN ? HIGHLY_TEMPLATED
        : similarity >= POTENTIAL_DUPLICATE_MIN ? POTENTIAL_DUPLICATE
        : UNIQUE;
      counts[status] += 1;

      const matchIndex = bestMatch[index];
      rows.push({
        id: doc.id,
        status,
        facet: status,
        cells: {
          page: doc.title,
          similarity: Math.round(similarity * 100),
          pattern: matchIndex !== null ? `Closest match: ${docs[matchIndex]!.title}` : 'No close match',
          recommendation: status === UNIQUE ? '—' : 'Rewrite the shared sections so this product describes only itself.',
        },
        current: {
          label: 'Closest match',
          value: matchIndex !== null ? docs[matchIndex]!.title : 'None',
          meta: `${Math.round(similarity * 100)}% similar`,
        },
      });
    });

    const analyzed = docs.length;
    const healthy = counts[UNIQUE];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[HIGHLY_TEMPLATED] > 0) {
      findings.push({
        title: 'Product descriptions that are near-identical',
        severity: 'high',
        affectedCount: counts[HIGHLY_TEMPLATED],
        affectedLabel: 'products',
        scoreLift: lift(counts[HIGHLY_TEMPLATED]),
        resolutionType: 'content',
        problem: `${formatCount(counts[HIGHLY_TEMPLATED])} products share at least ${Math.round(HIGHLY_TEMPLATED_MIN * 100)}% of their description with another product.`,
        why: 'Interchangeable copy gives search engines no basis to prefer one page over another, so they typically index a single representative and drop the rest from results.',
        recommendation: 'Replace the shared boilerplate with copy specific to each product — what differs, and who each one is for.',
        evidence: [`${formatCount(counts[HIGHLY_TEMPLATED])} of ${formatCount(analyzed)} descriptions exceed ${Math.round(HIGHLY_TEMPLATED_MIN * 100)}% similarity to their nearest neighbour.`],
        details: { issueType: HIGHLY_TEMPLATED },
      });
    }

    if (counts[POTENTIAL_DUPLICATE] > 0) {
      findings.push({
        title: 'Product descriptions built from a shared template',
        severity: 'medium',
        affectedCount: counts[POTENTIAL_DUPLICATE],
        affectedLabel: 'products',
        scoreLift: lift(counts[POTENTIAL_DUPLICATE]),
        resolutionType: 'content',
        problem: `${formatCount(counts[POTENTIAL_DUPLICATE])} products are ${Math.round(POTENTIAL_DUPLICATE_MIN * 100)}-${Math.round(HIGHLY_TEMPLATED_MIN * 100)}% similar to another product.`,
        why: 'Heavy templating leaves only a few distinguishing words per page, which weakens each page’s ability to answer a specific query.',
        recommendation: 'Keep the template for structure, but make the substantive paragraphs unique.',
        evidence: [`${formatCount(counts[POTENTIAL_DUPLICATE])} of ${formatCount(analyzed)} descriptions fall in the templated band.`],
        details: { issueType: POTENTIAL_DUPLICATE },
      });
    }

    return {
      subPillar: 'dup-templated',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} comparable descriptions are distinct from every other product. Similarity is approximate (shingle sketches): reported matches are real, but very similar pairs can be missed. Products under ${MIN_WORDS_FOR_COMPARISON} words are excluded.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Compared',
        contextValue: `${formatCount(analyzed)} products`,
        healthyStatus: UNIQUE,
        evidenceRows: takeEvidenceSample(rows, UNIQUE),
      },
      findings,
    };
  },
};
