import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { onboardingState, promptChecks, promptQueries } from '../db/schema.js';
import { aiConfigured } from '../config/env.js';
import { aiProvider } from '../lib/ai/index.js';
import { ApiError } from '../middleware/error.js';

/**
 * ─── Prompt tracking · asking, and recording what came back ──────────
 * The one place a tracked question is actually put to a model, and the only writer of
 * `prompt_checks`.
 *
 * ─── EVERY ROW IT WRITES IS A REAL ANSWER ────────────────────────────
 * A call that fails writes NOTHING. That matters more than it looks: recording a failed call as
 * `mentioned: false` would quietly convert an outage, a rate limit or an expired key into evidence
 * that the store is never recommended — and it would do so invisibly, because the row would be
 * indistinguishable from a real negative. A failure is reported to the caller and leaves no trace
 * in the data.
 *
 * ─── THE QUESTION IS ASKED WITHOUT STEERING ──────────────────────────
 * The model gets the merchant's question and nothing else: no system prompt, no store name, no
 * hint that a particular shop is of interest. Mentioning the merchant in the prompt would produce
 * the mention being counted, which is the difference between a measurement and a performance.
 *
 * ─── WHAT COUNTS AS A MENTION ────────────────────────────────────────
 * The brand term appearing in the answer, matched on word boundaries so "Arc" does not match
 * "architecture". This is deliberately literal: a model-judged "did this answer really recommend
 * them?" would make the measurement depend on a second non-deterministic call, and two stacked
 * coin flips are not a better instrument than one.
 */

/** Context quoted around a mention, so the merchant sees what counted. */
const CONTEXT_CHARS = 320;

/**
 * The competitor names to look for in an answer, derived from the domains the merchant entered
 * during onboarding.
 *
 * ─── WHY DERIVED FROM A DOMAIN AND NOT INVENTED ──────────────────────
 * `onboarding_state.competitor_domains` is the only competitor data this product has, and it is
 * the merchant's own typing. A domain is not a brand name, so the registrable label is taken and
 * its separators turned into spaces: `aurora-coffee.co.uk` is looked for as "aurora coffee".
 *
 * That IS a derivation, and it is the narrowest one available: nothing is guessed from the answer
 * text, no competitor list is fetched from anywhere, and a name that does not appear literally is
 * never counted. Where the derivation is wrong — a company trading under a name unlike its
 * domain — it under-reports, which is the safe direction: a missed competitor understates the
 * merchant's competition, while an invented one would put a company in their market that is not
 * in it.
 *
 * The matched term is stored on every observation, so the merchant can always see which string
 * produced a hit rather than having to trust the derivation.
 */
async function getCompetitorTerms(storeId: number): Promise<string[]> {
  const [row] = await db
    .select({ competitorDomains: onboardingState.competitorDomains })
    .from(onboardingState)
    .where(eq(onboardingState.storeId, storeId))
    .limit(1);

  // `competitor_domains` is a json column, so the driver hands it back as `unknown`. Narrowed here
  // rather than cast: a row written by an older build could hold anything, and a bad value must
  // produce no competitor terms rather than a crash mid-sweep.
  const raw: unknown = row?.competitorDomains;
  const domains: unknown[] = Array.isArray(raw) ? raw : [];

  const terms = domains
    .filter((domain): domain is string => typeof domain === 'string')
    .map((domain) => {
      const host = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
      // The registrable label: everything before the first dot. `shop.aurora-coffee.com` keeps
      // "shop", which is why onboarding normalises to a bare hostname before storing.
      const label = host.split('.')[0] ?? '';
      return label.replace(/[-_]+/g, ' ').trim();
    })
    // Two characters cannot identify a brand and would match inside ordinary words.
    .filter((term) => term.length >= 3);

  return [...new Set(terms)];
}

