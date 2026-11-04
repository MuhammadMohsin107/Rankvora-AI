import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { StoreSnapshot } from '../../store-data/types.js';
import { htmlToText, wordCount } from '../shared/html.js';
import { CRITICAL, HEALTHY, NEEDS_WORK, type RowStatus } from '../shared/status.js';

/**
 * ─── CRO · Returns flow ──────────────────────────────────────────────
 * Reads the store's real refund policy through `read_content` and measures whether it answers the
 * questions a shopper asks BEFORE buying. A returns policy that exists but does not say how long
 * you have, who pays postage, or how to start a return does not remove the hesitation it is there
 * to remove — so presence alone is not the measurement.
 *
 * THE UNIT IS THE SIGNAL, NOT THE POLICY. A store has exactly one refund policy, and scoring
 * "1 of 1 policies" would produce a binary 0 or 100 that says nothing actionable. The CRO evidence
 * table is built for this shape — its columns are `surface / signal / coverage / status /
 * recommendation` (croTables.ts) — so each row here is one question the policy should answer.
 *
 * WHAT THIS CANNOT SEE
 * The rendered storefront. Whether the policy is actually LINKED from the product page, cart or
 * footer needs the theme's rendered HTML, which requires the storefront crawl Rankvora AI does not
 * have yet. This check reads the policy Shopify holds, and says so in its summary rather than
 * implying it verified the shopper's path to it.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE. Each signal is matched against the policy's plain text
 * with wide alternatives; a policy that says the same thing in unusual wording can be missed. A
 * missed signal understates the score, which is the safe direction to be wrong in — the opposite
 * (claiming a policy answers something it does not) would send a merchant into a conversion
 * problem believing it was already solved.
 */

/** Below this the policy is a stub — a heading and a sentence, not an answer. Shopify's own
 * generated refund template runs to roughly 200 words. */
const SUBSTANTIVE_MIN_WORDS = 60;

interface Signal {
  key: string;
  label: string;
  question: string;
  /** Matched against the policy's plain text, lower-cased. */
  test: RegExp;
  /** A missing signal of this weight caps the sub-pillar score — see scoring.ts. */
  severity: 'high' | 'medium';
  recommendation: string;
}

const SIGNALS: Signal[] = [
  {
    key: 'window',
    label: 'Return window',
    question: 'How long does a shopper have to return an item?',
    // "30 days", "within 14 days", "one month", "2 weeks"
    test: /\b(\d{1,3}|one|two|three|four|six|fourteen|thirty|ninety)[\s-]*(calendar\s+|business\s+|working\s+)?(day|days|week|weeks|month|months)\b/,
    severity: 'high',
    recommendation: 'State the return window in days, e.g. "Return within 30 days of delivery."',
  },
  {
    key: 'shipping-cost',
    label: 'Return postage',
    question: 'Who pays to send the item back?',
    test: /\b(return\s+(shipping|postage|label|freight)|shipping\s+(cost|costs|fee|fees|charge|charges)|postage\s+(paid|cost|costs)|free\s+returns|prepaid\s+label|at\s+your\s+own\s+(cost|expense))\b/,
    severity: 'high',
    recommendation: 'Say plainly whether you or the customer pays return postage, and mention a prepaid label if you provide one.',
  },
  {
    key: 'how-to-start',
    label: 'How to start a return',
    question: 'What does the shopper actually do first?',
    test: /\b(contact\s+us|email\s+us|get\s+in\s+touch|reach\s+out|return\s+(request|portal|form|authoriz|authoris)|rma|customer\s+(service|support)|@[a-z0-9.-]+\.[a-z]{2,})\b/,
    severity: 'high',
    recommendation: 'Give one concrete first step — an email address, a contact form, or a returns portal link.',
  },
  {
    key: 'refund-timing',
    label: 'Refund timing',
    question: 'When does the money actually come back?',
    test: /\b(refund(ed)?\s+(within|in|after)|(\d{1,2}[\s-]*\d{0,2}\s*)?(business|working)\s+days|once\s+(we|the\s+item)\s+(receive|have\s+received|is\s+received)|original\s+(payment|method))\b/,
    severity: 'medium',
    recommendation: 'Tell shoppers how long a refund takes and that it returns to their original payment method.',
  },
  {
    key: 'exclusions',
    label: 'What cannot be returned',
    question: 'Which items are excluded, and in what condition?',
    test: /\b(cannot\s+be\s+returned|non[\s-]?returnable|not\s+eligible|excluded|exclusions|final\s+sale|unworn|unused|original\s+(packaging|condition|tags)|sale\s+items)\b/,
    severity: 'medium',
    recommendation: 'List exclusions and the condition items must be in, so returns are not refused after the fact.',
  },
];

