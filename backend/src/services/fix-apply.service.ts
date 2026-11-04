import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chunkForD1 } from '../db/limits.js';
import { aiFixProposals } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { resolveShopifyClient } from '../audit-engine/store-data/index.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';
import type { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import {
  FIELD_RULES,
  isFixableResourceType,
  parseProductImageId,
  validateProposedValue,
  type FieldRule,
  type FixableField,
  type FixableResourceType,
  type SeoResourceType,
} from '../lib/ai/fix-policy.js';
import { getFixContext } from './fixability.service.js';
import { fieldRuleForFinding, resolveManualTarget } from './ai-fix.service.js';
import { automationConsentFor, writeIsPermitted } from './onboarding.service.js';
import { judgeProtectedPath, protectedPathsFor, readResourcePath } from './protected-paths.service.js';

/**
 * ─── Applying an approved fix to the merchant's store ────────────────
 *
 * THE STEP THAT WAS MISSING. Everything before this existed: the audit finds a gap, a value is
 * proposed, a human approves it, and the proposal lands in `ai_fix_proposals` with status
 * `approved`. Nothing then wrote it to Shopify, so `approved` was where the pipeline stopped and
 * the merchant's storefront never changed. The schema anticipated this — `applied` and `failed`
 * have always been valid statuses — but the engine that moves a row between them did not exist.
 *
 * ─── WHY AN APPLIED FIX ACTUALLY MOVES THE SCORE ─────────────────────
 * Because the field written here is the SAME field the audit reads back. That is not a hope, it is
 * a property of the mapping below:
 *
 *   product / collection   written: productUpdate / collectionUpdate `seo { description }`
 *                          read:    PRODUCTS_QUERY / COLLECTIONS_QUERY `seo { description }`
 *   page / article         written: `global.description_tag` metafield
 *                          read:    PAGES_QUERY / ARTICLES_QUERY metafields(namespace: "global")
 *
 * Page and Article genuinely have no `seo` field on their update inputs — verified against the
 * 2026-07 schema — which is exactly why shopify.provider.ts already reads their listing from the
 * `global` metafields. Writing anywhere else would produce a change the next audit could not see,
 * and a merchant staring at an unchanged score after a successful apply.
 *
 * The audit itself re-fetches live (`buildSnapshot()` has no cache) and the meta-description check
 * reads Admin API data rather than crawled HTML, so there is no CDN or theme delay between the
 * write and the next run seeing it.
 *
 * ─── WHAT THIS SERVICE REFUSES TO DO ─────────────────────────────────
 * Every write is bounded by the same allow-list the proposal passed on the way in, re-checked here
 * rather than trusted. A stored row is not evidence that it is still valid: the field rules may
 * have tightened, and a row could in principle be edited outside this flow. `validateProposedValue`
 * runs again immediately before the mutation, so a value that would not pass today is never sent to
 * a live storefront.
 */

/**
 * One requested fix. Either an existing proposal (the AI-drafted path) or a resource plus the
 * merchant's own text (the manual path). The schema guarantees exactly one shape per entry.
 */
export type ApplyFixInput =
  | { proposalId: number; value?: string; findingId?: undefined; resourceRef?: undefined }
  | { proposalId?: undefined; findingId: number; resourceRef: string; value: string };

/** One resource's outcome. Returned to the caller and mirrored into the proposal row. */
export interface ApplyResult {
  proposalId: number;
  /**
   * The evidence-row ref (`product:123`) this outcome belongs to.
   *
   * Present so the caller can match results back to the rows it submitted. A manual fix has no
   * proposal id until the server creates one, so the id alone cannot identify it — without this the
   * UI could not tell which hand-typed row Shopify refused.
   */
  resourceRef: string;
  status: 'applied' | 'failed' | 'skipped';
  /** Why it failed or was skipped. Never contains a credential or a raw API payload. */
  detail?: string;
}

export interface ApplySummary {
  applied: number;
  failed: number;
  skipped: number;
  results: ApplyResult[];
}

/** Shopify's `userErrors` shape, identical across the four mutations used here. */
interface UserError {
  field?: string[] | null;
  message?: string | null;
}

/**
 * The `global` namespace is where the online store keeps a Page's or Article's search listing.
 * `single_line_text_field` is the type Shopify's own SEO guide specifies; writing a different type
 * would store the value but leave the theme unable to render it.
 */
const SEO_METAFIELD_NAMESPACE = 'global';
const SEO_METAFIELD_TYPE = 'single_line_text_field';

/** Which `global` metafield key backs each SEO field on Pages and Articles. */
const METAFIELD_KEY: Partial<Record<FixableField, string>> = {
  'seo.title': 'title_tag',
  'seo.description': 'description_tag',
};

/** Which key of Shopify's `SEOInput` each field maps to on Products and Collections. */
const SEO_INPUT_KEY: Partial<Record<FixableField, 'title' | 'description'>> = {
  'seo.title': 'title',
  'seo.description': 'description',
};

/** The GraphQL type name behind each page-like resource kind, for rebuilding a gid. */
const GID_TYPE: Record<SeoResourceType, string> = {
  product: 'Product',
  collection: 'Collection',
  page: 'Page',
  article: 'Article',
};

/** The evidence-row ref a stored proposal corresponds to — the id the UI knows a row by. */
function ref(row: { resourceType: string; resourceId: string }): string {
  return `${row.resourceType}:${row.resourceId}`;
}

/**
 * Rebuilds the full `gid://shopify/Type/123` a mutation's `ID!` argument requires.
 *
 * WHY THIS IS NEEDED AT ALL. The snapshot deliberately stores the NUMERIC SUFFIX rather than the
 * gid — see `id()` in shopify.provider.ts, which strips it because "the numeric suffix is what
 * merchants see in admin URLs, so it is what evidence rows should reference". That is the right
 * call for evidence a person reads, and it means every id reaching this service is `123`, not a
 * gid. Passing the bare number straight to `$id: ID!` is rejected by Shopify at variable coercion
 * — `Variable $id of type ID! was provided invalid value` — before the mutation ever runs.
 *
 * An id that ALREADY looks like a gid is passed through untouched: `id()` returns its input
 * unchanged when the tail is not numeric, so both shapes can legitimately arrive here and only one
 * of them needs building.
 */
export function toGid(resourceType: SeoResourceType, resourceId: string): string {
  const raw = resourceId.trim();
  if (raw.startsWith('gid://')) return raw;
  return `gid://shopify/${GID_TYPE[resourceType]}/${raw}`;
}

const PRODUCT_MUTATION = `
  mutation ScoreloApplyProductSeo($id: ID!, $seo: SEOInput!) {
    productUpdate(product: { id: $id, seo: $seo }) {
      product { id }
      userErrors { field message }
    }
  }
`;

const COLLECTION_MUTATION = `
  mutation ScoreloApplyCollectionSeo($id: ID!, $seo: SEOInput!) {
    collectionUpdate(input: { id: $id, seo: $seo }) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const PAGE_MUTATION = `
  mutation ScoreloApplyPageSeo($id: ID!, $metafields: [MetafieldInput!]) {
    pageUpdate(id: $id, page: { metafields: $metafields }) {
      page { id }
      userErrors { field message }
    }
  }
`;

const ARTICLE_MUTATION = `
  mutation ScoreloApplyArticleSeo($id: ID!, $metafields: [MetafieldInput!]) {
    articleUpdate(id: $id, article: { metafields: $metafields }) {
      article { id }
      userErrors { field message }
    }
  }
`;

/**
 * Alt text on one product image.
 *
 * WHY `productUpdateMedia` AND NOT `fileUpdate`. Shopify marks this one deprecated and points at
 * `fileUpdate`, which is the long-term home for media metadata. `fileUpdate` requires the
 * `write_files` access scope; `productUpdateMedia` requires `write_products`, which Rankvora AI already
 * holds and which merchants have already consented to. Moving to `fileUpdate` today would mean
 * adding a scope to the app, and Shopify issues scopes only on FRESH CONSENT — every connected
 * store would have to reconnect before a single alt text could be written. Deprecated-but-granted
 * beats current-but-unauthorized, and this is the note for whoever migrates it: when `write_files`
 * is added for another reason, or when Shopify removes this mutation, swap to
 * `fileUpdate(files: [{ id, alt }])` — the MediaImage gid below is the same id it takes.
 *
 * `mediaUserErrors`, not `userErrors`: this mutation names its error field differently from the
 * four above, and reading the wrong one would report every rejection as a success.
 */
const PRODUCT_MEDIA_MUTATION = `
  mutation ScoreloApplyImageAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { alt }
      mediaUserErrors { field message }
    }
  }