/**
 * The alternative names the merchant gave their brand in guided setup ("Northstar" for "Northstar
 * Nutrition"), so an answer naming any of them counts as naming the store.
 *
 * Narrowed rather than cast, like the competitor list above: the column is json and a row written
 * by an older build could hold anything. A bad value yields no aliases, never a crash mid-sweep.
 */
async function getBrandAliases(storeId: number): Promise<string[]> {
  const [row] = await db
    .select({ brandedTerms: onboardingState.brandedTerms })
    .from(onboardingState)
    .where(eq(onboardingState.storeId, storeId))
    .limit(1);

  const raw: unknown = row?.brandedTerms;
  const terms: unknown[] = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      terms
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        // Two characters cannot identify a brand and would match inside ordinary words.
        .filter((term) => term.length >= 3),
    ),
  ];
}

export interface PromptCheckOutcome {
  queryId: number;
  query: string;
  mentioned: boolean;
  model: string;
  checkedAt: string;
  /** 1-based ordinal among tracked brands named. Null without a configured comparison set. */
  brandRank: number | null;
  brandsNamed: number | null;
}

export interface PromptSweepResult {
  checked: number;
  mentioned: number;
  /** Questions that could not be asked, with why. Never recorded as negative observations. */
  failures: Array<{ queryId: number; query: string; detail: string }>;
}

/**
 * Escapes a brand term for use inside a RegExp.
 *
 * The term is merchant-supplied free text and goes straight into a pattern. Without escaping,
 * a perfectly reasonable brand like "M+S" or "Toys (UK)" would either throw or silently match
 * something else entirely — which would be a wrong measurement rather than an error.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first character offset at which a term appears in an answer, or null.
 *
 * Word boundaries are applied only where the term starts and ends with a word character — a brand
 * written "M&S" or "+Beauty" has no boundary to anchor against, and demanding one would make it
 * unmatchable.
 */
function firstIndexOfTerm(answer: string, term: string): number | null {
  const trimmed = term.trim();
  if (!trimmed) return null;

  const escaped = escapeRegExp(trimmed);
  const leading = /^\w/.test(trimmed) ? '\\b' : '';
  const trailing = /\w$/.test(trimmed) ? '\\b' : '';
  const match = new RegExp(`${leading}${escaped}${trailing}`, 'i').exec(answer);
  return match ? match.index : null;
}

/**
 * Where the brand term appears in an answer, with surrounding context, or null.
 *
 * Kept as its own export because the mention rate is the pillar's primary measurement and several
 * tests pin its behaviour directly.
 */
