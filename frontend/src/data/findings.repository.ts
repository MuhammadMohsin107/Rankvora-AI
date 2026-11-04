import { api } from '../lib/api';
import { hiddenPillarKeys, isPillarVisible, visiblePillarRows } from '../config/modules';
import type { FindingRow } from './api.types';
import type { PillarKey } from './dashboard/dashboard.types';
import { pillarList } from './pillarMeta';

interface FindingsPage {
  items: FindingRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** The API caps `limit` at 100 (findingListQuerySchema), so one request cannot be assumed to
 * return everything. */
const PAGE_SIZE = 100;
/** Refuses to loop forever if the API ever reports an inconsistent totalPages. */
const MAX_PAGES = 50;

/**
 * EVERY finding for the latest audit, as the API's rows, ordered as the API orders them: severity,
 * then how many items each affects.
 *
 * Pages are followed to completion: one `?limit=100` request silently lost everything past the
 * first hundred on a large store.
 */
export async function fetchFindingRows(filter: { pillar?: PillarKey } = {}): Promise<FindingRow[]> {
  // A pillar switched off in config/modules.ts has no findings for the customer: asking for it by
  // name returns nothing, and the unscoped set below has its rows dropped. Every reader of findings
  // — the dashboard, the catalog's "moves" — comes through here.
  if (filter.pillar && !isPillarVisible(filter.pillar)) return [];
  const scope = filter.pillar ? `pillar=${encodeURIComponent(filter.pillar)}&` : '';
  const first = await api.get<FindingsPage>(`/findings?${scope}limit=${PAGE_SIZE}&page=1`);
  const rows = [...first.items];

  const totalPages = Math.min(first.pagination?.totalPages ?? 1, MAX_PAGES);
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await api.get<FindingsPage>(`/findings?${scope}limit=${PAGE_SIZE}&page=${page}`);
    if (next.items.length === 0) break;
    rows.push(...next.items);
  }

  return visiblePillarRows(rows);
}

/**
 * The finding queries to make so that a hidden pillar is never counted or listed.
 *
 * Counts and capped searches cannot be filtered after the fact — the server's total and its page
 * limit include the hidden pillar's rows — so they are asked per visible pillar instead and added
 * up. With nothing hidden this is one unscoped query, exactly as before. Returned as the `pillar=`
 * parameters to add to the query string ('' means unscoped).
 */
export function findingPillarScopes(): string[] {
  if (hiddenPillarKeys().length === 0) return [''];
  return pillarList.map((pillar) => `&pillar=${encodeURIComponent(pillar.key)}`);
}

/**
 * An issue is something the audit FOUND in the store and that is still outstanding.
 *
 * Resolved and ignored findings are the merchant's own bookkeeping, not open problems. A note that
 * something could not be read ("the agent-readable files could not be checked") is recorded as a
 * finding so its evidence rows have an owner, but it says nothing about the store — counting it as
 * an issue would inflate the total with Rankvora AI's own blind spots.
 */
export function isOutstandingStoreIssue(finding: FindingRow): boolean {
  return (finding.status === 'open' || finding.status === 'reviewed') && finding.details?.notChecked !== true;
}

// ─── Optional AI enhancement ─────────────────────────────────────────