`;

/** The product an image belongs to, as a gid, or null when the stored image reference is malformed. */
function imageProductGid(resourceId: string): string | null {
  const ids = parseProductImageId(resourceId);
  return ids ? `gid://shopify/Product/${ids.productId}` : null;
}

/**
 * Writes ONE field to ONE resource, returning Shopify's own complaints rather than throwing them.
 *
 * `userErrors` is the half of a Shopify mutation that a transport-level check misses entirely: a
 * rejected value comes back as HTTP 200 with a populated `userErrors` array. Treating that as
 * success is the classic way an integration reports "applied" for a change that never happened,
 * which here would mean telling a merchant their SEO is fixed and then showing them an unchanged
 * score forever.
 */
async function writeField(
  client: ShopifyClient,
  resourceType: FixableResourceType,
  resourceId: string,
  field: FixableField,
  value: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // ── Image alt text ──────────────────────────────────────────────
  // Its own mutation, its own pair of ids, and its own error field. Handled before the SEO map
  // because none of that shape is shared with the four page-like resources below.
  if (resourceType === 'productImage') {
    const ids = parseProductImageId(resourceId);
    // Refused rather than interpolated: this id is built into a gid and sent to a live store.
    if (!ids) return { ok: false, detail: 'That image reference is not one Rankvora AI can write to.' };

    const plan = {
      query: PRODUCT_MEDIA_MUTATION,
      variables: {
        productId: `gid://shopify/Product/${ids.productId}`,
        media: [{ id: `gid://shopify/MediaImage/${ids.mediaId}`, alt: value }],
      },
      root: 'productUpdateMedia',
      errorKey: 'mediaUserErrors' as const,
    };
    return runMutation(client, plan);
  }

  const seoKey = SEO_INPUT_KEY[field];
  const metafieldKey = METAFIELD_KEY[field];

  // Any field that reaches here without a mapping has no mutation behind it. Refused explicitly
  // rather than silently no-oped, so a merchant is never told it was applied.
  if (!seoKey || !metafieldKey) {
    return { ok: false, detail: `Rankvora AI cannot yet write ${FIELD_RULES[field].label} to Shopify.` };
  }

  const metafields = [
    { namespace: SEO_METAFIELD_NAMESPACE, key: metafieldKey, value, type: SEO_METAFIELD_TYPE },
  ];

  // The stored id is the numeric suffix, not a gid — rebuilt here, or Shopify rejects the variable
  // before the mutation runs. See toGid().
  const gid = toGid(resourceType, resourceId);

  // Only the ONE key being fixed is sent. Shopify leaves an omitted SEOInput key unchanged, so a
  // description fix cannot blank a title the merchant wrote.
  const plan = {
    product: { query: PRODUCT_MUTATION, variables: { id: gid, seo: { [seoKey]: value } }, root: 'productUpdate' },
    collection: { query: COLLECTION_MUTATION, variables: { id: gid, seo: { [seoKey]: value } }, root: 'collectionUpdate' },
    page: { query: PAGE_MUTATION, variables: { id: gid, metafields }, root: 'pageUpdate' },
    article: { query: ARTICLE_MUTATION, variables: { id: gid, metafields }, root: 'articleUpdate' },
  }[resourceType];

  return runMutation(client, { ...plan, errorKey: 'userErrors' });
}

