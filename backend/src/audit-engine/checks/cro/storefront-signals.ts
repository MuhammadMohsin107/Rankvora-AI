import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import type { CrawledPage } from '../../storefront/types.js';
import { crawlScopeNote, pageLabel, requireCrawl } from '../shared/crawl.js';
import { formatCount, takeEvidenceSample } from '../seo/page-inventory.js';
import { CRITICAL, HEALTHY, NEEDS_WORK } from '../shared/status.js';

/**
 * ─── CRO · Rendered storefront signals ───────────────────────────────
 * Three checks that ask the same shape of question — "is this element actually on the page?" —
 * and so share one detection engine rather than three near-identical files.
 *
 *   trust     review widgets, trust badges, policy links, contact details
 *   wishlist  a save-for-later control
 *   locator   a store-finder page or widget
 *
 * DETECTION IS EVIDENCE-BASED AND CONSERVATIVE.
 * Each signal is a set of markers looked for in the page's own rendered text, its link targets,
 * and its script hosts. A signal is reported PRESENT only when a marker is actually found. It is
 * never inferred from the Admin API: a Shopify policy record proves a policy exists, not that the
 * theme links to it; an installed app proves an app is installed, not that its widget renders.
 *
 * ABSENCE IS REPORTED AS ABSENCE OF EVIDENCE, and the wording says so. A wishlist implemented by
 * an app whose markup gives no recognisable marker would be missed, and the finding is phrased so
 * a merchant who has one is told what Rankvora AI looked for rather than told they do not have it.
 */

interface SignalDefinition {
  key: string;
  label: string;
  /** Lower-cased substrings looked for in the page's visible text. */
  text?: RegExp;
  /** Matched against internal link paths. */
  linkPath?: RegExp;
  /** Matched against third-party script hosts and script URLs. */
  script?: RegExp;
  /** Matched against class/id-ish markers in the raw text of anchors and headings. */
  anchorText?: RegExp;
}

/** Trust is scored per PAGE: each page should carry evidence a shopper can act on. */
const TRUST_SIGNALS: SignalDefinition[] = [
  {
    key: 'policy-links',
    label: 'Policy links',
    linkPath: /\/policies\/|\/pages\/(refund|return|shipping|privacy|terms)/i,
  },
  {
    key: 'reviews',
    label: 'Reviews',
    text: /\b(customer reviews?|verified (buyer|purchase)|based on \d+ reviews?|write a review|star rating)\b/i,
    script: /(judge\.me|yotpo|okendo|stamped\.io|loox|reviews\.io|trustpilot|shopper approved|feefo)/i,
  },
  {
    key: 'contact',
    label: 'Contact route',
    linkPath: /\/pages\/contact|\/pages\/support|\/pages\/help/i,
    text: /\b(contact us|customer service|email us|call us|live chat|whatsapp)\b/i,
  },
  {
    key: 'guarantee',
    label: 'Guarantee or secure-checkout signal',
    text: /\b(money[- ]back guarantee|secure (checkout|payment)|satisfaction guarantee|ssl secured|free returns|\d+[- ]day (returns?|guarantee))\b/i,
  },
];

const WISHLIST_SIGNALS: SignalDefinition[] = [
  {
    key: 'wishlist',
    label: 'Wishlist control',
    text: /\b(add to wishlist|save for later|add to favou?rites|my wishlist|wish list)\b/i,
    linkPath: /\/pages\/wishlist|\/apps\/wishlist/i,
    script: /(wishlistking|swymrelay|swym|growave|smartwishlist|wishlist(hero|plus)|appikon)/i,
  },
];

const LOCATOR_SIGNALS: SignalDefinition[] = [
  {
    key: 'locator',
    label: 'Store locator',
    text: /\b(store locator|find (a|our) store|our stores|find us in store|stockists?|where to buy|nearest store)\b/i,
    linkPath: /\/pages\/(store-locator|stores|stockists|find-a-store|locations?)|\/apps\/store-locator/i,
    script: /(storemapper|stockist|storerocket|bold-?locations|mapbox|maps\.googleapis\.com)/i,
  },
];

