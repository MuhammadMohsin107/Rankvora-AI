import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { ageInDays, formatDate } from '../shared/html.js';

/**
 * ─── Content · Blog freshness ────────────────────────────────────────
 * Scores how recently each article was published or updated.
 *
 * WHAT IS MEASURED
 * `Article.updatedAt`, falling back to `publishedAt` — the most recent evidence that anyone
 * touched the piece. Age is measured against the SNAPSHOT's capturedAt, not wall-clock time, so
 * re-scoring the same snapshot always yields the same answer (the scoring engine is required to
 * be deterministic, and `new Date()` here would quietly break that).
 *
 * BANDS (status vocabulary matches contentTables.ts: Fresh / Aging / Stale):
 *   ≤ 90 days   Fresh
 *   ≤ 365 days  Aging
 *   > 365 days  Stale
 *
 * These are editorial conventions, not ranking rules. Freshness matters for content that makes
 * time-sensitive claims; an evergreen guide can be years old and perfectly good. The check
 * reports age honestly and leaves that judgement to the merchant rather than asserting decay.
 */

const FRESH_MAX_DAYS = 90;
const AGING_MAX_DAYS = 365;

const FRESH = 'Fresh';
const AGING = 'Aging';
const STALE = 'Stale';

export const blogFreshnessCheck: AuditCheck = {
  id: 'content.blog-freshness',
  pillar: 'content',
  subPillar: 'blog-freshness',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    if (!snapshot.coverage.articles) {
      return unavailableResult('blog-freshness', 'Rankvora AI could not read blog articles from this store, so freshness could not be checked.');
    }
    // A store with no blog is NOT a store with a stale blog. Scoring it 100 would imply an
    // excellent blog; scoring it 0 would punish a deliberate choice. Neither is true.
    if (snapshot.articles.length === 0) {
      return unavailableResult('blog-freshness', 'This store has no blog articles, so there is nothing to measure. Publishing articles will enable this check.');
    }

    const now = snapshot.capturedAt;
    const counts: Record<string, number> = { [FRESH]: 0, [AGING]: 0, [STALE]: 0 };
    const rows: SubPillarEvidenceRow[] = [];
    let oldest = 0;

    for (const article of snapshot.articles) {
      const effective = article.updatedAt ?? article.publishedAt;
      const age = ageInDays(effective, now);
      // An article with no usable date is treated as Stale rather than skipped: an unknown age
      // is a content-hygiene problem in its own right, and silently dropping it would shrink the
      // denominator and inflate the score.
      const status = age === null || age > AGING_MAX_DAYS ? STALE : age <= FRESH_MAX_DAYS ? FRESH : AGING;
      counts[status] += 1;
      if (age !== null && age > oldest) oldest = age;

      rows.push({
        id: `article:${article.id}`,
        status,
        facet: status,
        cells: {
          article: article.title,
          // The article's raw dates and featured image, not columns of this check's table: the Blog
          // articles page sorts and shows them ("Last updated", photo). Null when Shopify did not say.
          publishedAt: article.publishedAt,
          updatedAt: article.updatedAt,
          imageSrc: article.image?.src ?? null,
          published: formatDate(article.publishedAt),
          updated: formatDate(article.updatedAt),
          age: age ?? 0,
          recommendation:
            status === STALE ? 'Review and refresh, or retire this article.'
            : status === AGING ? 'Revisit within the next quarter.'
            : '—',
        },
        current: { label: 'Last touched', value: formatDate(effective), meta: age === null ? 'unknown age' : `${age} days ago` },
      });
    }

    const analyzed = snapshot.articles.length;
    const healthy = counts[FRESH];
    const findings: SubPillarFindingResult[] = [];
    const lift = (n: number) => Math.round((n / analyzed) * 100);

    if (counts[STALE] > 0) {
      findings.push({
        title: 'Articles not updated in over a year',
        severity: 'medium',
        affectedCount: counts[STALE],
        affectedLabel: 'articles',
        scoreLift: lift(counts[STALE]),
        resolutionType: 'content',
        problem: `${formatCount(counts[STALE])} articles have not been touched in more than ${AGING_MAX_DAYS} days.`,
        why: 'Old posts can carry prices, stock claims or policies that are no longer true, which erodes trust when a shopper lands on one from search.',
        recommendation: 'Review each for accuracy — refresh what is still useful, and retire or redirect what is not.',
        evidence: [
          `${formatCount(counts[STALE])} of ${formatCount(analyzed)} articles exceed ${AGING_MAX_DAYS} days since their last update.`,
          `Oldest article: ${oldest} days.`,
        ],
        details: { issueType: STALE },
      });
    }

    if (counts[AGING] > 0) {
      findings.push({
        title: 'Articles approaching a year old',
        severity: 'low',
        affectedCount: counts[AGING],
        affectedLabel: 'articles',
        scoreLift: lift(counts[AGING]),
        resolutionType: 'content',
        problem: `${formatCount(counts[AGING])} articles were last updated between ${FRESH_MAX_DAYS} and ${AGING_MAX_DAYS} days ago.`,
        why: 'These are not yet a problem, but they are the pipeline of next year’s stale content.',
        recommendation: 'Schedule a light review so they do not drift into being outdated.',
        evidence: [`${formatCount(counts[AGING])} of ${formatCount(analyzed)} articles are ${FRESH_MAX_DAYS}-${AGING_MAX_DAYS} days old.`],
        details: { issueType: AGING },
      });
    }

    return {
      subPillar: 'blog-freshness',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} articles were updated within the last ${FRESH_MAX_DAYS} days.`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Oldest article',
        contextValue: `${oldest} days`,
        healthyStatus: FRESH,
        evidenceRows: takeEvidenceSample(rows, FRESH),
      },
      findings,
    };
  },
};
