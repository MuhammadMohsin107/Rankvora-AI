import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawlJsonLd, CrawledPage } from '../../storefront/types.js';
import { wordCount, htmlToText } from '../shared/html.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, coveragePct, type RowStatus } from '../shared/status.js';
import { splitByPublication, unpublishedNote } from '../shared/published.js';
import { notCheckedFinding, renderedNotMeasured } from './unreadable.js';

/**
 * ─── AI Discovery · Answerable Q&A + FAQ schema ──────────────────────
 * Measures whether this store answers the questions a shopper asks BEFORE buying, in a form an
 * assistant can quote.
 *
 * ─── WHY THIS IS A SEPARATE CHECK FROM `agentic-attrs` ───────────────
 * `agentic-attrs` asks whether an agent can ACT — is there stock, can it tell the variants apart.
 * This asks whether an agent can ANSWER. They come apart constantly: a product with perfect
 * identifiers, price and availability, whose description is three lines of brand copy, is
 * flawless to transact with and useless to a shopper who asks "will this fit a 15-inch laptop?".
 * An assistant with nothing to answer that from drops the product from the recommendation rather
 * than guessing — so the failure is invisible in every other metric.
 *
 * ─── TWO HALVES, MEASURED FROM DIFFERENT SOURCES, NEITHER SUBSTITUTED ─
 *   CONTENT (Admin API)   Does the catalogue actually contain answers? Measured from real
 *                         description text: length, and whether it addresses the attributes
 *                         shoppers ask about rather than only describing the product's mood.
 *   SCHEMA  (crawl)       Does the store render FAQPage or Question JSON-LD, which is what lets a
 *                         rich result or an assistant lift an answer verbatim?
 *
 * The schema half needs rendered HTML and is reported as NOT MEASURED when no crawl ran. It is
 * never inferred from the presence of an FAQ page in the Admin data: a merchant can have a
 * beautiful FAQ page whose theme emits no structured data at all, and claiming otherwise from
 * Admin fields is exactly the fabrication storefront/types.ts exists to prevent.
 */

/** Below this a description cannot answer a qualifying question, whatever it contains. */
const MIN_ANSWER_WORDS = 40;

/**
 * The attribute families a pre-purchase question almost always falls into.
 *
 * Matched as whole words against the real description text. This is deliberately a coverage
 * signal, not a comprehension one: it reports how many of these subjects the copy touches at all.
 * It cannot tell a good answer from a bad one, and the summary says so rather than implying a
 * quality judgement the method cannot support.
 */
const ANSWER_TOPICS: Array<{ topic: string; terms: string[] }> = [
  { topic: 'materials', terms: ['material', 'materials', 'fabric', 'cotton', 'wool', 'leather', 'steel', 'aluminium', 'aluminum', 'plastic', 'wood', 'ceramic', 'silicone', 'polyester', 'linen', 'made from', 'made of'] },
  { topic: 'size or fit', terms: ['size', 'sizes', 'sizing', 'fit', 'fits', 'dimensions', 'measurements', 'length', 'width', 'height', 'depth', 'diameter', 'capacity', 'weight', 'cm', 'mm', 'inch', 'inches', 'litre', 'liter'] },
  { topic: 'care or use', terms: ['wash', 'washable', 'care', 'clean', 'cleaning', 'maintain', 'maintenance', 'dishwasher', 'machine wash', 'hand wash', 'dry', 'store', 'storage', 'instructions'] },
  { topic: 'compatibility', terms: ['compatible', 'compatibility', 'works with', 'suitable for', 'designed for', 'fits most', 'universal', 'requires', 'included', 'includes'] },
  { topic: 'warranty or origin', terms: ['warranty', 'guarantee', 'guaranteed', 'handmade', 'hand-made', 'sourced', 'origin', 'made in', 'certified', 'organic', 'vegan', 'recycled', 'sustainable'] },
];

/** Topics a description must touch before it can answer a realistic spread of questions. */
const MIN_TOPICS = 2;

/** JSON-LD types that mark genuinely answerable structured content. */
const QA_TYPES = ['faqpage', 'qapage', 'question'];

export interface Assessment {
  status: RowStatus;
  issue: string;
  detail: string;
  recommendation: string;
  topics: string[];
}

/** Which answer topics this description actually touches. */
function topicsCovered(text: string): string[] {
  const lower = text.toLowerCase();
  return ANSWER_TOPICS.filter((entry) =>
    entry.terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)),
  ).map((entry) => entry.topic);
}