/** Returns the concrete evidence found for one signal on one page, or null. */
function detect(page: CrawledPage, signal: SignalDefinition): string | null {
  if (signal.text && signal.text.test(page.text)) {
    const match = signal.text.exec(page.text);
    return `page text contains "${match?.[0]?.slice(0, 50) ?? 'a matching phrase'}"`;
  }
  if (signal.linkPath) {
    const link = page.links.find((entry) => {
      try {
        return entry.internal && signal.linkPath!.test(new URL(entry.url).pathname);
      } catch {
        return false;
      }
    });
    if (link) return `links to ${new URL(link.url).pathname}`;
  }
  if (signal.script) {
    const script = page.scripts.find((entry) => signal.script!.test(entry.src ?? '') || signal.script!.test(entry.host ?? ''));
    if (script) return `loads ${script.host ?? 'a matching script'}`;
  }
  if (signal.anchorText) {
    const anchor = page.links.find((entry) => signal.anchorText!.test(entry.text));
    if (anchor) return `link labelled "${anchor.text.slice(0, 40)}"`;
  }
  return null;
}

// ─── Trust ───────────────────────────────────────────────────────────

export const trustCheck: AuditCheck = {
  id: 'cro.trust',
  pillar: 'cro',
  subPillar: 'trust',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const guard = requireCrawl(snapshot, 'trust', 'the trust signals your pages render');
    if (!guard.ok) return guard.result;
    const { crawl, pages } = guard.evidence;

    const rows: SubPillarEvidenceRow[] = [];
    const missingBySignal = new Map<string, number>();
    let healthy = 0;

    for (const page of pages) {
      const found = TRUST_SIGNALS.map((signal) => ({ signal, evidence: detect(page, signal) }));
      const present = found.filter((entry) => entry.evidence !== null);
      const absent = found.filter((entry) => entry.evidence === null);
      for (const entry of absent) missingBySignal.set(entry.signal.label, (missingBySignal.get(entry.signal.label) ?? 0) + 1);

      // A page carrying most of the signals is healthy; demanding all four would mark down a
      // perfectly reasonable product page for not repeating the contact route.
      const isHealthy = present.length >= 3;
      if (isHealthy) healthy += 1;
      const status = present.length === 0 ? CRITICAL : isHealthy ? HEALTHY : NEEDS_WORK;

      rows.push({
        id: `page:${page.pageType}:${page.resourceId ?? 'home'}`,
        status,
        facet: status,
        cells: {
          surface: pageLabel(page),
          signal: present.map((entry) => entry.signal.label).join(', ') || 'None found',
          coverage: Math.round((present.length / TRUST_SIGNALS.length) * 100),
          status,
          recommendation: isHealthy ? '—' : `Add ${absent.map((entry) => entry.signal.label.toLowerCase()).join(', ')} to this page.`,
        },
        current: {
          label: 'Found on the page',
          value: present.map((entry) => `${entry.signal.label} (${entry.evidence})`).join(' · ') || 'No trust signal detected',
          meta: page.finalUrl,
        },
        suggested: { label: 'Recommendation', value: isHealthy ? 'No change needed.' : `Missing: ${absent.map((entry) => entry.signal.label).join(', ')}.` },
      });
    }

    const analyzed = pages.length;
    const findings: SubPillarFindingResult[] = [];

    const worstSignal = [...missingBySignal.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worstSignal && worstSignal[1] > 0) {
      const [label, count] = worstSignal;
      findings.push({
        title: `${label} missing from most pages`,
        severity: count >= analyzed ? 'high' : 'medium',
        affectedCount: count,
        affectedLabel: 'pages',
        scoreLift: Math.round((count / analyzed) * 100),
        resolutionType: 'theme',
        problem: `${formatCount(count)} of the ${formatCount(analyzed)} pages loaded show no ${label.toLowerCase()}.`,
        why: 'A shopper deciding whether to trust an unfamiliar store looks for reviews, a returns policy and a way to reach a human. Each one they cannot find is a reason to leave, and these are checked on the rendered page rather than in your Shopify settings — a policy that exists but is not linked cannot reassure anyone.',
        recommendation: `Surface ${label.toLowerCase()} in the theme — the footer is the usual place for policy and contact links, and the product template for reviews.`,
        evidence: [`Rankvora AI looked for ${TRUST_SIGNALS.map((signal) => signal.label.toLowerCase()).join(', ')} on each page it loaded.`, `${label}: absent on ${formatCount(count)} of ${formatCount(analyzed)} pages.`],
        evidenceRows: rows.filter((row) => row.status !== HEALTHY).slice(0, 20),
        details: { issueType: NEEDS_WORK },
      });
    }

    return {
      subPillar: 'trust',
      status: 'ok',
      score: scoreSubPillar(analyzed, healthy, findings),
      analyzedCount: analyzed,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(analyzed)} pages carry at least three of the four trust signals Rankvora AI looks for. Detection is based on what the page renders; a trust element built in a way Rankvora AI does not recognise would not be counted. ${crawlScopeNote(crawl)}`,
        healthChip: `${((healthy / analyzed) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Signals checked',
        contextValue: TRUST_SIGNALS.map((signal) => signal.label).join(', '),
        evidenceRows: takeEvidenceSample(rows, HEALTHY),
      },
      findings,
    };
  },
};