/**
 * Sends one mutation and reads Shopify's own complaints out of it.
 *
 * `errorKey` is a parameter because Shopify is not consistent about it: the four SEO mutations
 * report `userErrors`, `productUpdateMedia` reports `mediaUserErrors`. Reading the wrong key finds
 * an empty array on a rejected write and reports it as applied — the exact failure this whole
 * function exists to prevent.
 */
async function runMutation(
  client: ShopifyClient,
  plan: { query: string; variables: Record<string, unknown>; root: string; errorKey: 'userErrors' | 'mediaUserErrors' },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const data = await client.graphql<Record<string, Record<string, UserError[] | undefined> | undefined>>(
      plan.query,
      plan.variables,
    );
    const errors = data?.[plan.root]?.[plan.errorKey] ?? [];
    if (errors.length > 0) {
      // Shopify's own wording, truncated to the column. It describes the value, never a credential.
      const detail = errors.map((error) => error?.message).filter(Boolean).join('; ').slice(0, 500);
      return { ok: false, detail: detail || 'Shopify rejected the change.' };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof StoreDataError) return { ok: false, detail: error.message };
    // The transport's message only — never the request body, which carries the access token.
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 500) : 'Unknown transport error' };
  }
}

/**
 * Applies approved proposals to the store, one resource at a time.
 *
 * SEQUENTIAL, NOT PARALLEL. Every write costs Shopify calculated points against a leaky bucket the
 * client already throttles for; firing a bulk apply concurrently is the fastest way to be
 * rate-limited into partial failure, which on a write path means a half-updated catalogue.
 *
 * PARTIAL SUCCESS IS A REAL OUTCOME and is reported as one. Each proposal's fate is recorded on its
 * own row, so a bulk apply that fails on three of twenty leaves seventeen genuinely applied and
 * three marked `failed` with Shopify's reason attached — rather than an all-or-nothing rollback
 * that would have to un-write changes the merchant may already want.
 *
 * @param storeId  Resolved from the authenticated request by the caller, never from a body.
 */
