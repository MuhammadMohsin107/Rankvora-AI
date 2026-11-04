import type { AuditCheck, SubPillarEvidenceRow, SubPillarFindingResult, SubPillarResult } from '../../types.js';
import { unavailableResult } from '../../types.js';
import { scoreSubPillar } from '../../scoring.js';
import type { SnapshotPromptQuery, StoreSnapshot } from '../../store-data/types.js';
import { formatCount } from '../seo/page-inventory.js';
import { HEALTHY, NEEDS_WORK, CRITICAL, coveragePct, type RowStatus } from '../shared/status.js';

/**
 * ─── AI Discovery · Prompt tracking ──────────────────────────────────
 * Reports how often AI assistants actually named this store when asked the merchant's own
 * questions.
 *
 * ─── THE HONESTY PROBLEM THIS CHECK IS BUILT AROUND ──────────────────
 * An LLM's answer is NOT DETERMINISTIC. Ask "best waterproof dog coat uk" twice and you can get
 * two different shortlists. So a single observation is not a ranking, not a position, and not a
 * score — it is one sample of a distribution. Every design decision below follows from that:
 *
 *   · A RATE, NEVER A RANK. The evidence says "mentioned in 4 of 10 checks", because that is what
 *     was measured. There is no "position 3" anywhere in this check, because no such number was
 *     ever observed.
 *   · A MINIMUM SAMPLE. Below MIN_SAMPLES a query is reported as "still gathering" and EXCLUDED
 *     from the score. One miss out of one check is not evidence of an invisibility problem, and
 *     scoring it as 0% would put a store in the red on the strength of a coin flip.
 *   · NEVER CHECKED IS NOT ZERO. A query added ten minutes ago has no observations. That is a
 *     different fact from "asked repeatedly and never mentioned", and the two are never merged.
 *
 * ─── WHAT IS AND IS NOT MEASURED ─────────────────────────────────────
 * This measures what the CONFIGURED model says when asked directly, with no system prompt
 * steering it toward the merchant. It does not measure ChatGPT's consumer product, which retrieves
 * live web results this check has no access to. The summary says so rather than letting a merchant
 * read these numbers as their ChatGPT ranking.
 *
 * Every row here is a real API call that really happened, recorded at the moment it happened by
 * services/prompt-tracking.service.ts. Nothing is interpolated, back-filled or seeded.
 */

/**
 * Observations required before a query's mention rate is scored.
 *
 * Five is the point at which a rate stops being dominated by one run: with four misses and one
 * mention it reports 20%, which is a defensible statement about a real pattern. At two samples the
 * same data would swing between 0% and 50% and mean nothing.
 */
export const MIN_SAMPLES = 5;

/**
 * A query mentioned this often or more is doing its job.
 *
 * Exported and sent to the client with every prompt-tracking response, so the Settings list and the
 * trend panel colour a rate by THIS number rather than a copy of it — the two used to retype 0.4 and
 * 0.1 by hand, and a change here would have left them grading the same rate differently.
 */
export const HEALTHY_RATE = 0.4;

/** Below this, across enough samples, the store is effectively absent for that question. */
export const CRITICAL_RATE = 0.1;

interface Assessment {
  status: RowStatus;
  detail: string;
  recommendation: string;
  rate: number | null;
  samples: number;
  mentions: number;
  /** Excluded from scoring — too few samples to say anything, or never checked. */
  provisional: boolean;
}

function assess(query: SnapshotPromptQuery): Assessment {
  const samples = query.observations.length;
  const mentions = query.observations.filter((observation) => observation.mentioned).length;

  if (samples === 0) {
    return {
      status: NEEDS_WORK,
      detail: 'Not checked yet',
      // Not "the next scheduled run": scheduled analysis is a per-store setting that may be off,
      // and then no run is scheduled at all. What is always true is stated instead.
      recommendation: 'This question has not been asked yet. Every audit asks it once, or press Check all now in Settings → AI Discovery to ask it straight away.',
      rate: null,
      samples: 0,
      mentions: 0,
      provisional: true,
    };
  }

  if (samples < MIN_SAMPLES) {
    return {
      status: NEEDS_WORK,
      detail: `Mentioned in ${mentions} of ${samples} checks so far — too few to report a rate`,
      recommendation: `Still gathering. A mention rate needs at least ${MIN_SAMPLES} checks before it describes a pattern rather than chance.`,
      rate: null,
      samples,
      mentions,
      provisional: true,
    };
  }

  const rate = mentions / samples;
  if (rate >= HEALTHY_RATE) {
    return {
      status: HEALTHY,
      detail: `Mentioned in ${mentions} of ${samples} checks (${Math.round(rate * 100)}%)`,
      // Empty, not an em dash — the dash is the table's way of DISPLAYING an absent value.
      recommendation: '',
      rate,
      samples,
      mentions,
      provisional: false,
    };
  }

  if (rate <= CRITICAL_RATE) {
    return {
      status: CRITICAL,
      detail: `Mentioned in ${mentions} of ${samples} checks (${Math.round(rate * 100)}%)`,
      recommendation: 'The assistant almost never names you for this question. Being absent from the answer is not a ranking problem — there is nothing to rank.',
      rate,
      samples,
      mentions,
      provisional: false,
    };
  }

  return {
    status: NEEDS_WORK,
    detail: `Mentioned in ${mentions} of ${samples} checks (${Math.round(rate * 100)}%)`,
    recommendation: 'You appear sometimes. Strengthening the product content and structured attributes behind this question is what moves an occasional mention toward a consistent one.',
    rate,
    samples,
    mentions,
    provisional: false,
  };
}

