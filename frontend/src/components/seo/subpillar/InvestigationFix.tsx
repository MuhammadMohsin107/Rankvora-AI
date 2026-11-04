import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, PencilLine, RefreshCw, Sparkles, Store, Wand2 } from 'lucide-react';
import type { EvidenceRow, SubPillarFinding } from '../../../data/seo/subpillar.model';
import {
  applyFixes,
  fetchAiFixProposals,
  fetchAiFixStatus,
  planAiFixes,
  type AiFixProposal,
  type AiFixStatus,
  type ApplyFixesResult,
  type FixFieldInfo,
  type PlanAiFixesResult,
} from '../../../data/findings.repository';
import { followAuditRun } from '../../../data/useAuditRun';
import { titleFieldBounds } from '../../../data/fixBounds';
import { ApiError } from '../../../lib/api';

/**
 * ─── The fix itself, for the item being investigated ─────────────────────────────────────────
 *
 * Investigate used to end in advice: "write a 70-160 character description". This writes the
 * description. It is the bulk fix's machinery pointed at one item, not a second implementation:
 *
 *   draft   POST /findings/:id/ai-fix-plan, for this item's ref — the same planner the bulk fix
 *           calls. The server reads the item's current content live from Shopify, has the
 *           configured model write the field from it, and checks the value against the field's own
 *           rules before it comes back. An image's alt text is filled from the merchant's template
 *           instead, with no model, exactly as the bulk fix does.
 *   apply   POST /ai-fixes/apply — the one call that writes to a store. The server re-validates the
 *           value, writes it through Shopify's own mutation, and reports applied only when Shopify
 *           accepted it. A value the merchant typed goes the same way, anchored to this finding.
 *
 * Nothing on this card is invented. A draft is what the server returned; a reason a draft is
 * missing is the server's own; "saved" is shown only for a write Shopify confirmed.
 */

// ─── What can be fixed here ──────────────────────────────────────────

let statusRequest: Promise<AiFixStatus> | null = null;

/** The server's fix capabilities, asked once per session. A failed ask is retried next time. */
function loadFixStatus(): Promise<AiFixStatus> {
  statusRequest ??= fetchAiFixStatus().catch((error) => {
    statusRequest = null;
    throw error;
  });
  return statusRequest;
}

export interface FixCapability {
  field: FixFieldInfo;
  /** Whether a model is configured. A template field does not need one. */
  aiEnabled: boolean;
  model: string | null;
}

/**
 * Whether this sub-pillar's findings can be fixed from here, and how. `undefined` while the server
 * is being asked; `null` when they cannot (or the server could not say — no fix is then offered).
 */
export function useFixCapability(subPillar: string | undefined): FixCapability | null | undefined {
  const [capability, setCapability] = useState<FixCapability | null | undefined>(undefined);
  useEffect(() => {
    if (!subPillar) { setCapability(null); return undefined; }
    let live = true;
    setCapability(undefined);
    loadFixStatus()
      .then((status) => {
        if (!live) return;
        const field = status.fields?.find((candidate) => candidate.subPillar === subPillar);
        setCapability(field ? { field, aiEnabled: status.enabled, model: status.model } : null);
      })
      .catch(() => { if (live) setCapability(null); });
    return () => { live = false; };
  }, [subPillar]);
  return capability;
}

// ─── One item's fix ──────────────────────────────────────────────────

interface ItemFix {
  phase: 'idle' | 'generating' | 'draft' | 'unavailable' | 'applied';
  /** The stored proposal the draft lives in; what "Apply with AI" saves. */
  proposalId: number | null;
  draft: string;
  /** The model's own one-line account of what it changed. */
  reason: string | null;
  model: string | null;
  /** Where the draft was written from — the store, read now, or the audit's record. */
  source: 'store' | 'audit' | 'earlier' | 'template' | null;
  /** Why there is no draft, in the server's words. */
  message: string | null;
  mode: 'view' | 'edit' | 'manual';
  text: string;
  saving: boolean;
  saveError: string | null;
  appliedValue: string | null;
  /** What happens next after a save — the re-audit — said once. */
  savedNote: string | null;
}