export async function applyApprovedProposals(
  storeId: number,
  fixes: ApplyFixInput[],
  userId: number,
): Promise<ApplySummary> {
  // THE MERCHANT'S OWN ANSWER, CHECKED BEFORE ANYTHING ELSE. Guided setup asks whether Rankvora AI may
  // change the store, and "Never change my store" has to mean it — ahead of scopes, ahead of
  // proposal state, and ahead of any row being materialised. Nothing below may override it.
  //
  // Refused for the whole call rather than skipped per proposal: this is not "these twenty fixes
  // could not be written", it is "this store does not permit writes at all", and reporting it as
  // twenty skips would bury the one thing the merchant needs to read.
  const permission = writeIsPermitted(await automationConsentFor(storeId));
  if (!permission.allowed) {
    throw new ApiError(403, permission.reason, 'AUTOMATION_NOT_PERMITTED');
  }

  // A hand-typed value has no proposal row yet, so one is created before anything is written. This
  // runs first and separately because it is the step that can legitimately reject an entry outright
  // — a ref the audit never recorded is refused here rather than reaching Shopify.
  const { proposalIds, overrideById, rejected } = await materializeFixes(storeId, fixes, userId);

  if (proposalIds.length === 0 && rejected.length > 0) {
    return {
      applied: 0,
      failed: 0,
      skipped: rejected.length,
      results: rejected,
    };
  }
  // STORE ID IS PART OF THE PREDICATE, not a check performed after loading. A proposal belonging to
  // another store is not found at all, so this endpoint cannot be used to write to a catalogue the
  // caller does not own even with a valid proposal id.
  const rows = await loadStoreProposals(storeId, proposalIds);

  if (rows.length === 0) {
    throw new ApiError(404, 'No approved fixes were found to apply.', 'NO_PROPOSALS');
  }

  // Checked ONCE, before any write: the scopes the merchant actually consented to. A store
  // connected before write access existed carries read-only scopes, and every proposal is skipped
  // with a reason the UI can act on rather than twenty identical Shopify 403s.
  const { grantedScopes } = await getFixContext(storeId);

  // The pages the merchant told guided setup to leave alone. Almost every store has none, and then
  // nothing below costs anything; a store that has some is checked resource by resource.
  const protectedPaths = await protectedPathsFor(storeId);

  const results: ApplyResult[] = [];
  let client: ShopifyClient | null = null;
  // The rule each finding's values are judged by, read once per finding in this request.
  const fieldRules = new Map<number, FieldRule>();

  for (const row of rows) {
    const field = row.field as FixableField;
    const rule = FIELD_RULES[field];

    if (!rule) {
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'skipped', detail: 'Unknown field.' });
      continue;
    }

    // CLICKING APPLY IS THE APPROVAL, so a row still sitting at `proposed` is accepted here and
    // recorded as approved by this user below. Requiring a separate approve call first would add a
    // round-trip without adding a decision — the merchant already made it.
    //
    // `applied` is refused because it is already done; `rejected` because someone said no. Both
    // would be a second write for no change.
    if (row.status !== 'approved' && row.status !== 'proposed' && row.status !== 'failed') {
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'skipped', detail: `Cannot apply a ${row.status} fix.` });
      continue;
    }

    if (!grantedScopes.includes(rule.writeScope)) {
      results.push({
        proposalId: row.id,
        resourceRef: ref(row),
        status: 'skipped',
        detail: 'Reconnect your Shopify store to grant Rankvora AI permission to save changes.',
      });
      continue;
    }

    if (!isFixableResourceType(row.resourceType)) {
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'skipped', detail: 'Unsupported resource type.' });
      continue;
    }

    // The merchant's edit wins over the model's draft when one was sent — that is the whole point
    // of an editable preview. It gets no weaker check than the generated text: the same rule, the
    // same bounds, one line below.
    const intended = overrideById.get(row.id) ?? row.proposedValue;

    // RE-VALIDATED IMMEDIATELY BEFORE THE WRITE. The row passed these rules when it was created,
    // but a stored value is not evidence that it still passes today — bounds may have tightened
    // since, and a hand-edited value has never been checked at all. This is the last gate before a
    // live storefront.
    //
    // Against the finding's own rule: for a title, the field's bounds once the theme's suffix is
    // counted, which is what the planner drafted to and what the audit will score. The flat 30-60
    // refused a 25-character title that renders healthy behind a 30-character suffix, and passed a
    // 45-character one the next audit would flag again.
    if (!fieldRules.has(row.findingId)) fieldRules.set(row.findingId, (await fieldRuleForFinding(row.findingId, field)) ?? rule);
    const check = validateProposedValue(fieldRules.get(row.findingId) ?? rule, intended, row.currentValue);
    if (!check.ok) {
      await markFailed(row.id, check.detail);
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'failed', detail: check.detail });
      continue;
    }

    // Resolved lazily and once: a run where every proposal is skipped should not decrypt a token.
    if (!client) {
      try {
        client = await resolveShopifyClient(storeId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Could not reach Shopify.';
        throw new ApiError(502, detail, 'SHOPIFY_UNAVAILABLE');
      }
    }

    // THE PROTECTED-PAGES GATE, immediately before the write and after everything that could
    // reject the value on its own merits. Fails closed: a page whose location cannot be established
    // is not written while pages are protected. The row stays as it was, so lifting the protection
    // and applying again needs no re-approval.
    if (protectedPaths.length > 0) {
      const gid = row.resourceType === 'productImage'
        ? imageProductGid(row.resourceId)
        : toGid(row.resourceType, row.resourceId);
      const verdict = judgeProtectedPath(protectedPaths, gid ? await readResourcePath(client, gid) : null);
      if (!verdict.allowed) {
        results.push({ proposalId: row.id, resourceRef: ref(row), status: 'skipped', detail: verdict.reason });
        continue;
      }
    }

    const outcome = await writeField(client, row.resourceType, row.resourceId, field, check.value);

    if (outcome.ok) {
      // `proposedValue` is overwritten with what was ACTUALLY written, so the row is a record of
      // the change rather than of the suggestion that preceded it. Without this, a merchant who
      // edited the draft would later read the model's original wording as though it were live.
      await db
        .update(aiFixProposals)
        .set({
          status: 'applied',
          statusDetail: null,
          proposedValue: check.value,
          decidedAt: new Date(),
          decidedBy: userId,
        })
        .where(eq(aiFixProposals.id, row.id));
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'applied' });
      // The resource and the field, never the value — a log is read by more people than the
      // database is, and a proposed value can quote merchant copy.
      console.log(`[scorelo-fix] applied ${field} to ${row.resourceType} (store ${storeId})`);
    } else {
      await markFailed(row.id, outcome.detail);
      results.push({ proposalId: row.id, resourceRef: ref(row), status: 'failed', detail: outcome.detail });
      console.warn(`[scorelo-fix] failed ${field} on ${row.resourceType} (store ${storeId}): ${outcome.detail}`);
    }
  }

  return {
    applied: results.filter((result) => result.status === 'applied').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    results,
  };
}