export function assess(product: { bodyHtml: string }): Assessment {
  const words = wordCount(product.bodyHtml);

  if (words === 0) {
    return {
      status: CRITICAL,
      issue: 'No description to answer from',
      detail: 'Product description is empty',
      recommendation: 'Write a description. With no text at all, an assistant cannot answer a single question about this product.',
      topics: [],
    };
  }

  if (words < MIN_ANSWER_WORDS) {
    return {
      status: NEEDS_WORK,
      issue: 'Too short to answer questions',
      detail: `${words} words`,
      recommendation: `Expand past ${MIN_ANSWER_WORDS} words covering the attributes shoppers ask about before buying.`,
      topics: topicsCovered(htmlToText(product.bodyHtml)),
    };
  }

  const topics = topicsCovered(htmlToText(product.bodyHtml));
  if (topics.length < MIN_TOPICS) {
    return {
      status: NEEDS_WORK,
      issue: 'Describes the product but answers little',
      detail: topics.length === 0
        ? `${words} words, none covering materials, sizing, care, compatibility or origin`
        : `${words} words, covering only ${topics.join(' and ')}`,
      recommendation: 'Add the specifics a shopper asks before buying — what it is made of, what size it is, how to care for it, what it works with.',
      topics,
    };
  }

  return {
    status: HEALTHY,
    issue: '',
    detail: `${words} words covering ${topics.join(', ')}`,
    // Empty, not an em dash — the dash is the table's way of DISPLAYING an absent value.
    recommendation: '',
    topics,
  };
}

/** True when a block declares an FAQ/Q&A type anywhere in it, including inside @graph. */
function hasQaSchema(blocks: CrawlJsonLd[]): boolean {
  return blocks.some((block) => block.types.some((type) => QA_TYPES.includes(type.toLowerCase())));
}

/** Pages worth expecting Q&A markup on. A product page and a page whose title says FAQ. */
function qaCandidates(pages: CrawledPage[]): CrawledPage[] {
  return pages.filter(
    (page) => page.pageType === 'product' || /\b(faq|faqs|questions|help|support)\b/i.test(`${page.title ?? ''} ${page.url}`),
  );
}