// ─── Presence checks (wishlist, locator) ─────────────────────────────

/**
 * Builds a check that answers "does the storefront have this feature anywhere?".
 *
 * The unit is the STORE, not the page: a store locator belongs on one page, and scoring every
 * product page for not containing one would be measuring the wrong thing entirely.
 */
function presenceCheck(config: {
  id: string;
  subPillar: string;
  signals: SignalDefinition[];
  feature: string;
  subject: string;
  why: string;
  recommendation: string;
}): AuditCheck {
  return {
    id: config.id,
    pillar: 'cro',
    subPillar: config.subPillar,

    execute(snapshot: StoreSnapshot): SubPillarResult {
      const guard = requireCrawl(snapshot, config.subPillar, config.subject);
      if (!guard.ok) return guard.result;
      const { crawl, pages } = guard.evidence;

      const hits: Array<{ page: CrawledPage; evidence: string }> = [];
      for (const page of pages) {
        for (const signal of config.signals) {
          const evidence = detect(page, signal);
          if (evidence) { hits.push({ page, evidence }); break; }
        }
      }

      const found = hits.length > 0;
      // The unit is the store (see above): one thing analyzed, healthy when the feature was found.
      const analyzed = 1;
      const healthy = found ? 1 : 0;
      const rows: SubPillarEvidenceRow[] = found
        ? hits.slice(0, 20).map(({ page, evidence }) => ({
            id: `page:${page.pageType}:${page.resourceId ?? 'home'}`,
            status: HEALTHY,
            facet: HEALTHY,
            cells: { surface: pageLabel(page), signal: `${config.feature} detected`, coverage: 100, status: HEALTHY, recommendation: '—' },
            current: { label: 'Evidence', value: evidence, meta: page.finalUrl },
          }))
        : [{
            id: `store:${config.subPillar}`,
            status: NEEDS_WORK,
            facet: NEEDS_WORK,
            cells: {
              surface: 'Storefront',
              signal: `No ${config.feature} found on any page Rankvora AI loaded`,
              coverage: 0,
              status: NEEDS_WORK,
              recommendation: config.recommendation,
            },
            current: { label: 'Searched', value: `${pages.length} pages, no ${config.feature} detected`, meta: crawl.origin },
            suggested: { label: 'Recommendation', value: config.recommendation },
          }];

      const findings: SubPillarFindingResult[] = found ? [] : [{
        title: `No ${config.feature} found on the storefront`,
        // An absent optional feature is an opportunity, not a defect — a store may deliberately
        // not offer one, and a 'high' severity would put it in the red for a valid choice.
        severity: 'low',
        affectedCount: 1,
        affectedLabel: 'storefront',
        // The share of what this sub-pillar analyzes that the finding covers — here, all of it.
        scoreLift: Math.round(((analyzed - healthy) / analyzed) * 100),
        resolutionType: 'integration',
        problem: `Rankvora AI loaded ${formatCount(pages.length)} pages and found no ${config.feature}.`,
        why: config.why,
        recommendation: config.recommendation,
        evidence: [
          `Searched ${formatCount(pages.length)} rendered pages for on-page wording, links and known app scripts.`,
          `If you do offer this through an app Rankvora AI does not recognise, it would not be detected — this reports what was found on the page, not what is installed in your admin.`,
        ],
        details: { issueType: NEEDS_WORK },
      }];

      return {
        subPillar: config.subPillar,
        status: 'ok',
        score: scoreSubPillar(analyzed, healthy, findings),
        analyzedCount: analyzed,
        healthyCount: healthy,
        details: {
          status: 'ok',
          summary: found
            ? `A ${config.feature} was found on ${formatCount(hits.length)} of the ${formatCount(pages.length)} pages Rankvora AI loaded. ${crawlScopeNote(crawl)}`
            : `No ${config.feature} was found on any of the ${formatCount(pages.length)} pages Rankvora AI loaded. This reports rendered evidence only — an implementation Rankvora AI does not recognise would not be detected. ${crawlScopeNote(crawl)}`,
          healthChip: found ? '100.0% healthy' : '0.0% healthy',
          contextLabel: config.feature,
          contextValue: found ? 'Detected' : 'Not detected',
          evidenceRows: rows,
        },
        findings,
      };
    },
  };
}

