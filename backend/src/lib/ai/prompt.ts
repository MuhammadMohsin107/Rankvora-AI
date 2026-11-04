import { businessContextLines } from './businessContext.js';
import type { AiRecommendation, FixPlanContext, RecommendationContext } from './provider.js';

/**
 * ─── Prompts and validation, shared by every provider ────────────────
 *
 * Moved out of openai.provider.ts when a second vendor arrived. What a model is TOLD and what it
 * is ALLOWED TO RETURN are properties of Rankvora AI, not of whoever serves the request: a
 * recommendation must read the same and be held to the same rules whether OpenAI or Gemini wrote
 * it. Leaving a copy in each provider would let the two drift into giving different advice for
 * the same finding, and only one of them would ever get fixed.
 *
 * Only TRANSPORT belongs in a provider file — the endpoint, the auth header, the response shape.
 */

/** Bounds the response, which bounds cost. Four short prose fields need far less than this. */
export const MAX_OUTPUT_TOKENS = 600;


export const SYSTEM_PROMPT = `You are Rankvora AI's e-commerce optimization assistant. Rankvora AI audits Shopify stores across SEO, Content, Speed, CRO and AI Discovery, and has ALREADY detected the issue described in the user message and ALREADY produced a deterministic recommendation.

Your only job is to rewrite that recommendation so a busy merchant can act on it. You are an editor, not an investigator.

Rules you must not break:
- Use ONLY the audit context supplied. It is the complete set of facts available to you.
- Never invent numbers, percentages, rankings, traffic, revenue, conversion rates, Core Web Vitals, or any measurement that is not in the context.
- Never claim to have inspected the store, called an API, run a test, or read anything yourself.
- Never state or imply that any change has been made. Nothing has been applied; you are advising.
- Never reference Google Search Console, Google Analytics, Merchant Center, or any tool Rankvora AI did not supply data from.
- Do not contradict the deterministic recommendation. Clarify, sharpen and make it concrete.
- If the context is too thin to say something specific, say plainly that more data is needed rather than guessing.
- Plain prose only. No HTML, no markdown, no code, no links, no scripts.
- Be concise: each field is 1-3 sentences.

confidence reflects how well the supplied context supports a specific recommendation: "high" when the context is precise and the action is unambiguous, "low" when you had to stay generic.`;

/** Strips anything that could be rendered as markup, then bounds length. Defence in depth: the
 * prompt forbids markup, but the model is not a trust boundary. */
export function sanitize(value: unknown, max = 1200): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function validateRecommendation(parsed: unknown): AiRecommendation | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  const recommendation = sanitize(raw.recommendation);
  const whyItMatters = sanitize(raw.whyItMatters);
  const suggestedAction = sanitize(raw.suggestedAction);
  const confidence = raw.confidence;
  if (!recommendation || !whyItMatters || !suggestedAction) return null;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null;
  return { recommendation, whyItMatters, suggestedAction, confidence };
}