export function findMention(answer: string, brandTerm: string): string | null {
  const term = brandTerm.trim();
  const index = firstIndexOfTerm(answer, term);
  if (index === null) return null;

  // Quoted verbatim from the answer, trimmed to a readable window around the hit.
  const start = Math.max(0, index - CONTEXT_CHARS / 2);
  const end = Math.min(answer.length, index + term.length + CONTEXT_CHARS / 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < answer.length ? '…' : '';
  return `${prefix}${answer.slice(start, end).trim()}${suffix}`;
}

/** One tracked brand found in an answer, and where. */
export interface NamedBrand {
  /** The exact term that matched — the merchant's own string, never one Rankvora AI invented. */
  term: string;
  /** Offset as a fraction of the answer's length, 0 (first character) to 1 (last). */
  position: number;
}

export interface AnswerPlacement {
  /** Quoted context around the store's own brand, or null when it was not named. */
  mentionContext: string | null;
  /** The store's own position, 0-1. Null when it was not named. */
  mentionPosition: number | null;
  /**
   * The store's 1-based ordinal among every tracked brand named in this answer.
   *
   * NULL WHEN NO COMPETITORS ARE CONFIGURED. "1 of 1" is not a rank, it is the absence of a
   * comparison — reporting it as a rank would show every store winning every answer it appears in,
   * which is the most flattering possible lie this feature could tell.
   */
  brandRank: number | null;
  /** How many tracked brands were named. Null for the same reason as brandRank. */
  brandsNamed: number | null;
  /** Competitors named, in the order they appear. Empty = none named; null = none configured. */
  competitorsNamed: NamedBrand[] | null;
}

/**
 * ─── Placement within one answer ─────────────────────────────────────
 *
 * Turns one model answer into the observations the ranking view is built from. Everything here is
 * READ OFF THE ANSWER — an offset, an ordering, a count. Nothing is inferred, scored or weighted.
 *
 * WHY POSITION IS A FRACTION: answers vary wildly in length, so a raw offset of 400 characters is
 * near the top of a long answer and near the bottom of a short one. The fraction is comparable
 * across samples; the offset is not.
 *
 * WHY COMPETITORS ARE ONLY EVER THE MERCHANT'S OWN TERMS: extracting brand names from free prose
 * would invent companies and attribute them to the merchant's market, and nobody — not the
 * merchant, not us — could tell which were real. So a competitor is matched exactly, by the same
 * rule the brand term is, or it is not counted at all.
 *
 * WHAT THIS IS NOT: a ranking in ChatGPT, or in any assistant. It is the store's position among
 * named brands in ONE answer to ONE question, and an assistant's answer is non-deterministic. Only
 * the distribution across many real samples means anything, which is why nothing here returns a
 * score and why the aggregate is always reported with its sample count.
 */
export function placementInAnswer(
  answer: string,
  brandTerm: string,
  competitorTerms: string[],
  brandAliases: string[] = [],
): AnswerPlacement {
  const length = answer.length;

  /**
   * The store is "named" when its brand term OR any alias the merchant gave appears. An assistant
   * writes "Northstar" for "Northstar Nutrition" all the time, and counting only the registered
   * string would under-report every one of those while looking perfectly healthy.
   *
   * ONE term is the store's hit: whichever appears FIRST in the answer. Position and the rank among
   * competitors are read off that single occurrence, so the three numbers still describe one
   * reading of one answer. Every alias is the merchant's own string — nothing is derived.
   */
  let ownTerm = brandTerm;
  let ownIndex = firstIndexOfTerm(answer, brandTerm);
  for (const alias of brandAliases) {
    const term = alias.trim();
    if (!term || term.toLowerCase() === brandTerm.trim().toLowerCase()) continue;
    const index = firstIndexOfTerm(answer, term);
    if (index !== null && (ownIndex === null || index < ownIndex)) {
      ownTerm = term;
      ownIndex = index;
    }
  }
  const mentionContext = ownIndex === null ? null : findMention(answer, ownTerm);

  // Guarded: a zero-length answer would divide by zero and produce NaN, which serialises to null
  // and renders as a blank where a position belongs.
  const toFraction = (index: number): number =>
    length > 0 ? Math.min(1, Math.max(0, index / length)) : 0;

  const configured = competitorTerms.map((term) => term.trim()).filter(Boolean);

  // No competitors configured is a DIFFERENT fact from none being named, and the two are never
  // merged: without a comparison set there is no rank to report.
  if (configured.length === 0) {
    return {
      mentionContext,
      mentionPosition: ownIndex === null ? null : toFraction(ownIndex),
      brandRank: null,
      brandsNamed: null,
      competitorsNamed: null,
    };
  }

  const competitorsNamed: NamedBrand[] = [];
  for (const term of configured) {
    const index = firstIndexOfTerm(answer, term);
    if (index !== null) competitorsNamed.push({ term, position: toFraction(index) });
  }
  competitorsNamed.sort((a, b) => a.position - b.position);

  if (ownIndex === null) {
    // Not named. There is no rank to hold — reporting "last" would assert a placement that was
    // never observed. `brandsNamed` still carries what the answer did name, which is the useful
    // half: the merchant learns who was recommended instead of them.
    return {
      mentionContext: null,
      mentionPosition: null,
      brandRank: null,
      brandsNamed: competitorsNamed.length,
      competitorsNamed,
    };
  }

  const ownPosition = toFraction(ownIndex);
  // 1-based ordinal: how many tracked brands were named ahead of this one, plus itself.
  const ahead = competitorsNamed.filter((competitor) => competitor.position < ownPosition).length;

  return {
    mentionContext,
    mentionPosition: ownPosition,
    brandRank: ahead + 1,
    brandsNamed: competitorsNamed.length + 1,
    competitorsNamed,
  };
}

/**
 * Asks one tracked question and records the answer.
 *
 * Returns null when the call failed — the caller decides what to report, and nothing is written.
 */
export async function runPromptCheck(
  storeId: number,
  query: { id: number; query: string; brandTerm: string },
  competitorTerms: string[] = [],
  brandAliases: string[] = [],
): Promise<{ ok: true; outcome: PromptCheckOutcome } | { ok: false; detail: string }> {
  if (!aiConfigured()) {
    return { ok: false, detail: 'No AI provider is configured on this Rankvora AI instance.' };
  }

  const result = await aiProvider().ask(query.query);
  if (!result.ok) {
    // Deliberately NOT written as a negative observation. See the header.
    return { ok: false, detail: `The assistant could not be reached (${result.reason}).` };
  }

  // One pass over the answer produces the mention, the position and the competitor placements
  // together, so the three can never describe different readings of the same text.
  const placement = placementInAnswer(result.text, query.brandTerm, competitorTerms, brandAliases);
  const checkedAt = new Date();

  await db.insert(promptChecks).values({
    queryId: query.id,
    storeId,
    model: result.model,
    mentioned: placement.mentionContext !== null,
    mentionContext: placement.mentionContext,
    // drizzle's `numeric` column takes and returns a string (SQLite keeps the number itself), so the
    // position is written as a fixed-precision string and read back as a number by toNumber().
    mentionPosition: placement.mentionPosition === null ? null : placement.mentionPosition.toFixed(4),
    brandRank: placement.brandRank,
    brandsNamed: placement.brandsNamed,
    competitorsNamed: placement.competitorsNamed,
    checkedAt,
  });

  return {
    ok: true,
    outcome: {
      queryId: query.id,
      query: query.query,
      mentioned: placement.mentionContext !== null,
      model: result.model,
      checkedAt: checkedAt.toISOString(),
      brandRank: placement.brandRank,
      brandsNamed: placement.brandsNamed,
    },
  };
}

/**
 * Asks every active question for a store, once each.
 *
 * Sequential rather than parallel, on purpose: this is the one feature in Rankvora AI with a real
 * per-call bill, and a burst of concurrent completions is also the shape most likely to hit a
 * provider rate limit — which would turn into a wave of failures rather than a slower sweep.
 */
export async function runPromptSweep(storeId: number): Promise<PromptSweepResult> {
  if (!aiConfigured()) {
    throw new ApiError(
      400,
      'No AI provider is configured, so no question can be asked. Set AI_PROVIDER and the matching API key.',
      'AI_NOT_CONFIGURED',
    );
  }

  const queries = await db
    .select()
    .from(promptQueries)
    .where(and(eq(promptQueries.storeId, storeId), eq(promptQueries.active, true)))
    .orderBy(promptQueries.id);

  // Read once for the whole sweep rather than per question: it is the same list for every query,
  // and a per-question read would be N identical round trips for a value that cannot change
  // mid-sweep.
  const competitorTerms = await getCompetitorTerms(storeId);
  const brandAliases = await getBrandAliases(storeId);

  const result: PromptSweepResult = { checked: 0, mentioned: 0, failures: [] };

  for (const query of queries) {
    const outcome = await runPromptCheck(storeId, query, competitorTerms, brandAliases);
    if (!outcome.ok) {
      result.failures.push({ queryId: query.id, query: query.query, detail: outcome.detail });
      continue;
    }
    result.checked += 1;
    if (outcome.outcome.mentioned) result.mentioned += 1;
  }

  return result;
}