export const promptTrackingCheck: AuditCheck = {
  id: 'ai-discovery.prompt-tracking',
  pillar: 'ai-discovery',
  subPillar: 'prompt-tracking',

  execute(snapshot: StoreSnapshot): SubPillarResult {
    const settings = snapshot.aiDiscovery;
    if (!settings) {
      return unavailableResult(
        'prompt-tracking',
        'Rankvora AI could not read this store’s AI Discovery settings, so prompt tracking could not be reported.',
      );
    }

    // No model configured means no check can ever have run. Reporting 0% here would be a
    // measurement of the operator's deployment presented as a fact about the merchant's store.
    if (!settings.aiConfigured) {
      return unavailableResult(
        'prompt-tracking',
        'No AI provider is configured on this Rankvora AI instance, so no assistant can be asked about your store. Prompt tracking reports nothing rather than an invented result.',
      );
    }

    const tracked = settings.promptQueries.filter((query) => query.active);
    if (tracked.length === 0) {
      return unavailableResult(
        'prompt-tracking',
        'No questions are being tracked for this store. Add the questions your shoppers actually ask in Settings → AI Discovery — Rankvora AI will not invent them, because a made-up question would measure Rankvora AI’s guess rather than your visibility.',
      );
    }

    const assessments = tracked.map((query) => ({ query, assessment: assess(query) }));
    const scored = assessments.filter((entry) => !entry.assessment.provisional);

    const rows: SubPillarEvidenceRow[] = assessments.map((entry) => {
      const latest = entry.query.observations[0];
      return {
        id: `query:${entry.query.id}`,
        status: entry.assessment.status,
        facet: entry.assessment.status,
        cells: {
          signal: entry.query.query,
          detail: entry.assessment.detail,
          // The mention rate, only where one exists. A question never asked, or asked fewer than
          // MIN_SAMPLES times, has NO rate — writing 0 there reported "never mentioned" for a
          // question nobody had put to the model yet.
          ...(entry.assessment.rate !== null ? { coverage: Math.round(entry.assessment.rate * 100) } : {}),
          status: entry.assessment.status,
          recommendation: entry.assessment.recommendation,
        },
        current: {
          label: 'Observed',
          value: entry.assessment.detail,
          meta: latest
            ? `looking for "${entry.query.brandTerm}" · last asked ${new Date(latest.checkedAt).toISOString().slice(0, 10)} via ${latest.model}`
            : `looking for "${entry.query.brandTerm}" · never asked`,
        },
        ...(entry.assessment.recommendation ? { suggested: { label: 'Recommendation', value: entry.assessment.recommendation } } : {}),
        // The quoted sentence from the most recent answer that DID name the store, so a merchant
        // can see exactly what counted rather than trusting a boolean.
        note: entry.query.observations.find((observation) => observation.mentioned)?.mentionContext ?? undefined,
      };
    });

    // Every query still gathering: measured nothing yet, and says so instead of scoring zero.
    if (scored.length === 0) {
      const waiting = assessments.filter((entry) => entry.assessment.samples > 0).length;
      return {
        ...unavailableResult(
          'prompt-tracking',
          `${formatCount(tracked.length)} questions are tracked, but none has reached ${MIN_SAMPLES} checks yet${waiting > 0 ? ` (${formatCount(waiting)} ${waiting === 1 ? 'has' : 'have'} started)` : ''}. A mention rate below that is chance, not a pattern, so nothing is scored yet.`,
        ),
        // The rows ARE real observations and are worth showing even while the score is withheld.
        details: {
          status: 'unavailable',
          unavailableReason: `${formatCount(tracked.length)} questions are tracked, but none has reached ${MIN_SAMPLES} checks yet. A mention rate below that is chance, not a pattern, so nothing is scored yet.`,
          summary: `${formatCount(tracked.length)} questions tracked. Results appear once each has been asked at least ${MIN_SAMPLES} times.`,
          healthChip: 'Gathering',
          contextLabel: 'Questions tracked',
          contextValue: formatCount(tracked.length),
          evidenceRows: rows,
        },
      };
    }

    const healthy = scored.filter((entry) => entry.assessment.status === HEALTHY).length;
    const findings: SubPillarFindingResult[] = [];
    const lift = (count: number) => Math.round((count / scored.length) * 100);

    const absent = scored.filter((entry) => entry.assessment.status === CRITICAL);
    if (absent.length > 0) {
      findings.push({
        title: 'Questions where the assistant almost never names you',
        severity: 'high',
        affectedCount: absent.length,
        affectedLabel: absent.length === 1 ? 'question' : 'questions',
        scoreLift: lift(absent.length),
        resolutionType: 'content',
        problem: `${formatCount(absent.length)} tracked ${absent.length === 1 ? 'question returns' : 'questions return'} an answer naming this store in ${Math.round(CRITICAL_RATE * 100)}% or fewer of checks.`,
        why: 'When an assistant answers a buying question it names a handful of merchants. Being absent from that shortlist is not being ranked low — there is no list position to improve, because the store is not in the answer at all. The stores that are named are the ones the model has enough specific, structured information about to be confident recommending.',
        recommendation: 'Work on what the assistant reads: complete product descriptions that answer the qualifying questions, real structured attributes (brand, category, identifiers), and content that addresses this exact question directly. The agentic-attributes and answerable-Q&A checks list the specific gaps.',
        evidence: absent.map((entry) => `"${entry.query.query}": mentioned in ${entry.assessment.mentions} of ${entry.assessment.samples} checks.`),
        evidenceRows: rows.filter((row) => absent.some((entry) => row.id === `query:${entry.query.id}`)),
        details: { issueType: CRITICAL },
      });
    }

    const occasional = scored.filter((entry) => entry.assessment.status === NEEDS_WORK);
    if (occasional.length > 0) {
      findings.push({
        title: 'Questions where you are named only sometimes',
        severity: 'medium',
        affectedCount: occasional.length,
        affectedLabel: 'questions',
        scoreLift: lift(occasional.length),
        resolutionType: 'content',
        problem: `${formatCount(occasional.length)} tracked questions name this store in some checks but not most.`,
        why: 'An intermittent mention means the model knows the store exists but does not reliably consider it the right answer. That is a better position than absence and a worse one than a consistent recommendation — and it is the band where improving the underlying content moves the rate fastest.',
        recommendation: 'Strengthen the specific product content behind these questions. Intermittent mentions usually reflect thin descriptions or missing attributes rather than absence from the model’s knowledge.',
        evidence: occasional.map((entry) => `"${entry.query.query}": mentioned in ${entry.assessment.mentions} of ${entry.assessment.samples} checks.`),
        evidenceRows: rows.filter((row) => occasional.some((entry) => row.id === `query:${entry.query.id}`)),
        details: { issueType: NEEDS_WORK },
      });
    }

    // Questions still below the sample floor sit in the table as NEEDS_WORK — the vocabulary's only
    // word for "not settled" — so they get a finding that owns them and says what that means. It
    // never moves the score: they are excluded from it until they have a rate.
    const gathering = assessments.filter((entry) => entry.assessment.provisional);
    if (gathering.length > 0) {
      findings.push({
        title: gathering.length === 1 ? 'One question is still gathering answers' : 'Questions still gathering answers',
        severity: 'low',
        affectedCount: gathering.length,
        affectedLabel: gathering.length === 1 ? 'question' : 'questions',
        scoreLift: 0,
        resolutionType: 'settings',
        problem: `${formatCount(gathering.length)} tracked ${gathering.length === 1 ? 'question has' : 'questions have'} fewer than ${MIN_SAMPLES} recorded answers, so no mention rate is reported for ${gathering.length === 1 ? 'it' : 'them'} yet.`,
        why: 'An assistant’s answer varies between runs, so a rate from one or two answers is chance, not a pattern. These questions are left out of the score until they have enough real answers.',
        recommendation: 'Nothing to fix. Every audit asks each question once; press Check all now in Settings → AI Discovery to add answers sooner.',
        evidence: gathering.map((entry) => `"${entry.query.query}": ${entry.assessment.detail}.`),
        evidenceRows: rows.filter((row) => gathering.some((entry) => row.id === `query:${entry.query.id}`)),
        details: { issueType: NEEDS_WORK, notChecked: true },
      });
    }

    const provisional = gathering.length;
    const totalSamples = assessments.reduce((sum, entry) => sum + entry.assessment.samples, 0);
    const totalMentions = assessments.reduce((sum, entry) => sum + entry.assessment.mentions, 0);

    return {
      subPillar: 'prompt-tracking',
      status: 'ok',
      score: scoreSubPillar(scored.length, healthy, findings),
      analyzedCount: scored.length,
      healthyCount: healthy,
      details: {
        status: 'ok',
        summary: `${formatCount(healthy)} of ${formatCount(scored.length)} tracked questions name this store in at least ${Math.round(HEALTHY_RATE * 100)}% of checks, across ${formatCount(totalSamples)} real assistant answers.${provisional > 0 ? ` ${formatCount(provisional)} more ${provisional === 1 ? 'question is' : 'questions are'} still gathering and ${provisional === 1 ? 'is' : 'are'} not scored.` : ''} These are rates, not rankings: an assistant’s answer varies between runs, and this measures the model Rankvora AI is configured with rather than ChatGPT’s consumer product, which retrieves live web results.`,
        // Whole percent: a decimal place implies a precision these counts do not carry.
        healthChip: `${coveragePct(healthy, scored.length)}% healthy`,
        contextLabel: 'Answers recorded',
        contextValue: `${formatCount(totalMentions)} of ${formatCount(totalSamples)} named you`,
        evidenceRows: rows,
      },
      findings,
    };
  },
};