export function buildUserMessage(context: RecommendationContext): string {
  // Compact, labelled context. Evidence is capped so an unusual check cannot inflate the prompt.
  return [
    `Pillar: ${context.pillar} / ${context.subPillar}`,
    `Finding: ${context.findingTitle}`,
    `Severity: ${context.severity}`,
    `Affected: ${context.affectedCount} ${context.affectedLabel}`,
    context.storeName ? `Store: ${context.storeName}` : '',
    context.problem ? `What the audit observed: ${context.problem}` : '',
    `Why the audit flags it: ${context.why}`,
    `Deterministic recommendation to improve: ${context.deterministicRecommendation}`,
    context.evidence.length ? `Evidence recorded by the check:\n- ${context.evidence.slice(0, 6).join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Hard ceiling on a fix-planning completion, whatever the batch size. A runaway answer is cut off
 * rather than billed.
 */
export const MAX_FIX_OUTPUT_TOKENS = 8_000;

/** Roughly what one proposal costs: the longest allowed value (160 chars), its one-sentence
 * reason, the echoed ref and the JSON punctuation around them, with headroom. */
const TOKENS_PER_PROPOSAL = 160;
/** The wrapper object and array that hold the proposals. */
const FIX_TOKENS_OVERHEAD = 200;

/**
 * The output budget for a batch of `targetCount` proposals.
 *
 * This is what the comment on MAX_FIX_OUTPUT_TOKENS always CLAIMED ("its budget scales with the
 * batch") while the value was a flat 2,000 for every call. That flat number was survivable only
 * because the batch was itself fixed at 15; now that the batch is configurable, a budget that did
 * not move with it would truncate the completion — and a truncated JSON body is reported to the
 * merchant as "AI could not draft these right now", with no clue that the cause was arithmetic.
 */
export function fixOutputTokens(targetCount: number): number {
  return Math.min(MAX_FIX_OUTPUT_TOKENS, FIX_TOKENS_OVERHEAD + Math.max(1, targetCount) * TOKENS_PER_PROPOSAL);
}

/** Body copy handed to the model per resource. Enough to write a description from, small enough
 * that a batch of long product pages cannot inflate the prompt without bound. */
export const SOURCE_TEXT_LIMIT = 600;

/**
 * Body copy for a request about ONE resource — the Investigate view drafting a fix for the item the
 * merchant opened. One page cannot inflate a prompt the way fifteen can, and a description written
 * from the page's whole opening is a better description than one written from its first lines.
 */
export const SINGLE_SOURCE_TEXT_LIMIT = 2_000;

/** How much of each resource's copy a request of `targetCount` resources may carry. */
export function sourceTextLimit(targetCount: number): number {
  return targetCount === 1 ? SINGLE_SOURCE_TEXT_LIMIT : SOURCE_TEXT_LIMIT;
}

/**
 * Ceiling on one prompt-tracking answer.
 *
 * Generous next to the other budgets because a truncated answer would be a FALSIFIED measurement,
 * not merely a shorter one: a model that would have named the store in its fourth paragraph, cut
 * off at the second, is recorded as never mentioning it. The cost is bounded by the number of
 * tracked questions rather than by trimming each reply.
 */
export const ASK_OUTPUT_TOKENS = 1_200;

export const FIX_SYSTEM_PROMPT = `You are Rankvora AI's e-commerce optimization assistant. Rankvora AI has ALREADY audited a Shopify store, found a specific problem, and identified the exact resources affected.

Your only job is to write a replacement value for ONE named field on each resource you are given. You are a copywriter working from supplied facts, not an investigator.

Rules you must not break:
- Return exactly one proposal per resource, echoing its ref back unchanged. Never invent a ref.
- Build every value from the resource's OWN supplied title and text. Do not introduce facts, numbers, prices, discounts, claims, dates or superlatives that are not in the context.
- Respect the stated character range exactly. A value outside it is rejected.
- Plain text on a single line. No HTML, no markdown, no quotes around the value, no emoji, no line breaks.
- Never use placeholder wording such as "Lorem ipsum", "Your brand here", "TBD" or bracketed slots.
- The value must be meaningfully different from the current value, and must still describe the same resource.
- REWRITE, DO NOT PAD. Appending the shop name, a separator and a suffix to the existing value is not a rewrite: "Gift Card" must not become "Gift Card | Acme Store". Every word you add has to describe THIS resource — what it is, what it is for, who it suits — using only the supplied context. If the only way you can reach the character range is boilerplate, return the best short description you can instead.
- READ ITS OWN COPY FIRST. Keep the meaning and the important specifics it states — what the item is, what it is made of or contains, what it is for, who it suits, and the terms a shopper would search for. Do not change what is being sold or claimed.
- No keyword stuffing: use each search term at most once, and write a sentence a person would want to read.
- No generic copy that would fit any store ("high quality products at great prices", "shop now for the best"). If a sentence would be equally true of another product, rewrite it about this one.
- "reason" is one short sentence saying what you changed and why, for a merchant to read while approving.

If a resource genuinely has too little information to write a defensible value, still return a proposal built only from its title — never pad it with invented detail.`;

/**
 * The length to AIM for, inside the hard range. Models count characters loosely and land a few
 * either side of what they were asked for; asked for "70-160" they write 167, and the value is
 * rejected. Aiming them at the middle-to-upper part of the range — where a description or title
 * has room to say something — leaves that slack inside the bounds. A range of one value is that value.
 */
export function aimWindow(minLength: number, maxLength: number): { from: number; to: number } {
  const width = Math.max(0, maxLength - minLength);
  return { from: minLength + Math.floor(width * 0.4), to: maxLength - Math.ceil(width * 0.1) };
}

export function buildFixMessage(context: FixPlanContext): string {
  const aim = aimWindow(context.minLength, context.maxLength);
  const header = [
    `Finding: ${context.findingTitle}`,
    context.problem ? `What the audit observed: ${context.problem}` : '',
    context.storeName ? `Store: ${context.storeName}` : '',
    // What the merchant told setup about their business. Each line is left out when unanswered.
    ...businessContextLines(context.business),
    `Field to rewrite: ${context.fieldLabel} (${context.field})`,
    `Required length: ${context.minLength}-${context.maxLength} characters — a value outside this range is rejected. Aim for ${aim.from}-${aim.to} characters, and count them.`,
    `What a good value looks like: ${context.guidance}`,
    '',
    `Rewrite the ${context.fieldLabel} for each of the following ${context.targets.length} resources:`,
  ].filter(Boolean).join('\n');

  const targets = context.targets.map((target, index) => [
    `${index + 1}. ref: ${target.ref}`,
    `   type: ${target.resourceType}`,
    `   name: ${target.title}`,
    `   current ${context.fieldLabel}: ${target.currentValue || '(empty)'}`,
    target.deterministicSuggestion ? `   Rankvora AI's own suggestion (improve on this): ${target.deterministicSuggestion}` : '',
    target.facts?.length ? `   its catalogue facts: ${target.facts.join('; ')}` : '',
    target.sourceText ? `   its own copy to draw from: ${target.sourceText}` : '',
    target.previousAttempt
      ? `   your previous ${context.fieldLabel} for this was REJECTED (${target.previousAttempt.problem}): ${target.previousAttempt.value}\n   Rewrite it to fit the required length — keep its meaning, change only what the length needs.`
      : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  return `${header}\n\n${targets}`;
}

/** Parses the proposals array. Shape only — the VALUES are judged by fix-policy.ts, which is the
 * single place that decides whether a proposal is acceptable. */
export function validateProposals(parsed: unknown): Array<{ ref: string; proposedValue: string; reason: string }> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed as { proposals?: unknown }).proposals;
  if (!Array.isArray(raw)) return null;

  const proposals: Array<{ ref: string; proposedValue: string; reason: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const ref = typeof record.ref === 'string' ? record.ref.trim() : '';
    const proposedValue = typeof record.proposedValue === 'string' ? record.proposedValue : '';
    if (!ref || !proposedValue) continue;
    proposals.push({ ref, proposedValue, reason: sanitize(record.reason, 300) });
  }
  return proposals;
}

/** Parses a completion body. Returns null rather than throwing: an unparseable answer is an
 * expected outcome for a generated value, not an exception. */
export function parseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
