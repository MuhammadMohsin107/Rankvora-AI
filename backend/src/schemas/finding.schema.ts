import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

const statusSchema = z.enum(['open', 'reviewed', 'resolved', 'ignored']);
const severitySchema = z.enum(['critical', 'high', 'medium', 'low']);
const pillarSchema = z.enum(['seo', 'content', 'speed', 'cro', 'ai-discovery']);

export const findingListQuerySchema = z.object({
  pillar: pillarSchema.optional(),
  subPillar: z.string().trim().min(1).max(120).optional(),
  status: statusSchema.optional(),
  severity: severitySchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  ...storeIdQueryShape,
}).strict();

export const findingIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export const updateFindingStatusSchema = z.object({
  status: statusSchema,
}).strict();

/** `force` re-generates instead of serving the cached text — the only way to spend again on a
 * finding that already has AI output, so it must be explicit. */
export const aiRecommendationSchema = z.object({
  force: z.boolean().optional(),
}).strict();

export const bulkFindingStatusSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(100),
  status: statusSchema,
}).strict();

export type FindingListQuery = z.infer<typeof findingListQuerySchema>;
export type UpdateFindingStatusInput = z.infer<typeof updateFindingStatusSchema>;
export type AiRecommendationInput = z.infer<typeof aiRecommendationSchema>;
export type BulkFindingStatusInput = z.infer<typeof bulkFindingStatusSchema>;

// ─── AI fix planning ─────────────────────────────────────────────────

/** Resource refs are `type:id` as written by the audit's own evidence rows. Constrained here so a
 * malformed ref is rejected at the edge rather than inside the planner.
 *
 * The second form is one product image, `productImage:<productId>/<mediaId>` (fix-policy.ts,
 * productImageRef). Without it every alt-text ref was refused here with a 400 before the template
 * could be filled, so "Fill from template" on alt text could never succeed. Digits only, as
 * parseProductImageId requires. */
const resourceRefSchema = z
  .string()
  .trim()
  .regex(/^(?:[a-z]+:[A-Za-z0-9_-]+|productImage:\d+\/\d+)$/, 'Invalid resource reference')
  .max(96);

export const planAiFixesSchema = z.object({
  /** Narrow planning to specific affected resources. Omit to plan for everything the finding
   * flagged, up to the planner's own per-request cap. */
  resourceIds: z.array(resourceRefSchema).min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(15).optional(),
}).strict();

export const bulkPlanAiFixesSchema = z.object({
  findingIds: z.array(z.coerce.number().int().positive()).min(1).max(25),
}).strict();

export const fixProposalIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export const decideFixProposalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict();

/**
 * Writing fixes to the merchant's Shopify store.
 *
 * WHAT THE CALLER MAY AND MAY NOT CHOOSE. The proposal id selects WHICH resource and WHICH field is
 * written — both re-read from the stored row, never from the request, because those two are the
 * authorization: the row exists only because the audit found that resource on this merchant's own
 * store. A body cannot aim a write at a resource the audit never saw.
 *
 * `value` is the one thing the caller may supply, and it is optional. It exists because the preview
 * screen lets a merchant EDIT the drafted text before applying, and a fix flow that silently wrote
 * the model's wording instead of the human's correction would be worse than useless. When present
 * it replaces the stored value — after passing the same `validateProposedValue` bounds the AI's own
 * text had to pass, so a hand-typed value gets no weaker check than a generated one.
 *
 * The 2000 cap is a parser bound, not the policy: the real per-field limits live in FIELD_RULES
 * (60 for a title, 160 for a description) and are enforced server-side at apply time.
 *
 * The 100 cap matches the decision endpoints and keeps one request inside Shopify's rate budget.
 */
export const applyFixProposalsSchema = z.object({
  fixes: z.array(z.object({
    /** An existing proposal (the AI-drafted path). */
    proposalId: z.coerce.number().int().positive().optional(),
    /**
     * The manual path: a value the merchant typed for a resource that was never drafted.
     *
     * `findingId` + `resourceRef` are the authorization, not a convenience — the server re-derives
     * the finding's own evidence rows and refuses a ref that is not among them, exactly as AI
     * planning does. Without this pair a hand-written value had no way to reach Shopify at all,
     * which made "write it yourself" a dead end in a feature built around the merchant's wording.
     */
    findingId: z.coerce.number().int().positive().optional(),
    /** An evidence-row ref, e.g. `product:123`. */
    resourceRef: z.string().trim().min(1).max(200).optional(),
    value: z.string().trim().min(1).max(2000).optional(),
  }).strict().refine(
    // Exactly one shape per entry. A body carrying both is ambiguous about which resource it means,
    // and guessing between them is the kind of shortcut that turns into writing the wrong thing.
    (entry) => (entry.proposalId !== undefined) !== (entry.findingId !== undefined && entry.resourceRef !== undefined),
    { message: 'Provide either proposalId, or findingId with resourceRef' },
  ).refine(
    // A manual entry has nothing to write without its text; a proposal entry can fall back to the
    // value already stored on the row.
    (entry) => entry.proposalId !== undefined || typeof entry.value === 'string',
    { message: 'A manual fix needs a value', path: ['value'] },
  )).min(1).max(100),
}).strict();

/** Approving several previewed proposals in one request — what the Fix Center preview submits. */
export const bulkDecideFixProposalsSchema = z.object({
  approve: z.array(z.coerce.number().int().positive()).max(100).optional(),
  reject: z.array(z.coerce.number().int().positive()).max(100).optional(),
}).strict().refine(
  (value) => (value.approve?.length ?? 0) + (value.reject?.length ?? 0) > 0,
  { message: 'Provide at least one proposal to approve or reject' },
);