/**
 * Turns every requested fix into a proposal id, creating rows for hand-typed values.
 *
 * WHY A MANUAL VALUE GETS A ROW AT ALL, rather than being written directly: the proposal row is the
 * record of what was changed, by whom, and to what. A fix that bypassed it would leave the
 * storefront altered with nothing in Rankvora AI to show for it — no history, no status, nothing for
 * the next audit's reader to reconcile against. Both paths converge on the same table on purpose.
 *
 * The resource and field are taken from `resolveManualTarget`, which re-derives them from the
 * finding's own evidence. Nothing about WHICH resource is written comes from the request body.
 *
 * `onConflictDoUpdate` targets `ai_fix_proposals_target_idx` (one live proposal per
 * finding+resource+field): re-typing a value for a row that was already drafted updates that row
 * rather than failing, which is exactly what a merchant editing a draft expects.
 */
async function materializeFixes(
  storeId: number,
  fixes: ApplyFixInput[],
  userId: number,
): Promise<{ proposalIds: number[]; overrideById: Map<number, string>; rejected: ApplyResult[] }> {
  const proposalIds: number[] = [];
  const overrideById = new Map<number, string>();
  const rejected: ApplyResult[] = [];

  for (const fix of fixes) {
    if (fix.proposalId !== undefined) {
      proposalIds.push(fix.proposalId);
      if (typeof fix.value === 'string') overrideById.set(fix.proposalId, fix.value);
      continue;
    }

    const target = await resolveManualTarget(userId, fix.findingId, fix.resourceRef, storeId);
    if (!target) {
      // Not found and not-part-of-this-finding are one answer, so the response cannot be used to
      // probe which resources exist on a store the caller does not own.
      rejected.push({ proposalId: 0, resourceRef: fix.resourceRef, status: 'skipped', detail: 'That resource is not part of this finding.' });
      continue;
    }

    const [written] = await db
      .insert(aiFixProposals)
      .values({
        findingId: fix.findingId,
        storeId,
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        field: target.rule.field,
        currentValue: target.currentValue,
        proposedValue: fix.value,
        // Named honestly. This is the merchant's own wording, and `aiModel` stays null so the row
        // never implies a model wrote something a person typed.
        reason: 'Written by the merchant.',
        status: 'approved',
        decidedAt: new Date(),
        decidedBy: userId,
      })
      .onConflictDoUpdate({
        target: [aiFixProposals.findingId, aiFixProposals.resourceType, aiFixProposals.resourceId, aiFixProposals.field],
        set: {
          proposedValue: fix.value,
          currentValue: target.currentValue,
          reason: 'Written by the merchant.',
          status: 'approved',
          statusDetail: null,
          decidedAt: new Date(),
          decidedBy: userId,
        },
      })
      // The row's id whether it was inserted or the existing draft was updated — the same statement
      // reports it, so editing an existing draft applies that draft.
      .returning({ id: aiFixProposals.id });

    const id = written?.id ?? 0;
    if (!id) {
      rejected.push({ proposalId: 0, resourceRef: fix.resourceRef, status: 'failed', detail: 'Could not record this change.' });
      continue;
    }

    proposalIds.push(id);
    overrideById.set(id, fix.value);
  }

  return { proposalIds, overrideById, rejected };
}

/** Records why a write did not happen, so the UI can show a reason instead of a silent failure. */
async function markFailed(proposalId: number, detail: string): Promise<void> {
  await db
    .update(aiFixProposals)
    .set({ status: 'failed', statusDetail: detail.slice(0, 500) })
    .where(eq(aiFixProposals.id, proposalId));
}

/**
 * The proposals with these ids that belong to this store. The store is part of the predicate, so a
 * proposal of another store is simply not found.
 *
 * The ids go in pieces because D1 takes at most 100 bound values in a statement, and the store id
 * is bound beside them; a request may name 100 fixes.
 */
export async function loadStoreProposals(storeId: number, proposalIds: number[]): Promise<Array<typeof aiFixProposals.$inferSelect>> {
  const rows: Array<typeof aiFixProposals.$inferSelect> = [];
  for (const piece of chunkForD1(proposalIds)) {
    rows.push(...await db.select().from(aiFixProposals).where(and(eq(aiFixProposals.storeId, storeId), inArray(aiFixProposals.id, piece))));
  }
  return rows;
}