export const answerableQaCheck: AuditCheck = {
  id: 'ai-discovery.answerable-qa',
  pillar: 'ai-discovery',
  subPillar: 'answerable-qa',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.products) {
      return unavailableResult('answerable-qa', 'Rankvora AI could not read products from this store, so answerable content could not be checked.');
    }

    if (snapshot.products.length === 0) {
      return unavailableResult('answerable-qa', 'This store has no products, so there is no pre-purchase content to assess.');
    }

    // Only what an assistant can read. A draft product's description is on no page anyone can reach.
    const { published: products, unpublished } = splitByPublication(snapshot.products);
    if (products.length === 0) {
      return unavailableResult(
        'answerable-qa',
        `None of this store’s ${formatCount(unpublished)} products are published to the online store, so no assistant can read a product description.`,
      );
    }

    const rows: SubPillarEvidenceRow[] = [];
    const byIssue = new Map<string, Array<{ title: string; url: string; assessment: Assessment }>>();
    let healthy = 0;
    const topicTally = new Map<string, number>();

    for (const product of products) {
      const assessment = assess(product);
      for (const topic of assessment.topics) topicTally.set(topic, (topicTally.get(topic) ?? 0) + 1);

      if (assessment.status === HEALTHY) healthy += 1;
      else {
        const bucket = byIssue.get(assessment.issue) ?? [];
        bucket.push({ title: product.title, url: product.url, assessment });
        byIssue.set(assessment.issue, bucket);
      }

      rows.push({
        id: `product:${product.id}`,
        status: assessment.status,
        facet: 'Answerable content',
        cells: {
          signal: product.title,
          detail: assessment.issue || 'Answerable',
          // NO `coverage`: one product passes or it does not, and 100/0 was that yes/no restated
          // as a percentage nobody measured.
          status: assessment.status,
          recommendation: assessment.recommendation,
        },
        current: { label: 'Detected', value: assessment.detail, meta: product.url },
        ...(assessment.recommendation ? { suggested: { label: 'Recommendation', value: assessment.recommendation } } : {}),
      });
    }

    // ── The schema half ──
    // Counted separately from the content half and only when a crawl really ran. `analyzed` below
    // includes the schema signal ONLY in that case, so a store with no crawl is scored on the
    // content it genuinely has rather than penalised for evidence Rankvora AI never collected.
    const crawl = snapshot.crawl;
    const crawlUsable = Boolean(crawl?.available) && !crawl?.passwordGated;
    let schemaAnalyzed = 0;
    let schemaHealthy = 0;
    let schemaPagesWithQa = 0;
    let schemaCandidates = 0;

    if (crawlUsable && crawl) {
      const candidates = qaCandidates(crawl.pages);
      schemaCandidates = candidates.length;
      if (candidates.length > 0) {
        schemaPagesWithQa = candidates.filter((page) => hasQaSchema(page.jsonLd)).length;
        schemaAnalyzed = 1;
        schemaHealthy = schemaPagesWithQa > 0 ? 1 : 0;

        rows.push({
          id: 'schema:faq',
          status: schemaPagesWithQa > 0 ? HEALTHY : NEEDS_WORK,
          facet: 'FAQ schema',
          cells: {
            signal: 'FAQPage / Question JSON-LD',
            detail: schemaPagesWithQa > 0
              ? `Rendered on ${formatCount(schemaPagesWithQa)} of ${formatCount(candidates.length)} crawled pages`
              : `Not rendered on any of the ${formatCount(candidates.length)} crawled pages that could carry it`,
            coverage: coveragePct(schemaPagesWithQa, candidates.length),
            status: schemaPagesWithQa > 0 ? HEALTHY : NEEDS_WORK,
            // Empty rather than an em dash: the dash is how the table DISPLAYS a missing value,
            // and writing the character here put a presentation choice inside the audit's data.
            recommendation: schemaPagesWithQa > 0
              ? ''
              : 'Add FAQPage structured data so an assistant can lift your answers verbatim instead of paraphrasing your prose.',
          },
          current: {
            label: 'Measured',
            value: schemaPagesWithQa > 0 ? `${formatCount(schemaPagesWithQa)} pages carry Q&A markup` : 'No Q&A markup found',
            meta: `rendered JSON-LD across ${formatCount(candidates.length)} crawled pages`,
          },
          ...(schemaPagesWithQa > 0
            ? {}
            : { suggested: { label: 'Recommendation', value: 'Add FAQPage or Question markup to the product and FAQ templates.' } }),
        });
      }
    } else if (crawl) {
      // Stated, not silently omitted: the merchant should know which half was measured. With NO
      // coverage figure — nothing was read, so any number here, including 0, would be invented.
      // Only when a crawl was attempted for this store; crawling switched off server-wide is said
      // in the summary alone (see agentic-attrs for why).
      const why = renderedNotMeasured(snapshot, 'page');
      rows.push({
        id: 'schema:faq',
        status: NEEDS_WORK,
        facet: 'FAQ schema',
        cells: {
          signal: 'FAQPage / Question JSON-LD',
          detail: `Not measured — ${why.detail}`,
          status: NEEDS_WORK,
          recommendation: why.recommendation,
        },
        current: { label: 'Measured', value: 'Not measured on this run', meta: why.detail },
        suggested: { label: 'Recommendation', value: why.recommendation },
      });
    }

    const analyzed = products.length + schemaAnalyzed;
    const totalHealthy = healthy + schemaHealthy;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / analyzed) * 100);
    const bucket = (issue: string) => byIssue.get(issue) ?? [];

    const empty = bucket('No description to answer from');
    if (empty.length > 0) {
      findings.push({
        title: 'Products with no description at all',
        severity: 'critical',
        affectedCount: empty.length,
        affectedLabel: 'products',
        scoreLift: lift(empty.length),
        resolutionType: 'content',
        problem: `${formatCount(empty.length)} products have a completely empty description.`,
        why: 'An assistant asked anything specific about these products has nothing whatsoever to read. It does not answer badly — it drops the product from the response, because recommending something it cannot describe is the one thing it will not do.',
        recommendation: 'Write a description for each. Cover what it is, what it is made of, what size it is, and who it is for.',
        evidence: empty.slice(0, 5).map((entry) => `${entry.title}: description is empty.`),
        evidenceRows: rows.filter((row) => row.cells.detail === 'No description to answer from').slice(0, 20),
        details: { issueType: CRITICAL },
      });
    }

    const short = bucket('Too short to answer questions');
    if (short.length > 0) {
      findings.push({
        title: 'Products too brief to answer a pre-purchase question',
        severity: 'high',
        affectedCount: short.length,
        affectedLabel: 'products',
        scoreLift: lift(short.length),
        resolutionType: 'content',
        problem: `${formatCount(short.length)} products have fewer than ${MIN_ANSWER_WORDS} words of description.`,
        why: 'Shoppers qualify before they buy — will it fit, is it waterproof, can I wash it. An assistant answers those from the description, and a few lines of brand copy contains none of it. The product survives a keyword search and disappears from every specific question.',
        recommendation: `Expand each past ${MIN_ANSWER_WORDS} words, covering materials, dimensions, care and compatibility.`,
        evidence: short.slice(0, 5).map((entry) => `${entry.title}: ${entry.assessment.detail}.`),
        evidenceRows: rows.filter((row) => row.cells.detail === 'Too short to answer questions').slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    const shallow = bucket('Describes the product but answers little');
    if (shallow.length > 0) {
      findings.push({
        title: 'Descriptions that read well but answer nothing specific',
        severity: 'medium',
        affectedCount: shallow.length,
        affectedLabel: 'products',
        scoreLift: lift(shallow.length),
        resolutionType: 'content',
        problem: `${formatCount(shallow.length)} products have a full-length description that touches fewer than ${MIN_TOPICS} of the subjects shoppers ask about.`,
        why: 'Length is not the same as substance. A long paragraph about how a product makes you feel answers no question an assistant is asked, so these products are eliminated at exactly the same point as an empty one — just less obviously.',
        recommendation: 'Add the concrete specifics alongside the brand copy: materials, measurements, care instructions, what it works with, where it is made.',
        evidence: shallow.slice(0, 5).map((entry) => `${entry.title}: ${entry.assessment.detail}.`),
        evidenceRows: rows.filter((row) => row.cells.detail === 'Describes the product but answers little').slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (schemaAnalyzed === 1 && schemaHealthy === 0) {
      findings.push({
        title: 'No FAQ structured data on any crawled page',
        severity: 'medium',
        affectedCount: schemaCandidates,
        affectedLabel: 'pages',
        scoreLift: lift(1),
        resolutionType: 'schema',
        problem: `None of the ${formatCount(schemaCandidates)} crawled product or FAQ pages render FAQPage or Question JSON-LD.`,
        why: 'Prose has to be interpreted; marked-up Q&A can be lifted verbatim. Structured answers are what a search engine turns into an expandable result and what an assistant quotes with confidence, because the question and its answer are explicitly paired rather than inferred from paragraph order.',
        recommendation: 'Add FAQPage markup to your FAQ page and Question markup to product templates that carry a Q&A block. Most Shopify themes support this through a metafield or a schema app, without a theme rewrite.',
        evidence: [`${formatCount(schemaCandidates)} crawled pages could carry Q&A markup; none does.`],
        evidenceRows: rows.filter((row) => row.id === 'schema:faq'),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (!crawlUsable && crawl) {
      const why = renderedNotMeasured(snapshot, 'page');
      findings.push(notCheckedFinding({
        title: 'FAQ markup could not be checked',
        rows: rows.filter((row) => row.id === 'schema:faq'),
        affectedLabel: 'signal',
        problem: `Rankvora AI did not read a rendered page on this run: ${why.detail}.`,
        why: 'FAQPage and Question markup exist only in the HTML the theme renders, so they can be seen on a rendered page and nowhere else. The description half of this check was measured; this half was not, and is left out of the score rather than guessed.',
        recommendation: why.recommendation,
        evidence: [`FAQ structured data: not measured — ${why.detail}.`],
      }));
    }

    const topTopics = [...topicTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    return {
      subPillar: 'answerable-qa',
      status: 'ok',
      score: scoreSubPillar(analyzed, totalHealthy, findings),
      analyzedCount: analyzed,
      healthyCount: totalHealthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(products.length)} published products carry enough real description to answer a pre-purchase question, touching at least ${MIN_TOPICS} of the subjects shoppers ask about.${topTopics.length > 0 ? ` Most covered: ${topTopics.map(([topic, count]) => `${topic} (${formatCount(count)})`).join(', ')}.` : ''} ${crawlUsable ? (schemaAnalyzed === 1 ? `FAQ structured data was measured on ${formatCount(schemaCandidates)} rendered pages.` : 'No crawled page could carry FAQ markup, so that half was not scored.') : `FAQ structured data was not measured on this run — ${renderedNotMeasured(snapshot, 'page').detail}.`} This counts whether the subjects are covered, not whether each answer is good.${unpublishedNote(unpublished)}`,
        // Whole percent: a decimal place implies a precision these counts do not carry.
        healthChip: `${coveragePct(totalHealthy, analyzed)}% healthy`,
        contextLabel: 'Products answering questions',
        contextValue: `${coveragePct(healthy, products.length)}%`,
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};