const EMPTY: ItemFix = {
  phase: 'idle', proposalId: null, draft: '', reason: null, model: null, source: null, message: null,
  mode: 'view', text: '', saving: false, saveError: null, appliedValue: null, savedNote: null,
};

/** A value as the server holds it: runs of whitespace collapsed to one space, trimmed. */
const normalizeValue = (value: string): string => value.replace(/\s+/g, ' ').trim();

const refOf = (proposal: Pick<AiFixProposal, 'resourceType' | 'resourceId'>) => `${proposal.resourceType}:${proposal.resourceId}`;

/** Drafts written automatically when an item is opened. More than this waits for a click. */
const AUTO_GENERATE_LIMIT = 5;

const UNAVAILABLE_TEXT: Record<string, string> = {
  disabled: 'AI drafting is turned off on this server. Write the value yourself below.',
  not_configured: 'AI drafting is not set up on this server yet — no model provider is configured. Write the value yourself below.',
  off: 'AI drafting is not available on this server right now. Write the value yourself below.',
  none: 'Rankvora AI did not write a value for this item. Try again, or write one yourself.',
  unavailable: 'The AI service could not draft this right now. Try again, or write the value yourself.',
  not_fixable: 'Rankvora AI cannot write a value for this issue.',
  nothing_to_fix: 'There is nothing to fix for this item in the latest analysis.',
};

const REAUDIT_TEXT: Record<ApplyFixesResult['reaudit'], string> = {
  queued: 'Rankvora AI is re-analyzing your store to confirm the fix — progress is shown at the top of the page.',
  'already-running': 'An analysis was already running when this was saved. Press Re-analyze when it finishes to confirm the fix.',
  'not-needed': '',
  failed: 'Press Re-analyze to update your scores with this change.',
};

function rowName(row: EvidenceRow): string {
  const name = row.cells.name;
  return typeof name === 'string' && name.trim() ? name : row.current?.meta?.split(' · ')[0] ?? row.id;
}

function rowPath(row: EvidenceRow): string | null {
  const path = row.cells.path ?? row.cells.url;
  return typeof path === 'string' && path.trim() ? path : null;
}

/** "product", "page" — what the item is, for sentences about it. */
function nounOf(row: EvidenceRow): string {
  return (row.unit ?? row.facet ?? 'page').toLowerCase();
}

interface Props {
  finding: SubPillarFinding;
  rows: EvidenceRow[];
  capability: FixCapability;
  /** Draft as soon as the panel opens — true when the merchant opened specific items. */
  autoGenerate: boolean;
  /** Characters the theme appends to every rendered title, as the audit measured them. */
  titleSuffixLength?: number;
  /** Told about a value Shopify confirmed, so the page can show it. */
  onApplied?: (rowId: string, value: string) => void;
}