export interface AiRecommendation {
  recommendation: string;
  whyItMatters: string;
  suggestedAction: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AiRecommendationResult {
  findingId: number;
  /** The deterministic recommendation — always present, whatever happened with AI. */
  recommendation: string;
  enhanced: boolean;
  ai: AiRecommendation | null;
  model: string | null;
  generatedAt: string | null;
  cached: boolean;
  unavailableReason?: 'disabled' | 'unavailable';
}

/**
 * Requests an AI-enhanced version of one finding's recommendation.
 *
 * Explicitly user-triggered, never called on render: the backend caches the result on the
 * finding, so this is one model call per finding for the life of that audit. The response
 * always carries the deterministic recommendation, so a caller can render the result whether
 * or not AI was available.
 */
export function fetchAiRecommendation(findingId: string, force = false): Promise<AiRecommendationResult> {
  return api.post<AiRecommendationResult>(`/findings/${findingId}/ai-recommendation`, { force });
}

/** Whether the SERVER can attempt AI — used to hide the action rather than offer something that
 * is guaranteed to fail. Returns capability only; the API key never leaves the backend. */
export function fetchAiStatus(): Promise<{ enabled: boolean; model: string | null }> {
  return api.get<{ enabled: boolean; model: string | null }>('/findings/ai-status');
}

// ─── AI fix planning ─────────────────────────────────────────────────
// The model drafts a VALUE for an allow-listed field on resources the audit itself flagged. It
// never reaches Shopify: every proposal is validated server-side against fix-policy.ts and parked
// as a suggestion until a person approves it.

export interface AiFixProposal {
  id: number;
  findingId: number;
  resourceType: string;
  resourceId: string;
  field: string;
  currentValue: string;
  proposedValue: string;
  /** The deterministic engine's own suggestion, when it had one. */
  deterministicValue: string | null;
  reason: string;
  status: string;
  statusDetail: string | null;
  model: string | null;
}

export interface PlanAiFixesResult {
  findingId: number;
  planned: boolean;
  proposals: AiFixProposal[];
  /** Resources the model returned nothing usable for, each with the validation reason. */
  skipped: Array<{ resourceType: string; resourceId: string; reason: string }>;
  model: string | null;
  /** `not_configured` = the server has no model provider credentials, which is a different
   * problem from a provider that failed. See noticeFor() in BulkFixWorkflow. */
  unavailableReason?: 'disabled' | 'not_configured' | 'unavailable' | 'not_fixable' | 'nothing_to_fix';
  /**
   * What the model wrote each item from, by ref: 'store' when that item's current content was read
   * live from Shopify for this draft, 'audit' when the read did not return it and the audit's own
   * record was used. Absent when no model was asked.
   */
  contentSourceByRef?: Record<string, 'store' | 'audit'>;
}

/**
 * Every proposal the server holds for one finding — drafted, applied, refused or failed. Read when
 * an item is opened, so a draft already written for it is shown rather than paid for again, and a
 * value already saved to the store is shown as saved.
 */
export function fetchAiFixProposals(findingId: string): Promise<AiFixProposal[]> {
  return api.get<AiFixProposal[]>(`/findings/${findingId}/ai-fix-proposals`);
}

/**
 * Asks the model to draft values for specific affected resources of one finding.
 *
 * `resourceIds` are the evidence-row refs (`product:123`) the merchant selected. Anything outside
 * the finding's own evidence is ignored by the backend — that is the authorization anchor, not a
 * convenience.
 */
export function planAiFixes(findingId: string, resourceIds: string[]): Promise<PlanAiFixesResult> {
  return api.post<PlanAiFixesResult>(`/findings/${findingId}/ai-fix-plan`, { resourceIds });
}

/** What one resource's write actually did. */
export interface ApplyFixResult {
  proposalId: number;
  /** The evidence-row ref this outcome belongs to — how a result is matched back to its row. */
  resourceRef: string;
  status: 'applied' | 'failed' | 'skipped';
  /** Why it failed or was skipped — Shopify's own wording, or the reason it was refused. */
  detail?: string;
}

export interface ApplyFixesResult {
  applied: number;
  failed: number;
  skipped: number;
  results: ApplyFixResult[];
  /**
   * Whether a fresh audit was queued. `audit_scores` is written only by the audit runner, so
   * without a run the score cannot move however many resources were written.
   */
  reaudit: 'queued' | 'already-running' | 'not-needed' | 'failed';
  /** The re-audit job queued by this apply, when one was — so the app can follow it to completion. */
  reauditJobId?: number | null;
}

/**
 * Writes fixes to the merchant's live Shopify store, then queues a re-audit.
 *
 * THIS IS THE ONLY CALL IN THE APP THAT CHANGES A STOREFRONT. The proposal id decides which
 * resource and which field — the server re-reads both from the stored row, so this request cannot
 * aim a write anywhere the audit did not already find. `value` is optional and carries the
 * merchant's EDITED text when they changed the draft; the server validates it against the same
 * length and content rules the model's own value had to pass.
 */
export type ApplyFixInput =
  /** An AI-drafted row: the proposal exists, `value` carries any edit the merchant made to it. */
  | { proposalId: number; value?: string }
  /**
   * A row the merchant wrote themselves and never drafted, so no proposal exists yet.
   *
   * `findingId` + `resourceRef` are the authorization: the server re-derives that finding's own
   * evidence rows and refuses a ref that is not among them — the same anchor AI planning uses. It
   * creates the proposal, then writes it, so a hand-typed value reaches Shopify by exactly the
   * same path as a drafted one.
   */
  | { findingId: number; resourceRef: string; value: string };

export function applyFixes(fixes: ApplyFixInput[]): Promise<ApplyFixesResult> {
  return api.post<ApplyFixesResult>('/ai-fixes/apply', { fixes });
}

/** Whether AI fix PLANNING is possible, and which sub-pillars it covers. */
/** A field Rankvora AI can write, with the bounds the server validates a value against. */
export interface FixFieldInfo {
  subPillar: string;
  field: string;
  label: string;
  minLength: number;
  maxLength: number;
  /** 'ai' drafts with a model; 'template' fills the merchant's own pattern, with no model. */
  generator: 'ai' | 'template';
}

export interface AiFixStatus {
  enabled: boolean;
  model: string | null;
  fixableSubPillars: string[];
  /** Absent on a server older than this field; an editor then shows no bounds and lets the server judge. */
  fields?: FixFieldInfo[];
  /** How many items one drafting request covers. More are drafted in several requests. */
  maxTargetsPerRequest?: number;
}

export function fetchAiFixStatus(): Promise<AiFixStatus> {
  return api.get<AiFixStatus>('/findings/ai-fix-status');
}
