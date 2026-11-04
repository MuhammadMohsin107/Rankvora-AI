import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { updateReturning } from '../db/returning.js';
import { aiFixProposals, auditScores, audits, findings, stores } from '../db/schema.js';
import { aiConfigured, aiModelName, env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { aiProvider } from '../lib/ai/index.js';
import type { AiProvider, FixTarget } from '../lib/ai/provider.js';
import {
  FIELD_RULES,
  fieldForSubPillar,
  isLengthRejection,
  parseResourceRef,
  titleFieldRule,
  validateProposedValue,
  type FieldRule,
  type FixableField,
  type FixableResourceType,
} from '../lib/ai/fix-policy.js';
import { generateAltText } from '../lib/alt-text/template.js';
import { getAltTextConfig } from './altText.service.js';
import { getFinding, updateFindingStatusInStore } from './finding.service.js';
import { getCurrentStoreId } from './store.service.js';
import { readResourceContent } from './fix-content.service.js';
import { readBusinessContext } from './business-context.service.js';
import { describeError } from '../lib/logger.js';

/**
 * ─── AI Fix Planner ──────────────────────────────────────────────────
 *
 *   Finding → AI proposal → validation → preview → human approval → existing fix engine
 *
 * The model's only role is the second step. It receives audit facts and returns text; it never
 * reaches Shopify, never reaches the database, and nothing it returns is trusted. Every proposal
 * is re-derived against the audit's own record of which resources are affected, re-checked
 * against the allow-list in fix-policy.ts, and then parked in `ai_fix_proposals` as a SUGGESTION.
 * Only an explicit approval moves it forward, and approval routes through the same
 * `finding.service` entry points the manual flow uses — there is no second fix engine here.
 *
 * WHERE THE PIPELINE CURRENTLY STOPS
 * The existing fix engine records a finding's resolution; it does not write to Shopify, and the
 * app holds only read scopes (see shopify-oauth.service.ts). So an approved proposal is marked
 * `approved`, the finding is moved through the manual engine, and the proposed value is held
 * ready. Writing it back to Shopify needs write scopes and a store-mutation path that does not
 * exist yet — so this service does not pretend to have applied anything it has not.
 */

// Resolved per call from AI_PROVIDER, so the vendor is a deployment choice rather than an import.
const provider = (): AiProvider => aiProvider();

/**
 * Resources sent to the model in one request. Bounds cost and latency; a finding affecting more
 * than this is proposed for in batches.
 *
 * Configurable (AI_FIX_MAX_TARGETS) rather than fixed at 15. It no longer has to protect the
 * completion from overflowing either: fixOutputTokens() derives the output budget from the batch
 * size, so the two move together instead of one silently truncating the other.
 */
const MAX_TARGETS_PER_REQUEST = env.aiFixMaxTargets;

/** Evidence-row statuses that mean "nothing to fix here". Everything else is a candidate. */
const HEALTHY_STATUS = 'Healthy';

/**
 * `Duplicate` is deliberately fixable while the deterministic engine offers nothing for it:
 * recommend.ts returns null because any de-duplicating suffix it invented would be arbitrary copy
 * the merchant never wrote. A model working from the resource's OWN name can do better than an
 * arbitrary suffix, which is precisely the case where AI adds something the rules cannot.
 */

interface EvidenceRow {
  id?: unknown;
  status?: unknown;
  cells?: Record<string, unknown>;
  current?: { label?: unknown; value?: unknown; meta?: unknown };
  suggested?: { label?: unknown; value?: unknown; meta?: unknown };
}

export interface FixProposalView {
  id: number;
  findingId: number;
  resourceType: string;
  resourceId: string;
  field: string;
  currentValue: string;
  proposedValue: string;
  /** The deterministic engine's suggestion, when it had one — the fallback if AI is declined. */
  deterministicValue: string | null;
  reason: string;
  status: string;
  statusDetail: string | null;
  model: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PlanFixesResult {
  findingId: number;
  /** True only when AI produced at least one valid proposal. */
  planned: boolean;
  proposals: FixProposalView[];
  /** Targets the audit found but that produced no usable proposal, with the reason. */
  skipped: Array<{ resourceType: string; resourceId: string; reason: string }>;
  model: string | null;
  /**
   * Present when planning did not happen at all.
   *
   * `not_configured` is split out from `unavailable` because they need different actions and the
   * merchant could not tell them apart: a server with no AI credentials reported the same
   * "could not draft right now" as a provider outage, so an operator debugging it had no way to
   * know whether to look at the key or at the vendor. It still says nothing about which vendor is
   * configured, and never about the key itself.
   */
  unavailableReason?: 'disabled' | 'not_configured' | 'unavailable' | 'not_fixable' | 'nothing_to_fix';
  /**
   * What the model wrote each resource from, by ref: 'store' when that resource's current content
   * was read live from Shopify for this request, 'audit' when the read did not return it and the
   * draft was written from what the audit recorded. Absent when no model was asked (a template, or
   * no plan).
   */
  contentSourceByRef?: Record<string, 'store' | 'audit'>;
}

function toView(row: typeof aiFixProposals.$inferSelect): FixProposalView {
  return {
    id: row.id,
    findingId: row.findingId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    field: row.field,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    deterministicValue: row.deterministicValue ?? null,
    reason: row.reason,
    status: row.status,
    statusDetail: row.statusDetail ?? null,
    model: row.aiModel ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Every evidence row the audit itself recorded for this finding.
 *
 * TWO SOURCES, AND THE SECOND ONE IS WHY AI FIX PLANNING WORKS AT ALL.
 *
 * A check may attach rows to the finding it raises (canonicals does). Most do not: title-tags and
 * meta-descriptions — the only two sub-pillars the bulk-fix UI actually offers — record their
 * sample once at the SUB-PILLAR level, in `audit_scores.details.evidenceRows`, and leave
 * `findings.evidence_rows` null.
 *
 * Reading only the finding's own rows therefore produced an empty target list for exactly those
 * two, and planAiFixes returned 'nothing_to_fix' WITHOUT EVER CALLING THE MODEL. From the UI that
 * was indistinguishable from an outage: "AI could not draft these right now" on a perfectly
 * healthy provider with a valid key.
 *
 * The sub-pillar sample is read from the same audit, for the same store, on the server. It is the
 * identical trust level as the finding's own rows — the audit wrote both — so using it as a
 * fallback preserves the authorization property that makes a resourceId safe to accept.
 */
async function candidateRows(finding: typeof findings.$inferSelect): Promise<EvidenceRow[]> {
  const own = Array.isArray(finding.evidenceRows) ? (finding.evidenceRows as EvidenceRow[]) : [];
  if (own.length > 0) return own;

  const [scoreRow] = await db
    .select({ details: auditScores.details })
    .from(auditScores)
    .where(and(
      eq(auditScores.auditId, finding.auditId),
      eq(auditScores.pillar, finding.pillar),
      eq(auditScores.subPillar, finding.subPillar),
    ))
    .limit(1);

  const details = (scoreRow?.details ?? {}) as { evidenceRows?: unknown };
  const sample = Array.isArray(details.evidenceRows) ? (details.evidenceRows as EvidenceRow[]) : [];

  // Narrow to the rows this finding is about. `issueType` is the check's own word for the defect
  // ("Too Short"), stored on the finding — without it a "too short titles" finding would be
  // planned against every flagged row in the sub-pillar, including ones it never raised.
  const issueType = text((finding.details as { issueType?: unknown } | null)?.issueType);
  if (!issueType) return sample;
  const matching = sample.filter((row) => text(row?.status) === issueType);
  return matching.length > 0 ? matching : sample;
}

/**
 * Narrows a title rule to what the merchant's FIELD may hold, given what the theme appends.
 *
 * The title-tags check scores the rendered title — the Shopify field plus the theme's suffix,
 * which it measures from the crawl rather than assuming (deriveTitleSuffix). Without this, the
 * two halves of the same feature would work to different numbers: the audit would flag a page at
 * 64 rendered characters, the planner would happily write a 58-character value, the theme would
 * render 79, and the very next audit would flag it again. A fix that cannot clear the check that
 * asked for it is not a fix.
 *
 * Both ends of the range move with the suffix, exactly as the check measures (titleFieldRule in
 * fix-policy.ts). Left untouched for non-title fields and when no suffix was observed.
 */
async function withThemeTitleBudget(
  rule: FieldRule,
  finding: typeof findings.$inferSelect,
): Promise<FieldRule> {
  if (rule.field !== 'seo.title') return rule;

  const [scoreRow] = await db
    .select({ details: auditScores.details })
    .from(auditScores)
    .where(and(
      eq(auditScores.auditId, finding.auditId),
      eq(auditScores.pillar, finding.pillar),
      eq(auditScores.subPillar, finding.subPillar),
    ))
    .limit(1);

  const stored = (scoreRow?.details as { titleSuffix?: { value?: unknown } } | null)?.titleSuffix;
  const suffixLength = typeof stored?.value === 'string' ? stored.value.length : 0;
  // Both bounds move with the suffix, exactly as the check measures — see titleFieldRule.
  return titleFieldRule(rule, suffixLength);
}

/**
 * The rule a value for this finding's field is judged by: the field's own bounds, and for a title
 * the bounds left once the theme's suffix is counted. The apply path and approval use it, so a
 * value is held to the range the planner drafted it for and the audit will score it against.
 */
export async function fieldRuleForFinding(findingId: number, field: FixableField): Promise<FieldRule | null> {
  const base = FIELD_RULES[field];
  if (!base) return null;
  if (field !== 'seo.title') return base;
  const [finding] = await db.select().from(findings).where(eq(findings.id, findingId)).limit(1);
  return finding ? withThemeTitleBudget(base, finding) : base;
}

/**
 * Derives the fixable resources from the audit's own evidence rows.
 *
 * This is the authorization anchor for "the resource belongs to this store". Evidence rows were
 * written by the audit from that store's snapshot, so a resource named here provably came from
 * the caller's store. A resourceId supplied by the model — or by a caller — that is not in this
 * set is rejected, which is what makes it impossible to aim a proposal at another tenant's
 * catalogue or at a resource the audit never examined.
 */
/**
 * A target as this service holds it: the model's view plus what only the server needs — the parsed
 * resource ref, and the evidence row's own cells for a template generator to draw on. Neither is
 * sent to a model: `planFix` is handed a narrowed projection, field by field.
 */
type PlannerTarget = FixTarget & {
  resourceType: FixableResourceType;
  resourceId: string;
  cells: Record<string, unknown>;
};

function extractTargets(rows: EvidenceRow[], rule: FieldRule): PlannerTarget[] {
  const targets: PlannerTarget[] = [];

  for (const row of rows) {
    if (text(row?.status) === HEALTHY_STATUS) continue;
    const ref = parseResourceRef(row?.id);
    if (!ref) continue;
    if (!rule.resourceTypes.includes(ref.resourceType)) continue;

    const currentValue = text(row?.current?.value);
    const deterministicSuggestion = text(row?.suggested?.value) || null;
    /**
     * What the resource IS CALLED, which is the one thing a generator cannot do without.
     *
     * `cells.name` first, because that is where every check puts the resource's own name — and
     * reading `cells.title` first, as this did, meant the name almost never arrived: only
     * title-tags has a `title` cell (the VALUE it judges, not the product's name). Meta-description
     * drafting therefore ran on a URL, and image alt text on the string "0 of 1 images labelled",
     * which the model dutifully echoed back and validation then rejected as unchanged.
     */
    const title = text(row?.cells?.name) || text(row?.cells?.title) || currentValue || text(row?.cells?.url);

    targets.push({
      ref: `${ref.resourceType}:${ref.resourceId}`,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      title,
      currentValue,
      deterministicSuggestion,
      // The row's remaining cells, verbatim. A template generator needs fields no model prompt
      // does — vendor, product type, the image's position in its gallery — and they are already
      // on the row the audit wrote.
      cells: (row?.cells ?? {}) as Record<string, unknown>,
      // The deterministic suggestion for a description IS an excerpt of the page's own copy, so
      // it doubles as the source material. Nothing external is fetched to build this.
      sourceText: deterministicSuggestion ?? currentValue,
    });
  }

  return targets;
}

/**
 * Records freshly planned proposals, replacing whatever this finding already held for the same
 * resource and field.
 *
 * WHY AN UPSERT. `ai_fix_proposals_target_idx` allows ONE row per finding, resource and field,
 * whatever its status. Planning used to delete only the `proposed` rows before inserting, so a
 * target that already had an `approved`, `failed` or `applied` row — a value typed and saved, or a
 * draft Shopify refused — made the insert fail on the unique index, and asking for a new draft
 * after any save reported an outage. Asking again is the merchant's decision to replace the old
 * value, so the row becomes this draft, undecided, exactly like a new one.
 */
async function storeProposals(rows: Array<typeof aiFixProposals.$inferInsert>): Promise<void> {
  for (const row of rows) {
    await db
      .insert(aiFixProposals)
      .values(row)
      .onConflictDoUpdate({
        target: [aiFixProposals.findingId, aiFixProposals.resourceType, aiFixProposals.resourceId, aiFixProposals.field],
        set: {
          currentValue: row.currentValue,
          proposedValue: row.proposedValue,
          reason: row.reason,
          deterministicValue: row.deterministicValue ?? null,
          status: 'proposed',
          statusDetail: null,
          aiModel: row.aiModel ?? null,
          decidedAt: null,
          decidedBy: null,
        },
      });
  }
}

async function storeNameFor(storeId: number): Promise<string | null> {
  const [row] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId)).limit(1);
  // Empty means not known yet — null, so no template or prompt is given a blank store name.
  return row?.name?.trim() || null;
}

/** The finding's store, resolved through the audit it belongs to. */
async function storeIdForFinding(findingId: number): Promise<number | null> {
  const [row] = await db
    .select({ storeId: audits.storeId })
    .from(findings)
    .innerJoin(audits, eq(findings.auditId, audits.id))
    .where(eq(findings.id, findingId))
    .limit(1);
  return row?.storeId ?? null;
}

/**
 * ─── Values built from the merchant's own template ───────────────────
 *
 * The deterministic half of fix planning, for fields whose rule says `generator: 'template'`.
 * Today that is image alt text.
 *
 * EVERY INPUT IS THE MERCHANT'S OWN. The template comes from their `page_settings` row, and the
 * words filled into it — product title, vendor, product type, the image's position in its own
 * gallery — are the values the audit read from their Shopify store. Nothing is invented, sampled
 * or defaulted into a value: where Shopify had no vendor, the placeholder resolves to empty and
 * the renderer tidies the separator around it.
 *
 * NO MODEL, NO KEY, NO COST. It works on a server with no AI credentials at all, which is what
 * `classifyFixability` has always promised for this field: "Rankvora AI can generate this image alt
 * text from your own template and apply it after you review it."
 *
 * STILL A PROPOSAL, NEVER A WRITE. The result lands in `ai_fix_proposals` exactly as a drafted one
 * does, and the merchant approves each value before anything reaches their store.
 */
async function planFromTemplate(input: {
  userId: number;
  findingId: number;
  storeId: number;
  storeIdParam?: number;
  rule: FieldRule;
  batch: PlannerTarget[];
}): Promise<PlanFixesResult> {
  const { userId, findingId, storeId, rule, batch } = input;

  const settings = await getAltTextConfig(userId, input.storeIdParam);
  const typeConfig = settings.config.products;
  const shopName = await storeNameFor(storeId);

  // Said on every row, because a value's provenance is the thing a merchant is approving. A store
  // that has never opened the template builder gets Rankvora AI's default pattern — filled with their
  // own product's words, and labelled as the default so they know what to change to change it.
  const source = settings.isDefault
    ? 'Built from Rankvora AI\'s default alt-text template. Edit the template in Image Alt Text settings to change the wording.'
    : 'Built from your image alt-text template.';

  const accepted: Array<typeof aiFixProposals.$inferInsert> = [];
  const skipped: PlanFixesResult['skipped'] = [];

  for (const target of batch) {
    const position = Number(target.cells.position);
    const generated = generateAltText(
      typeConfig.template,
      {
        product_title: target.title,
        product_type: text(target.cells.productType),
        vendor: text(target.cells.vendor),
        shop_name: shopName,
        image_position: Number.isInteger(position) ? position : null,
      },
      typeConfig,
      target.currentValue || null,
    );

    // The merchant's own "skip images that already have alt text" setting, honoured and stated.
    // Silently returning the existing value would have it rejected below as unchanged, which
    // describes the value rather than the decision.
    if (generated.skipped) {
      skipped.push({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        reason: 'This image already has alt text, and your template is set to leave those alone.',
      });
      continue;
    }

    // The same boundary an AI value crosses. A template can produce an empty string — every
    // placeholder in it resolved to nothing — and that must never be written to a live store.
    const check = validateProposedValue(rule, generated.value, target.currentValue);
    if (!check.ok) {
      skipped.push({ resourceType: target.resourceType, resourceId: target.resourceId, reason: check.detail });
      continue;
    }

    accepted.push({
      findingId,
      storeId,
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      field: rule.field,
      currentValue: target.currentValue,
      proposedValue: check.value,
      reason: generated.truncated ? `${source} Shortened to your ${typeConfig.characterLimit}-character limit.` : source,
      // The template IS the deterministic engine here, so its output is the deterministic value.
      deterministicValue: check.value,
      status: 'proposed',
      // Null: no model wrote this. The UI reads the absence as "from your template" rather than
      // naming a vendor that was never called.
      aiModel: null,
    });
  }

  if (accepted.length === 0) {
    return { findingId, planned: false, proposals: [], skipped, model: null, unavailableReason: 'nothing_to_fix' };
  }

  await storeProposals(accepted);

  const stored = await db
    .select()
    .from(aiFixProposals)
    .where(and(eq(aiFixProposals.findingId, findingId), eq(aiFixProposals.status, 'proposed')));

  console.log(`[scorelo-fix] built ${accepted.length} ${rule.field} value(s) from the store's template for finding ${findingId} (${skipped.length} skipped)`);

  return { findingId, planned: true, proposals: stored.map(toView), skipped, model: null };
}

/**
 * Generates AI fix proposals for one finding.
 *
 * Tenancy is enforced by delegating the lookup to `getFinding`, which resolves the caller's own
 * store and 404s otherwise — the same guard the manual flow uses. Nothing is applied here.
 */
/**
 * Resolves ONE resource of a finding for a value the merchant typed themselves.
 *
 * WHY THIS EXISTS. A proposal row is what the apply path needs — it carries the resource, the field
 * and the authorization that the audit really saw this resource. AI drafting creates one as a side
 * effect; typing a value by hand created nothing, so a hand-written description had no way to reach
 * Shopify at all. That made "manual" a second-class path in a feature whose whole point is that the
 * merchant's own wording wins.
 *
 * THE AUTHORIZATION IS IDENTICAL TO planAiFixes, deliberately and by reuse rather than by
 * resemblance: the same `getFinding` ownership check, the same `candidateRows`, the same
 * `extractTargets`. A resourceRef that the audit did not record for this finding is not found here,
 * so a hand-typed value cannot be aimed at a resource — or a tenant — the caller has no claim to.
 *
 * Returns null when the finding is not fixable or the resource is not one of its own.
 */
export async function resolveManualTarget(
  userId: number,
  findingId: number,
  resourceRef: string,
  storeId?: number,
): Promise<{ rule: FieldRule; resourceType: FixableResourceType; resourceId: string; currentValue: string } | null> {
  // Throws 404 unless this finding belongs to a store the caller owns.
  const finding = await getFinding(userId, findingId, storeId);

  const rule = fieldForSubPillar(finding.subPillar);
  if (!rule) return null;

  const target = extractTargets(await candidateRows(finding), rule).find((item) => item.ref === resourceRef);
  if (!target) return null;

  return {
    rule,
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    currentValue: target.currentValue,
  };
}

export async function planAiFixes(
  userId: number,
  findingId: number,
  options: { storeId?: number; resourceIds?: string[]; limit?: number } = {},
): Promise<PlanFixesResult> {
  // Throws 404 unless this finding belongs to a store the caller owns.
  const finding = await getFinding(userId, findingId, options.storeId);

  const baseRule = fieldForSubPillar(finding.subPillar);
  if (!baseRule) {
    return {
      findingId,
      planned: false,
      proposals: [],
      skipped: [],
      model: null,
      unavailableReason: 'not_fixable',
    };
  }

  const rule = await withThemeTitleBudget(baseRule, finding);

  let targets = extractTargets(await candidateRows(finding), rule);

  // Items asked for that are not planned, each with its reason — silence is never an answer here.
  const scopeSkipped: PlanFixesResult['skipped'] = [];
  const skipRef = (ref: string, reason: string) => {
    const separator = ref.indexOf(':');
    scopeSkipped.push({ resourceType: ref.slice(0, separator), resourceId: ref.slice(separator + 1), reason });
  };

  // A caller may narrow to specific resources (the bulk UI selecting rows, the Investigate view
  // opened on one item). Anything outside the audit's own evidence is never fetched — see
  // extractTargets() — but the caller is told it was left out, and why.
  if (options.resourceIds?.length) {
    const wanted = new Set(options.resourceIds);
    const known = new Set(targets.map((target) => target.ref));
    targets = targets.filter((target) => wanted.has(target.ref));
    for (const ref of wanted) {
      if (!known.has(ref)) skipRef(ref, 'This item is not one this issue flagged in the latest analysis, so there is nothing to fix for it here.');
    }
  }

  // A value already saved to the store is not replanned over: the proposal row is the only record of
  // that write, and a draft written from the audit's now-stale view of the item would replace it.
  // Saving again goes through the apply path, which records the new value as it writes it.
  if (targets.length > 0) {
    const saved = await db
      .select({ resourceType: aiFixProposals.resourceType, resourceId: aiFixProposals.resourceId })
      .from(aiFixProposals)
      .where(and(eq(aiFixProposals.findingId, findingId), eq(aiFixProposals.field, rule.field), eq(aiFixProposals.status, 'applied')));
    const savedRefs = new Set(saved.map((row) => `${row.resourceType}:${row.resourceId}`));
    if (savedRefs.size > 0) {
      for (const target of targets) {
        if (savedRefs.has(target.ref)) skipRef(target.ref, 'Already saved to your store from Rankvora AI. Press Re-analyze to confirm it, and fix it again if it is still flagged.');
      }
      targets = targets.filter((target) => !savedRefs.has(target.ref));
    }
  }

  if (targets.length === 0) {
    return { findingId, planned: false, proposals: [], skipped: scopeSkipped, model: null, unavailableReason: 'nothing_to_fix' };
  }

  const batch = targets.slice(0, Math.min(options.limit ?? MAX_TARGETS_PER_REQUEST, MAX_TARGETS_PER_REQUEST));
  // One request drafts at most a batch. Anything past it was left with an empty box and no word on
  // why; it is now said, so a caller can ask for the rest in the next request (the bulk editor does).
  for (const target of targets.slice(batch.length)) {
    skipRef(target.ref, `Not drafted in this request — Rankvora AI drafts up to ${batch.length} items at a time. Draft again for the rest.`);
  }
  const storeId = (await storeIdForFinding(findingId)) ?? (await getCurrentStoreId(userId, options.storeId));

  // ── Deterministic fields never reach a model ──────────────────────
  // Which engine writes a field is a property of the FIELD (see FixGenerator), and image alt text
  // is built from the merchant's own template: a model there costs money and variance without
  // adding correctness. This branch was missing entirely, so pressing "Draft with AI" on alt text
  // sent a coverage summary to a language model and reported the rejected result as an outage.
  if (rule.generator === 'template') {
    const planned = await planFromTemplate({ userId, findingId, storeId, storeIdParam: options.storeId, rule, batch });
    return { ...planned, skipped: [...scopeSkipped, ...planned.skipped] };
  }

  if (!aiConfigured()) {
    // Logged so this shows up in the server's own output the moment someone presses the button —
    // an operator should not have to reproduce it to find out the key is missing.
    console.warn(
      `[scorelo-ai] fix planning skipped for finding ${findingId}: `
      + (!env.aiRecommendationsEnabled
        ? 'AI_RECOMMENDATIONS_ENABLED=false'
        : `no API key configured for AI_PROVIDER=${env.aiProvider}`),
    );
    return {
      findingId,
      planned: false,
      proposals: [],
      skipped: scopeSkipped,
      model: null,
      unavailableReason: !env.aiRecommendationsEnabled ? 'disabled' : 'not_configured',
    };
  }

  // What each resource says TODAY, read from the store — its whole copy and its catalogue facts,
  // not the audit's one-line excerpt. Falls back to the audit's record, per resource, when the
  // store cannot be read; both are the merchant's own content. See fix-content.service.ts.
  const live = await readResourceContent(storeId, batch);
  const contentSourceByRef: Record<string, 'store' | 'audit'> = Object.fromEntries(
    batch.map((target) => [target.ref, live.has(target.ref) ? 'store' : 'audit']),
  );

  const storeName = await storeNameFor(storeId);
  // The merchant's own answers about their business, so a draft uses their brand name and is
  // written in their language. Empty (and then the prompt is unchanged) for a store that skipped setup.
  const business = await readBusinessContext(storeId);
  const request = (targets: PlannerTarget[], previous?: Map<string, { value: string; problem: string }>) => provider().planFix({
    findingTitle: finding.title,
    problem: finding.problem,
    field: rule.field,
    fieldLabel: rule.label,
    minLength: rule.minLength,
    maxLength: rule.maxLength,
    guidance: rule.guidance,
    storeName,
    business,
    targets: targets.map(({ ref, resourceType, title, currentValue, deterministicSuggestion, sourceText }) => {
      const content = live.get(ref);
      const attempt = previous?.get(ref);
      return {
        ref,
        resourceType,
        title: content?.title || title,
        currentValue,
        deterministicSuggestion,
        sourceText: content?.text || sourceText,
        ...(content?.facts.length ? { facts: content.facts } : {}),
        ...(attempt ? { previousAttempt: attempt } : {}),
      };
    }),
  });

  const startedAt = Date.now();
  const result = await request(batch);

  if (!result.ok) {
    // Reason is recorded for operators; the caller is told only that AI was unavailable, and the
    // deterministic suggestion on each evidence row remains usable exactly as before.
    console.warn(`[scorelo-ai] fix planning unavailable for finding ${findingId}: ${result.reason} (${result.detail})`);
    return { findingId, planned: false, proposals: [], skipped: scopeSkipped, model: null, unavailableReason: 'unavailable', contentSourceByRef };
  }

  // ── Validation: nothing the model returned is trusted past this line ──
  const byRef = new Map(batch.map((target) => [target.ref, target]));
  const accepted: Array<typeof aiFixProposals.$inferInsert> = [];
  const skipped: PlanFixesResult['skipped'] = [...scopeSkipped];
  // Drafts that failed ONLY on length, with what the model wrote and how far off it was.
  const lengthMisses = new Map<string, { value: string; problem: string }>();
  const accept = (target: PlannerTarget, value: string, reason: string, model: string) => {
    accepted.push({
      findingId,
      storeId,
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      field: rule.field,
      currentValue: target.currentValue,
      proposedValue: value,
      reason: reason || 'Rewritten to meet the required length using the resource\'s own wording.',
      deterministicValue: target.deterministicSuggestion,
      status: 'proposed',
      aiModel: model,
    });
  };

  // The model is asked for one value per resource; a second answer for the same ref is ignored
  // rather than judged, so a ref can never be both drafted and reported as not drafted.
  const firstAnswered = new Set<string>();
  for (const proposal of result.proposals) {
    if (firstAnswered.has(proposal.ref)) continue;
    firstAnswered.add(proposal.ref);
    const target = byRef.get(proposal.ref);
    if (!target) {
      // A ref we never sent. The model either hallucinated a resource or echoed one back wrong;
      // either way it is not something this finding is entitled to touch.
      skipped.push({ resourceType: 'unknown', resourceId: proposal.ref, reason: 'The suggestion referred to a resource this finding does not cover.' });
      continue;
    }

    const check = validateProposedValue(rule, proposal.proposedValue, target.currentValue);
    if (!check.ok) {
      // Only a few characters off is the common miss, and the one a second attempt can correct: it
      // is sent back once with the reason. Anything else — markup, placeholder wording, no change —
      // is not a length problem and is not retried.
      if (isLengthRejection(check)) {
        lengthMisses.set(target.ref, { value: proposal.proposedValue.replace(/\s+/g, ' ').trim(), problem: check.detail });
        continue;
      }
      skipped.push({ resourceType: target.resourceType, resourceId: target.resourceId, reason: `The AI draft was not used: ${check.detail}.` });
      continue;
    }

    accept(target, check.value, proposal.reason, result.model);
  }

  // ── One correction, for drafts that missed only on length ──────────
  // Still the model's own wording: it is shown its value and how far off it was, and asked to fix
  // the length. The answer is held to the same validation; a second miss is reported, not trimmed.
  // Within the same time budget one AI request is held to (AI_TOTAL_BUDGET_MS): the correction is
  // made only if the first answer left at least half of it, so a slow first call is not followed by
  // a second wait as long again.
  const budgetLeft = Math.max(env.aiTimeoutMs, env.aiTotalBudgetMs) - (Date.now() - startedAt);
  const correctionAllowed = budgetLeft >= Math.max(env.aiTimeoutMs, env.aiTotalBudgetMs) / 2;
  if (lengthMisses.size > 0) {
    const retryTargets = batch.filter((target) => lengthMisses.has(target.ref));
    const retry = correctionAllowed
      ? await request(retryTargets, lengthMisses)
      : { ok: false as const, reason: 'timeout' as const, detail: 'no time left in the request budget for a correction' };
    const answered = new Set<string>();
    if (retry.ok) {
      for (const proposal of retry.proposals) {
        const target = byRef.get(proposal.ref);
        if (!target || !lengthMisses.has(target.ref) || answered.has(target.ref)) continue;
        answered.add(target.ref);
        const check = validateProposedValue(rule, proposal.proposedValue, target.currentValue);
        if (check.ok) {
          accept(target, check.value, proposal.reason, retry.model);
        } else {
          skipped.push({
            resourceType: target.resourceType,
            resourceId: target.resourceId,
            reason: `The AI draft was not used: ${check.detail}, even after a second attempt. Write it yourself, or try again.`,
          });
        }
      }
    } else {
      console.warn(`[scorelo-ai] length correction unavailable for finding ${findingId}: ${retry.reason} (${retry.detail})`);
    }
    for (const target of retryTargets) {
      if (answered.has(target.ref)) continue;
      skipped.push({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        reason: `The AI draft was not used: ${lengthMisses.get(target.ref)?.problem}. Write it yourself, or try again.`,
      });
    }
  }

  // ── Targets the model simply never mentioned ──────────────────────
  // The loop above can only account for refs the model RETURNED. A target it ignored outright
  // appears in neither `accepted` nor `skipped`, so it used to vanish with no record anywhere: the
  // merchant saw an empty box beside a row that had been selected, with nothing saying why, and
  // the count silently read "4 drafted" for 5 selected. Silence is the one answer this flow must
  // never give, so an omission is now a stated outcome like any other.
  const answered = new Set([
    ...accepted.map((row) => `${row.resourceType}:${row.resourceId}`),
    ...skipped.map((entry) => `${entry.resourceType}:${entry.resourceId}`),
  ]);
  for (const target of batch) {
    if (answered.has(target.ref)) continue;
    skipped.push({
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      reason: 'The model returned nothing for this one — there was too little of its own wording to build from.',
    });
  }

  if (accepted.length === 0) {
    return { findingId, planned: false, proposals: [], skipped, model: result.model, unavailableReason: 'unavailable', contentSourceByRef };
  }

  // Re-planning supersedes the previous value for the same target rather than stacking rows the
  // merchant would have to disambiguate — see storeProposals.
  await storeProposals(accepted);

  const stored = await db
    .select()
    .from(aiFixProposals)
    .where(and(eq(aiFixProposals.findingId, findingId), eq(aiFixProposals.status, 'proposed')));

  console.log(`[scorelo-ai] planned ${accepted.length} fix proposal(s) for finding ${findingId} with ${result.model} (${skipped.length} rejected by validation)`);

  return {
    findingId,
    planned: true,
    proposals: stored.map(toView),
    skipped,
    model: result.model,
    contentSourceByRef,
  };
}

/** The preview: every proposal recorded for a finding, current-value beside proposed-value. */
export async function listFixProposals(userId: number, findingId: number, storeId?: number): Promise<FixProposalView[]> {
  // Tenancy first — this 404s unless the finding belongs to the caller.
  await getFinding(userId, findingId, storeId);
  const rows = await db.select().from(aiFixProposals).where(eq(aiFixProposals.findingId, findingId));
  return rows.map(toView);
}

/**
 * Approves or rejects one proposal.
 *
 * Approval re-runs the full validation rather than trusting what was stored: the row was written
 * from a model response, it has been sitting in a table since, and the value is about to be
 * treated as authorised. Re-checking costs nothing and removes any window in which a row that
 * would fail today could be approved because it passed when it was written.
 */
export async function decideFixProposal(
  userId: number,
  proposalId: number,
  decision: 'approve' | 'reject',
  options: { storeId?: number } = {},
): Promise<FixProposalView> {
  return decideFixProposalInStore(userId, await getCurrentStoreId(userId, options.storeId), proposalId, decision);
}

/** One decision, for a caller that has already worked out the store — see decideFixProposals. */
async function decideFixProposalInStore(
  userId: number,
  resolvedStoreId: number,
  proposalId: number,
  decision: 'approve' | 'reject',
): Promise<FixProposalView> {
  const [proposal] = await db
    .select()
    .from(aiFixProposals)
    .where(and(eq(aiFixProposals.id, proposalId), eq(aiFixProposals.storeId, resolvedStoreId)))
    .limit(1);
  if (!proposal) throw new ApiError(404, 'Fix proposal not found', 'FIX_PROPOSAL_NOT_FOUND');

  if (proposal.status !== 'proposed') {
    throw new ApiError(409, `This proposal has already been ${proposal.status}`, 'FIX_PROPOSAL_ALREADY_DECIDED');
  }

  const now = new Date();

  if (decision === 'reject') {
    const [updated] = await updateReturning(
      aiFixProposals,
      { status: 'rejected', decidedAt: now, decidedBy: userId },
      eq(aiFixProposals.id, proposalId),
    );
    return toView(updated!);
  }

  // ── Re-validate at the moment of approval ──
  const rule = await fieldRuleForFinding(proposal.findingId, proposal.field as FixableField);
  if (!rule) {
    const [updated] = await updateReturning(
      aiFixProposals,
      { status: 'failed', statusDetail: 'This proposal targets a field Rankvora AI no longer allows to be changed.', decidedAt: now, decidedBy: userId },
      eq(aiFixProposals.id, proposalId),
    );
    throw new ApiError(422, toView(updated!).statusDetail ?? 'Invalid proposal', 'FIX_PROPOSAL_INVALID');
  }

  const check = validateProposedValue(rule, proposal.proposedValue, proposal.currentValue);
  if (!check.ok) {
    const [updated] = await updateReturning(
      aiFixProposals,
      { status: 'failed', statusDetail: check.detail, decidedAt: now, decidedBy: userId },
      eq(aiFixProposals.id, proposalId),
    );
    throw new ApiError(422, toView(updated!).statusDetail ?? check.detail, 'FIX_PROPOSAL_INVALID');
  }

  // ── Hand off to the EXISTING fix engine ──
  // Same entry point the manual flow uses, so tenancy, status transitions and the audit trail
  // behave identically whether a fix came from a person or from a model.
  await updateFindingStatusInStore(resolvedStoreId, proposal.findingId, { status: 'resolved' });

  const [updated] = await updateReturning(
    aiFixProposals,
    {
      status: 'approved',
      decidedAt: now,
      decidedBy: userId,
      // Stated plainly rather than reported as applied: Rankvora AI holds read-only Shopify scopes,
      // so no value has been written to the store. Claiming otherwise would be a lie the merchant
      // would discover on the next audit.
      statusDetail: 'Approved. Rankvora AI currently holds read-only Shopify access, so this value has not been written to your store — the finding has been marked resolved and the approved value is recorded here.',
    },
    eq(aiFixProposals.id, proposalId),
  );

  console.log(`[scorelo-ai] proposal ${proposalId} approved by user ${userId} for finding ${proposal.findingId}`);
  return toView(updated!);
}

export interface BulkDecisionResult {
  approved: FixProposalView[];
  rejected: FixProposalView[];
  /** Proposals that could not be actioned, each with the reason — a partial success is reported
   * as one, never rounded up to "done" or down to a failure. */
  failed: Array<{ proposalId: number; reason: string }>;
}

/**
 * Applies a set of decisions from one preview screen.
 *
 * Each proposal is decided independently: one value that no longer validates must not discard
 * the merchant's decisions about the others. The caller gets back exactly what happened to each.
 */
export async function decideFixProposals(
  userId: number,
  input: { approve?: number[]; reject?: number[] },
  options: { storeId?: number } = {},
): Promise<BulkDecisionResult> {
  const result: BulkDecisionResult = { approved: [], rejected: [], failed: [] };

  // The store is worked out ONCE for the whole request, not once per proposal: a request may carry
  // 200 decisions, each of which used to look it up twice, and D1 allows 1,000 queries per request.
  // If it cannot be resolved, every proposal is reported as failed with that reason, as before.
  let resolvedStoreId: number;
  try {
    resolvedStoreId = await getCurrentStoreId(userId, options.storeId);
  } catch (error) {
    const reason = error instanceof ApiError ? error.message : 'Could not look up your store.';
    for (const proposalId of [...(input.reject ?? []), ...(input.approve ?? [])]) result.failed.push({ proposalId, reason });
    return result;
  }

  for (const proposalId of input.reject ?? []) {
    try {
      result.rejected.push(await decideFixProposalInStore(userId, resolvedStoreId, proposalId, 'reject'));
    } catch (error) {
      result.failed.push({ proposalId, reason: error instanceof ApiError ? error.message : 'Could not reject this proposal.' });
    }
  }

  for (const proposalId of input.approve ?? []) {
    try {
      result.approved.push(await decideFixProposalInStore(userId, resolvedStoreId, proposalId, 'approve'));
    } catch (error) {
      result.failed.push({ proposalId, reason: error instanceof ApiError ? error.message : 'Could not approve this proposal.' });
    }
  }

  return result;
}

/**
 * Bulk preparation for the future Fix Center selection UI.
 *
 * Deliberately sequential and capped: each finding is one model call, and a merchant selecting
 * fifty rows must not be able to fire fifty concurrent requests at the model provider. One finding failing
 * never stops the rest — it comes back with its own reason, exactly as the single-finding path
 * would report it.
 */
export async function planAiFixesForFindings(
  userId: number,
  findingIds: number[],
  options: { storeId?: number } = {},
): Promise<PlanFixesResult[]> {
  const results: PlanFixesResult[] = [];
  for (const findingId of findingIds) {
    try {
      results.push(await planAiFixes(userId, findingId, options));
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) throw error;
      console.warn(`[scorelo-ai] bulk planning skipped finding ${findingId}: ${describeError(error)}`);
      results.push({ findingId, planned: false, proposals: [], skipped: [], model: null, unavailableReason: 'unavailable' });
    }
  }
  return results;
}

/** A fixable field as the UI needs it: what it is called, the bounds a value must meet, and what writes it. */
export interface FixFieldView {
  subPillar: string;
  field: FixableField;
  label: string;
  minLength: number;
  maxLength: number;
  generator: FieldRule['generator'];
}

/**
 * Whether AI fix planning can be attempted at all, and which fields it covers. Capability only —
 * never the key. `fields` carries each field's own bounds from FIELD_RULES, so an editor can show
 * the range a value must meet from the same numbers the server validates against.
 */
export function aiFixStatus(): { enabled: boolean; model: string | null; fixableSubPillars: string[]; fields: FixFieldView[]; maxTargetsPerRequest: number } {
  return {
    enabled: aiConfigured(),
    model: aiConfigured() ? aiModelName() : null,
    // How many items one drafting request covers, so a client drafting more sends them in batches
    // of this size rather than having all but the first batch come back empty.
    maxTargetsPerRequest: MAX_TARGETS_PER_REQUEST,
    fixableSubPillars: Object.values(FIELD_RULES).map((rule) => rule.subPillar),
    fields: Object.values(FIELD_RULES).map((rule) => ({
      subPillar: rule.subPillar,
      field: rule.field,
      label: rule.label,
      minLength: rule.minLength,
      maxLength: rule.maxLength,
      generator: rule.generator,
    })),
  };
}