export default function InvestigationFix({ finding, rows, capability, autoGenerate, titleSuffixLength = 0, onApplied }: Props) {
  const { field, aiEnabled, model: serverModel } = capability;
  const fromTemplate = field.generator === 'template';
  const canDraft = fromTemplate || aiEnabled;

  // A title is scored as rendered — the field plus what the theme appends — so BOTH ends of the
  // field's range move with the suffix, exactly as the server judges it (data/fixBounds.ts).
  const { minLength, maxLength } = field.field === 'seo.title'
    ? titleFieldBounds(field.minLength, field.maxLength, titleSuffixLength)
    : { minLength: field.minLength, maxLength: field.maxLength };

  const [items, setItems] = useState<Record<string, ItemFix>>(() => Object.fromEntries(rows.map((row) => [row.id, EMPTY])));
  const [loadingEarlier, setLoadingEarlier] = useState(true);
  const inFlight = useRef(new Set<string>());

  const patch = useCallback((rowId: string, change: Partial<ItemFix>) => {
    setItems((current) => ({ ...current, [rowId]: { ...(current[rowId] ?? EMPTY), ...change } }));
  }, []);

  const words = fromTemplate
    ? { section: 'Fix from your template', generate: 'Fill from template', apply: 'Apply', again: 'Fill again' }
    : { section: 'AI fix', generate: 'Generate fix with AI', apply: 'Apply with AI', again: 'Regenerate' };

  /** Asks the planner for the given items, in one request, and files each answer on its card. */
  const generate = useCallback(async (rowIds: string[]) => {
    const wanted = rowIds.filter((id) => !inFlight.current.has(id));
    if (wanted.length === 0) return;
    wanted.forEach((id) => inFlight.current.add(id));
    setItems((current) => {
      const next = { ...current };
      for (const id of wanted) next[id] = { ...(next[id] ?? EMPTY), phase: 'generating', message: null, saveError: null, mode: 'view' };
      return next;
    });

    let result: PlanAiFixesResult | null = null;
    let failure: string | null = null;
    try {
      result = await planAiFixes(finding.id, wanted);
    } catch (error) {
      failure = error instanceof ApiError && [400, 403, 404, 409, 429].includes(error.status)
        ? error.message
        : UNAVAILABLE_TEXT.unavailable;
    } finally {
      wanted.forEach((id) => inFlight.current.delete(id));
    }

    setItems((current) => {
      const next = { ...current };
      for (const id of wanted) {
        const base = next[id] ?? EMPTY;
        if (!result) { next[id] = { ...base, phase: 'unavailable', message: failure }; continue; }
        // A reason for THIS item wins over any draft the finding still holds for it from before.
        const skipped = result.skipped.find((entry) => `${entry.resourceType}:${entry.resourceId}` === id);
        const proposal = skipped ? undefined : result.proposals.find((entry) => refOf(entry) === id);
        if (proposal) {
          next[id] = {
            ...base,
            phase: 'draft',
            proposalId: proposal.id,
            draft: proposal.proposedValue,
            reason: proposal.reason,
            model: proposal.model,
            source: fromTemplate ? 'template' : result.contentSourceByRef?.[id] ?? null,
            message: null,
          };
        } else {
          next[id] = {
            ...base,
            phase: 'unavailable',
            message: skipped?.reason
              ?? (result.unavailableReason && result.unavailableReason !== 'nothing_to_fix' ? UNAVAILABLE_TEXT[result.unavailableReason] : null)
              ?? UNAVAILABLE_TEXT.none,
          };
        }
      }
      return next;
    });
  }, [finding.id, fromTemplate]);

  // On open: show what the server already holds for these items — a draft written earlier, or a
  // value already saved — and only then draft the ones that have nothing, so opening an item twice
  // does not pay for the same draft twice.
  useEffect(() => {
    let live = true;
    setLoadingEarlier(true);
    fetchAiFixProposals(finding.id)
      .catch(() => [] as AiFixProposal[])
      .then((proposals) => {
        if (!live) return;
        const missing: string[] = [];
        setItems((current) => {
          const next = { ...current };
          for (const row of rows) {
            const held = proposals.find((proposal) => refOf(proposal) === row.id && proposal.field === field.field);
            if (held?.status === 'applied') {
              next[row.id] = { ...EMPTY, phase: 'applied', appliedValue: held.proposedValue, savedNote: 'Saved to your store from Rankvora AI.' };
            } else if (held?.status === 'proposed') {
              next[row.id] = {
                ...EMPTY, phase: 'draft', proposalId: held.id, draft: held.proposedValue, reason: held.reason, model: held.model,
                source: fromTemplate ? 'template' : 'earlier',
              };
            } else {
              missing.push(row.id);
            }
          }
          return next;
        });
        setLoadingEarlier(false);
        if (autoGenerate && canDraft && missing.length > 0) void generate(missing.slice(0, AUTO_GENERATE_LIMIT));
      });
    return () => { live = false; };
    // Once per opening: the drawer remounts this panel for each item it is opened on.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Checks a value the merchant typed the way the server will: on one line, with runs of spaces
   * collapsed, measured and compared to the current value after that. The server remains the judge
   * (and re-checks, for markup and placeholder wording); this only stops Apply being offered for a
   * value it is certain to refuse.
   */
  const problemWith = (row: EvidenceRow, value: string): string | null => {
    const normalized = normalizeValue(value);
    if (!normalized) return `Write the ${field.label.toLowerCase()} first.`;
    if (/[\r\n]/.test(value)) return 'Keep it to a single line — a meta tag cannot carry line breaks.';
    if (normalized.length < minLength) return `${normalized.length} characters — at least ${minLength} are needed.`;
    if (normalized.length > maxLength) return `${normalized.length} characters — keep it to ${maxLength} or fewer.`;
    if (normalized === normalizeValue(row.current?.value ?? '')) return 'This is the same as the current value.';
    return null;
  };

  /** Saves one value to the store through the apply endpoint, and shows only what Shopify confirmed. */
  const save = async (row: EvidenceRow, value: string, viaProposal: number | null) => {
    const trimmed = normalizeValue(value);
    patch(row.id, { saving: true, saveError: null });
    try {
      const result = await applyFixes([
        viaProposal !== null
          ? { proposalId: viaProposal, value: trimmed }
          : { findingId: Number(finding.id), resourceRef: row.id, value: trimmed },
      ]);
      const outcome = result.results.find((entry) => entry.resourceRef === row.id);
      if (outcome?.status === 'applied') {
        patch(row.id, { phase: 'applied', saving: false, mode: 'view', appliedValue: trimmed, savedNote: REAUDIT_TEXT[result.reaudit] || null });
        if (result.reauditJobId) followAuditRun(result.reauditJobId);
        onApplied?.(row.id, trimmed);
      } else {
        patch(row.id, { saving: false, saveError: outcome?.detail ?? 'Your store did not accept this change. Nothing was saved.' });
      }
    } catch (error) {
      patch(row.id, {
        saving: false,
        saveError: error instanceof ApiError && [400, 403, 409, 429, 502].includes(error.status)
          ? error.message
          : 'Rankvora AI could not save this to your store. Nothing was changed — please try again.',
      });
    }
  };

  // Only items that are free to be drafted: one being typed into or saved is not drafted over.
  const idleIds = rows
    .filter((row) => {
      const item = items[row.id] ?? EMPTY;
      return item.phase === 'idle' && item.mode === 'view' && !item.saving;
    })
    .map((row) => row.id);
  const anyGenerating = rows.some((row) => (items[row.id] ?? EMPTY).phase === 'generating');

  return (
    <div className="space-y-2">
      {canDraft && !loadingEarlier && idleIds.length > 1 && !anyGenerating && (
        // Opened from the findings list there is no chosen item, so nothing is drafted until asked.
        <button type="button" onClick={() => void generate(idleIds.slice(0, AUTO_GENERATE_LIMIT))} className="btn-primary btn-xs">
          {fromTemplate ? <Wand2 size={12} aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
          {`${words.generate} for ${Math.min(idleIds.length, AUTO_GENERATE_LIMIT)} items`}
        </button>
      )}
      {!canDraft && (
        <p className="rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] leading-[1.45] text-surface-600 ring-1 ring-inset ring-surface-200">
          {UNAVAILABLE_TEXT.off}
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((row) => {
          const item = items[row.id] ?? EMPTY;
          const path = rowPath(row);
          const noun = nounOf(row);
          const current = row.current?.value ?? '';
          const editing = item.mode === 'edit' || item.mode === 'manual';
          const textProblem = editing ? problemWith(row, item.text) : null;
          const draftProblem = item.phase === 'draft' ? problemWith(row, item.draft) : null;
          const length = normalizeValue(item.text).length;

          return (
            <li key={row.id} className="rounded-lg border border-surface-200 bg-surface-0 p-2.5 shadow-sm">
              <p className="truncate text-[12.5px] font-semibold text-surface-900" title={rowName(row)}>{rowName(row)}</p>
              {path && <p className="truncate font-mono text-[10.5px] text-surface-500">{path}</p>}

              {/* ── Current ── */}
              <div className="mt-2 rounded-md bg-surface-50 px-2.5 py-2 ring-1 ring-inset ring-surface-200">
                <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">{row.current?.label ?? `Current ${field.label.toLowerCase()}`}</p>
                <p className={`mt-0.5 text-[12px] leading-[1.45] ${current ? 'text-surface-800' : 'italic text-surface-400'}`}>{current || 'Not set in Shopify'}</p>
                {current && <p className="mt-0.5 text-[10.5px] tabular-nums text-surface-400">{current.length} characters</p>}
              </div>

              {/* ── The fix ── */}
              <div className="mt-2 rounded-md border border-brand-200 bg-brand-50/50 px-2.5 py-2">
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-brand-700">
                  {fromTemplate ? <Wand2 size={11} aria-hidden="true" /> : <Sparkles size={11} aria-hidden="true" />}
                  {item.phase === 'applied' ? 'Saved to your store' : item.mode === 'manual' ? `Your ${field.label.toLowerCase()}` : words.section}
                  {item.phase === 'draft' && item.mode === 'view' && (item.model ?? serverModel) && !fromTemplate && (
                    <span className="ml-auto font-medium normal-case tracking-normal text-surface-500">{item.model ?? serverModel}</span>
                  )}
                </p>

                {loadingEarlier && item.phase === 'idle' && (
                  <p className="mt-1 text-[11.5px] text-surface-500">Checking for a fix already written for this {noun}…</p>
                )}

                {item.phase === 'generating' && (
                  <div className="mt-1.5 flex items-start gap-2" role="status" aria-live="polite">
                    <Loader2 size={14} className="mt-0.5 flex-shrink-0 animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden="true" />
                    <p className="text-[11.5px] leading-[1.45] text-brand-800">
                      {fromTemplate
                        ? `Filling the alt-text template with this ${noun}'s own details…`
                        : `Reading this ${noun}'s current content from your store and writing an optimized ${field.label.toLowerCase()} for it…`}
                    </p>
                  </div>
                )}

                {item.phase === 'unavailable' && item.mode === 'view' && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-[1.45] text-warning-700">
                    <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    {item.message}
                  </p>
                )}

                {item.phase === 'idle' && !loadingEarlier && item.mode === 'view' && (
                  <p className="mt-1 text-[11.5px] text-surface-500">
                    {canDraft ? `No fix written yet for this ${noun}.` : 'Write the value yourself below.'}
                  </p>
                )}

                {item.phase === 'draft' && item.mode === 'view' && (
                  <>
                    <p className="mt-1 text-[12.5px] leading-[1.5] text-surface-900">{item.draft}</p>
                    {/* Checked against the range in force NOW: a draft kept from earlier may have been
                        written for different bounds. */}
                    <p className={`mt-1 text-[10.5px] tabular-nums ${draftProblem ? 'text-warning-700' : 'text-success-700'}`}>
                      {draftProblem ?? `${normalizeValue(item.draft).length} characters · within ${minLength}–${maxLength}`}
                    </p>
                    {item.reason && <p className="mt-1 text-[11px] leading-[1.45] text-surface-600">{item.reason}</p>}
                    <p className={`mt-1 items-center gap-1 text-[10.5px] text-surface-500 ${item.source === 'template' || item.source === null ? 'hidden' : 'flex'}`}>
                      <Store size={11} aria-hidden="true" />
                      {item.source === 'store' && `Written from this ${noun}'s current content in your store.`}
                      {item.source === 'audit' && `Written from your last analysis — your store could not be read just now.`}
                      {item.source === 'earlier' && 'Drafted earlier for this item. Regenerate for a fresh one.'}
                    </p>
                  </>
                )}

                {item.phase === 'applied' && item.mode === 'view' && (
                  <>
                    <p className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-surface-900">
                      <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-success-600" aria-hidden="true" />
                      {item.appliedValue}
                    </p>
                    {item.savedNote && <p className="mt-1 text-[10.5px] leading-[1.45] text-surface-500">{item.savedNote}</p>}
                  </>
                )}

                {/* ── Editing: the draft, or the merchant's own words ── */}
                {editing && (
                  <div className="mt-1.5">
                    <label htmlFor={`fix-${row.id}`} className="sr-only">{field.label}</label>
                    <textarea
                      id={`fix-${row.id}`}
                      rows={3}
                      value={item.text}
                      onChange={(event) => patch(row.id, { text: event.target.value, saveError: null })}
                      disabled={item.saving}
                      placeholder={item.mode === 'manual' ? `Write the ${field.label.toLowerCase()} for this ${noun}` : undefined}
                      className="w-full resize-y rounded-md border border-surface-200 bg-surface-0 px-2.5 py-1.5 text-[12.5px] leading-[1.5] text-surface-900 outline-none placeholder:text-surface-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                    />
                    <p className={`mt-0.5 text-[10.5px] tabular-nums ${textProblem ? 'text-warning-700' : 'text-success-700'}`} aria-live="polite">
                      {textProblem ?? `${length} characters · within ${minLength}–${maxLength}`}
                    </p>
                  </div>
                )}

                {item.saveError && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-[1.45] text-critical-700" role="alert">
                    <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    {item.saveError}
                  </p>
                )}

                {/* ── Actions ── */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {item.phase === 'draft' && item.mode === 'view' && (
                    <>
                      <button type="button" onClick={() => void save(row, item.draft, item.proposalId)} disabled={item.saving || draftProblem !== null} className="btn-primary btn-xs">
                        {item.saving ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
                        {item.saving ? 'Saving to your store…' : words.apply}
                      </button>
                      <button type="button" onClick={() => patch(row.id, { mode: 'edit', text: item.draft, saveError: null })} disabled={item.saving} className="btn-secondary btn-xs">
                        <PencilLine size={12} aria-hidden="true" />
                        Edit
                      </button>
                    </>
                  )}

                  {editing && (
                    <>
                      <button
                        type="button"
                        onClick={() => void save(row, item.text, item.mode === 'edit' ? item.proposalId : null)}
                        disabled={item.saving || textProblem !== null}
                        className="btn-primary btn-xs"
                      >
                        {item.saving ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
                        {item.saving ? 'Saving to your store…' : 'Apply to your store'}
                      </button>
                      <button type="button" onClick={() => patch(row.id, { mode: 'view', saveError: null })} disabled={item.saving} className="btn-ghost btn-xs">
                        Cancel
                      </button>
                    </>
                  )}

                  {canDraft && item.mode === 'view' && (item.phase === 'draft' || item.phase === 'unavailable' || (item.phase === 'idle' && !loadingEarlier)) && (
                    <button type="button" onClick={() => void generate([row.id])} disabled={item.saving} className="btn-secondary btn-xs">
                      {item.phase === 'idle' ? <Sparkles size={12} aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
                      {item.phase === 'idle' ? words.generate : item.phase === 'unavailable' ? 'Try again' : words.again}
                    </button>
                  )}

                  {item.mode === 'view' && item.phase !== 'generating' && !(loadingEarlier && item.phase === 'idle') && (
                    <button
                      type="button"
                      onClick={() => patch(row.id, { mode: 'manual', text: item.phase === 'applied' ? item.appliedValue ?? '' : '', saveError: null })}
                      disabled={item.saving}
                      className="btn-ghost btn-xs"
                    >
                      {item.phase === 'applied' ? 'Edit again' : 'Apply manually'}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {rows.length > AUTO_GENERATE_LIMIT && (
        <p className="text-[10.5px] text-surface-500">
          The first {AUTO_GENERATE_LIMIT} are drafted at a time. Use Generate fixes in the table to write many at once.
        </p>
      )}
    </div>
  );
}