export const returnsCheck: AuditCheck = {
  id: 'cro.returns',
  pillar: 'cro',
  subPillar: 'returns',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    // A denied scope is named explicitly rather than reported as a generic failure: it is the
    // likeliest cause, the merchant can fix it in one action, and "we could not read your
    // policies" would leave them with nothing to do about it.
    if (!snapshot.policyAccess.available) {
      return unavailableResult(
        'returns',
        snapshot.policyAccess.reason === 'scope'
          ? 'Reading your shop policies needs the read_legal_policies permission, which Rankvora AI has not been granted for this store. Shopify moved policies behind this scope, so stores connected earlier do not have it. Reconnect the store (the app will ask you to re-approve) and re-run the audit.'
          : `Rankvora AI could not read this store's policies, so the returns flow could not be checked (${snapshot.policyAccess.detail}).`,
      );
    }

    // The provider lower-cases ShopPolicyType, so REFUND_POLICY arrives as refund_policy.
    const policy = snapshot.policies.find((entry) => entry.type === 'refund_policy');
    const text = policy ? htmlToText(policy.body).toLowerCase() : '';
    const words = policy ? wordCount(policy.body) : 0;
    const published = Boolean(policy?.url);

    const rows: SubPillarEvidenceRow[] = [];
    const findings: SubPillarFindingResult[] = [];

    // ── No policy at all ──
    // Measured, not unavailable: Shopify answered, and the answer is that no refund policy exists.
    // That is the single most damaging state this sub-pillar can be in, so it is reported as a
    // real finding with a real (zero) score rather than hidden behind "not measured".
    if (!policy) {
      for (const signal of SIGNALS) {
        rows.push({
          id: `returns:${signal.key}`,
          status: CRITICAL,
          facet: CRITICAL,
          cells: {
            surface: signal.label,
            signal: signal.question,
            coverage: 0,
            status: CRITICAL,
            recommendation: signal.recommendation,
          },
          current: { label: 'Detected', value: 'No refund policy published' },
          suggested: { label: 'Recommendation', value: signal.recommendation },
        });
      }

      findings.push({
        title: 'No refund policy published',
        severity: 'critical',
        affectedCount: 1,
        affectedLabel: 'store',
        // Every signal row above is unanswered, so the finding covers all of what was analyzed.
        scoreLift: Math.round((rows.length / SIGNALS.length) * 100),
        resolutionType: 'content',
        problem: 'This store has no refund policy in Shopify.',
        why: 'A shopper deciding whether to buy from a store they do not know looks for the returns policy first. With nothing to find, the safe choice is to not buy — and Shopify links a policy page from checkout whether or not one has been written.',
        recommendation: 'Publish a refund policy in Settings → Policies. Shopify can generate a starting template you then edit to match how you actually handle returns.',
        evidence: ['No policy of type refund_policy exists on this store.'],
        evidenceRows: rows,
        details: { issueType: CRITICAL },
      });

      return {
        subPillar: 'returns',
        status: 'ok',
        score: scoreSubPillar(SIGNALS.length, 0, findings),
        analyzedCount: SIGNALS.length,
        healthyCount: 0,
        details: {
          status: 'ok',
          summary: 'No refund policy is published on this store, so none of the questions a shopper asks before buying are answered.',
          healthChip: '0.0% healthy',
          contextLabel: 'Refund policy',
          contextValue: 'Not published',
          evidenceRows: rows,
        },
        findings,
      };
    }

    // ── Policy exists: measure what it actually answers ──
    const substantive = words >= SUBSTANTIVE_MIN_WORDS;
    const missing: Signal[] = [];

    for (const signal of SIGNALS) {
      const present = signal.test.test(text);
      if (!present) missing.push(signal);
      const status: RowStatus = present ? HEALTHY : signal.severity === 'high' ? CRITICAL : NEEDS_WORK;

      rows.push({
        id: `returns:${signal.key}`,
        status,
        facet: status,
        cells: {
          surface: signal.label,
          signal: signal.question,
          coverage: present ? 100 : 0,
          status,
          recommendation: present ? '—' : signal.recommendation,
        },
        current: {
          label: 'Detected',
          value: present ? 'Answered in the policy' : 'Not found in the policy',
          meta: policy.title || 'Refund policy',
        },
        suggested: { label: 'Recommendation', value: present ? 'No change needed.' : signal.recommendation },
      });
    }

    const healthy = SIGNALS.length - missing.length;
    const missingHigh = missing.filter((signal) => signal.severity === 'high');
    const missingMedium = missing.filter((signal) => signal.severity === 'medium');

    if (!substantive) {
      findings.push({
        title: 'Refund policy is too thin to answer a shopper\'s questions',
        severity: 'high',
        affectedCount: 1,
        affectedLabel: 'policy',
        // No signal row is unhealthy because of length alone — the missing answers are their own
        // findings below — so this covers none of the analyzed signals. It was a typed-in 40.
        scoreLift: 0,
        resolutionType: 'content',
        problem: `The refund policy is ${words} words long.`,
        why: 'A policy this short cannot cover the window, the postage and the process. Shoppers who cannot find the answer assume the answer is unfavourable.',
        recommendation: `Expand the policy past ${SUBSTANTIVE_MIN_WORDS} words, covering the return window, who pays return postage, and the first step to start a return.`,
        evidence: [`Refund policy is ${words} words.`, `Substantive policies are at least ${SUBSTANTIVE_MIN_WORDS} words.`],
        details: { issueType: NEEDS_WORK },
      });
    }

    if (missingHigh.length > 0) {
      findings.push({
        title: 'Refund policy leaves the main purchase questions unanswered',
        severity: 'high',
        affectedCount: missingHigh.length,
        affectedLabel: 'signals',
        scoreLift: Math.round((missingHigh.length / SIGNALS.length) * 100),
        resolutionType: 'content',
        problem: `The policy does not state: ${missingHigh.map((signal) => signal.label.toLowerCase()).join(', ')}.`,
        why: 'These are the three things a hesitant shopper checks before entering card details. Each one left unanswered is a reason to leave the cart and not come back.',
        recommendation: missingHigh.map((signal) => signal.recommendation).join(' '),
        evidence: missingHigh.map((signal) => `${signal.label}: not found in the policy text.`),
        evidenceRows: rows.filter((row) => row.status === CRITICAL),
        details: { issueType: CRITICAL },
      });
    }

    if (missingMedium.length > 0) {
      findings.push({
        title: 'Refund policy omits refund timing or exclusions',
        severity: 'medium',
        affectedCount: missingMedium.length,
        affectedLabel: 'signals',
        scoreLift: Math.round((missingMedium.length / SIGNALS.length) * 100),
        resolutionType: 'content',
        problem: `The policy does not state: ${missingMedium.map((signal) => signal.label.toLowerCase()).join(', ')}.`,
        why: 'These do not usually stop the first purchase, but they are what turn a return into a support ticket or a chargeback once one happens.',
        recommendation: missingMedium.map((signal) => signal.recommendation).join(' '),
        evidence: missingMedium.map((signal) => `${signal.label}: not found in the policy text.`),
        details: { issueType: NEEDS_WORK },
      });
    }

    if (!published) {
      findings.push({
        title: 'Refund policy has no public URL',
        severity: 'medium',
        affectedCount: 1,
        affectedLabel: 'policy',
        // Covers none of the analyzed signals (a missing URL does not un-answer one). It was a
        // typed-in 20.
        scoreLift: 0,
        resolutionType: 'content',
        problem: 'Shopify returned this policy without a public URL.',
        why: 'A policy with no address cannot be linked from a product page, an email or an ad — only checkout will surface it, which is after the decision has already been made.',
        recommendation: 'Re-save the policy in Settings → Policies so Shopify publishes it to a public URL.',
        evidence: ['Shopify returned no url for the refund policy.'],
        details: { issueType: NEEDS_WORK },
      });
    }

    return {
      subPillar: 'returns',
      status: 'ok',
      score: scoreSubPillar(SIGNALS.length, healthy, findings),
      analyzedCount: SIGNALS.length,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `The refund policy answers ${healthy} of ${SIGNALS.length} questions a shopper asks before buying (${words} words). This reads the policy Shopify holds — whether your theme links it from the product page needs the storefront crawl, which Rankvora AI does not run yet.`,
        healthChip: `${((healthy / SIGNALS.length) * 100).toFixed(1)}% healthy`,
        contextLabel: 'Policy length',
        contextValue: `${words} words`,
        evidenceRows: rows,
      },
      findings,
    };
  },
};