export const wishlistCheck = presenceCheck({
  id: 'cro.wishlist',
  subPillar: 'wishlist',
  signals: WISHLIST_SIGNALS,
  feature: 'wishlist or save-for-later control',
  subject: 'whether your storefront offers a wishlist',
  why: 'A shopper who is interested but not ready to buy either saves the item or forgets it. Without a save-for-later control the only way back is remembering the store name, which most people do not.',
  recommendation: 'Add a wishlist through a Shopify app or your theme, and surface it on the product page and in the header.',
});

export const locatorCheck = presenceCheck({
  id: 'cro.locator',
  subPillar: 'locator',
  signals: LOCATOR_SIGNALS,
  feature: 'store locator or stockist page',
  subject: 'whether your storefront offers a store locator',
  why: 'Shoppers who want to see an item in person, or buy from a nearby stockist, need somewhere that lists locations. Without one that demand goes to a competitor who publishes theirs.',
  recommendation: 'Add a store locator page listing your locations or stockists, and link it from the main navigation. If you sell online only, this is safe to ignore.',
});

// ─── COD ─────────────────────────────────────────────────────────────

/**
 * Cash on delivery cannot be established from anything Rankvora AI can legitimately see.
 *
 * The payment methods a shopper is offered are decided inside Shopify Checkout, which is a
 * separate, authenticated surface that no audit crawls. What a storefront page mentions about
 * payment is marketing copy, not configuration — and `read_payment_methods` is not a scope
 * Rankvora AI requests. So this reports NOT MEASURED, always, rather than guessing from page text.
 * Inferring "COD available" from the words "cash on delivery" appearing in a footer would be a
 * fabrication with real consequences for a merchant who then relies on it.
 */
export const codCheck: AuditCheck = {
  id: 'cro.cod',
  pillar: 'cro',
  subPillar: 'cod',

  execute(): SubPillarResult {
    return unavailableResult(
      'cod',
      'Payment methods are configured inside Shopify Checkout, which Rankvora AI does not have permission to inspect. Rankvora AI will not infer cash-on-delivery availability from wording on your pages, because page copy is not proof of what checkout actually offers. This needs a Shopify payments permission Rankvora AI does not currently request.',
    );
  },
};

/**
 * Mobile behaviour needs a real browser at a real viewport — layout shift, tap-target size and
 * responsive breakpoints are properties of a rendered layout, not of HTML. Rankvora AI fetches HTML;
 * it does not render. Reporting a mobile score from markup alone would be inventing a
 * measurement, so this stays honestly unmeasured until a Lab service exists.
 */
export const mobileUxCheck: AuditCheck = {
  id: 'cro.mobile-ux',
  pillar: 'cro',
  subPillar: 'mobile-ux',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const hasViewport = snapshot.crawl?.pages.some((page) => page.textLength > 0) ?? false;
    return unavailableResult(
      'mobile-ux',
      hasViewport
        ? 'Mobile experience is measured by loading your pages in a real browser at a phone viewport and observing layout, tap targets and shift. Rankvora AI reads your HTML but does not render it, so this cannot be measured yet — and a score guessed from markup would not reflect what a shopper on a phone actually sees.'
        : 'Mobile experience needs your pages rendered in a real browser at a phone viewport, which Rankvora AI cannot do yet.',
    );
  },
};
