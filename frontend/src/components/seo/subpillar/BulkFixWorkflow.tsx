import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardCheck, History, Loader2, Sparkles, X } from 'lucide-react';
import type { EvidenceRow, RowStatus } from '../../../data/seo/subpillar.model';
import { applyFixes, fetchAiFixStatus, planAiFixes } from '../../../data/findings.repository';
import { followAuditRun } from '../../../data/useAuditRun';
import { titleFieldBounds } from '../../../data/fixBounds';
import { ApiError } from '../../../lib/api';
import { card, eyebrow } from './tone';

interface AppliedUpdate {
  id: string;
  before: string;
  after: string;
  beforeStatus: RowStatus;
  status: RowStatus;
}

interface Props {
  rows: EvidenceRow[];
  mode: 'title-tags' | 'generic';
  /**
   * Where the recommended values come from.
   *
   * 'ai' asks a model. 'template' renders the merchant's own saved pattern on the server — no
   * model, no key, no cost. It changes every word this panel uses for the action, because calling
   * it "Draft with AI" when no model is involved misnames what the merchant is about to do, and
   * "AI could not draft these" then misdiagnoses it when it fails.
   */
  generator?: 'ai' | 'template';
  /**
   * The finding each selected row belongs to, as `rowId -> findingId`.
   *
   * Needed because AI planning is scoped to a finding: the backend re-derives which resources that
   * finding actually flagged and refuses anything outside that set. Rows whose finding carries a
   * catalog slug id rather than a database id are simply not plannable, and are left to the
   * deterministic suggestion.
   */
  findingIdByRowId: Record<string, string>;
  /**
   * Selected rows left out because they have no issue to fix (healthy rows). Said in the header, so
   * "103 selected" with 54 empty boxes is not what the merchant sees.
   */
  leftOutCount?: number;
  /** Characters the theme appends to every rendered title, as the audit measured them. */
  titleSuffixLength?: number;
  onClose: () => void;
  onApply: (updates: AppliedUpdate[]) => void;
}

/** Rows per drafting request when the server does not say (an older server). */
const DEFAULT_BATCH = 15;

/** Only a numeric id is a real database finding the planner can work from. */
const isPersistedFinding = (id: string | undefined): id is string => Boolean(id && /^\d+$/.test(id));

const MIN_TITLE_LENGTH = 30;
const MAX_TITLE_LENGTH = 60;

/**
 * What the merchant may type, given what the theme will append.
 *
 * The audit scores the RENDERED title — this field plus the theme's suffix, which it measures
 * from the pages it loaded — so both ends of the field's range move with the suffix, exactly as the
 * server judges it (data/fixBounds.ts). Only the maximum used to move: with a 30-character suffix
 * that left 30-30, refusing every title but one length.
 */
function validate(row: EvidenceRow, value: string, mode: 'title-tags' | 'generic', bounds: { minLength: number; maxLength: number }) {
  const current = row.current?.value ?? '';
  const trimmed = value.trim();
  if (!trimmed) return 'Recommendation is empty';
  if (mode === 'title-tags' && (trimmed.length < bounds.minLength || trimmed.length > bounds.maxLength)) {
    return `Use ${bounds.minLength}-${bounds.maxLength} characters`;
  }
  if (trimmed === current) return 'Recommendation must meaningfully change the value';
  return null;
}

export default function BulkFixWorkflow({
  rows,
  mode,
  generator = 'ai',
  findingIdByRowId,
  titleSuffixLength = 0,
  leftOutCount = 0,
  onClose,
  onApply,
}: Props) {
  const titleBounds = titleFieldBounds(MIN_TITLE_LENGTH, MAX_TITLE_LENGTH, titleSuffixLength);
  const maxTitleLength = titleBounds.maxLength;
  const fromTemplate = generator === 'template';
  /** One vocabulary for the whole panel, so no corner of it can claim the wrong engine. */
  const words = fromTemplate
    ? { action: 'Fill from template', busy: 'Filling…', again: 'Fill again', filled: 'filled from your template' }
    : { action: 'Draft with AI', busy: 'Drafting…', again: 'Redraft', filled: 'drafted by AI' };
  const [isGenerating, setIsGenerating] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * `rowId -> proposal id`, populated when the model drafts a row.
   *
   * This is what separates a row that can be SAVED TO SHOPIFY from one that can only be edited on
   * screen. The apply endpoint reads the resource and field from the stored proposal — never from
   * this client — so a row with no proposal is not writable, and the UI has to say so rather than
   * showing an Apply button that would silently do nothing.
   */
  const [proposalIds, setProposalIds] = useState<Record<string, number>>({});
  /** Why the model left a specific row blank, keyed by row id. Cleared on a fresh draft. */
  const [skipReasons, setSkipReasons] = useState<Record<string, string>>({});
  /** Per-row failure text from Shopify after an apply, keyed by row id. */
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedUpdate[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  /** What AI actually managed to do, stated plainly rather than implied by a filled box. */
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const [aiCount, setAiCount] = useState(0);
  /** A redraft the merchant asked for, separate from the automatic first pass. */
  const [isDrafting, setIsDrafting] = useState(false);
  /** How far a draft of many rows has got: rows sent to the planner so far, of all to draft. */
  const [draftProgress, setDraftProgress] = useState<{ done: number; total: number } | null>(null);
  /** How the values in this modal were produced. 'manual' until the merchant asks for a draft. */
  const [fillMode, setFillMode] = useState<'manual' | 'ai'>('manual');

  /**
   * Asks the model to draft values for the rows given.
   *
   * `onlyEmpty` is what the automatic first pass uses: a row Rankvora AI could already derive a value
   * for does not need a paid model call. The explicit "Draft with AI" button passes false, because
   * a merchant pressing it is asking for the model's take on everything they selected — including
   * the rows they were not satisfied with.
   *
   * Nothing is invented locally. If the call fails, the boxes stay as they were and the panel says
   * what happened.
   */
  const draftWithAi = useCallback(
    async (onlyEmpty: boolean, current: Record<string, string>) => {
      // The planner works one finding at a time, and a selection can span several.
      const byFinding = new Map<string, string[]>();
      for (const row of rows) {
        if (onlyEmpty && current[row.id]) continue;
        const findingId = findingIdByRowId[row.id];
        if (!isPersistedFinding(findingId)) continue;
        byFinding.set(findingId, [...(byFinding.get(findingId) ?? []), row.id]);
      }

      if (byFinding.size === 0) {
        return {
          filled: {} as Record<string, string>,
          ids: {} as Record<string, number>,
          skips: {} as Record<string, string>,
          model: null as string | null,
          reasons: ['nothing_to_plan'],
        };
      }

      const filled: Record<string, string> = {};
      // The proposal id is what makes a draft WRITABLE. Without it a row can only be edited
      // locally: the apply endpoint identifies the resource and field from the stored proposal,
      // never from this client, so a row with no id has nothing the server would accept.
      const ids: Record<string, number> = {};
      /**
       * Why a specific row was left empty, keyed by ref.
       *
       * The server has always returned this — a per-resource reason for every row it could not
       * draft — and this component used to drop it on the floor. The result was the worst possible
       * answer to "why is this box blank": none at all. A merchant selecting five rows and getting
       * four had no way to tell whether the fifth failed, was skipped, or was still loading.
       */
      const skips: Record<string, string> = {};
      const reasons: string[] = [];
      let model: string | null = null;

      // The server drafts a batch per request; every row past the first batch used to come back
      // empty. Rows are sent a batch at a time, one request after another, and progress is shown.
      const batchSize = await fetchAiFixStatus()
        .then((status) => status.maxTargetsPerRequest ?? DEFAULT_BATCH)
        .catch(() => DEFAULT_BATCH);
      const total = [...byFinding.values()].reduce((sum, ids) => sum + ids.length, 0);
      let done = 0;
      setDraftProgress({ done, total });

      for (const [findingId, allIds] of byFinding) {
        for (let start = 0; start < allIds.length; start += batchSize) {
          const resourceIds = allIds.slice(start, start + batchSize);
          try {
            const result = await planAiFixes(findingId, resourceIds);
            model = result.model ?? model;
            // A reason given for a row in THIS request wins over a draft the finding held before.
            for (const skip of result.skipped) {
              const ref = `${skip.resourceType}:${skip.resourceId}`;
              if (resourceIds.includes(ref)) skips[ref] = skip.reason;
            }
            for (const proposal of result.proposals) {
              const ref = `${proposal.resourceType}:${proposal.resourceId}`;
              if (resourceIds.includes(ref) && skips[ref] === undefined) {
                filled[ref] = proposal.proposedValue;
                ids[ref] = proposal.id;
              }
            }
            if (!result.planned && result.unavailableReason) reasons.push(result.unavailableReason);
          } catch {
            reasons.push('unavailable');
          }
          done += resourceIds.length;
          setDraftProgress({ done, total });
        }
      }

      setDraftProgress(null);
      return { filled, ids, skips, model, reasons };
    },
    [rows, findingIdByRowId],
  );

  /**
   * Every one of these was previously collapsed into "AI could not draft these right now", which
   * described an outage regardless of what actually happened. A server with no API key, a
   * sub-pillar the planner does not cover, and a genuine provider failure need three different
   * actions from whoever reads the message — so they now say three different things.
   */
  const noticeFor = (reasons: string[]) => {
    // A template needs no provider, so these three cannot describe it. They stay AI-only rather
    // than being softened into wording that fits both and helps neither.
    if (!fromTemplate) {
      if (reasons.includes('disabled')) {
        return 'AI drafting is turned off on this server. The recommendations below need to be written by hand.';
      }
      if (reasons.includes('not_configured')) {
        return 'AI drafting is not set up on this server yet — no model provider is configured. Ask your administrator to add the AI credentials, or write the values yourself.';
      }
      if (reasons.includes('nothing_to_plan')) {
        return 'These rows are not covered by AI drafting yet — write the values yourself, or edit the suggestions above.';
      }
    }
    if (reasons.includes('nothing_to_fix') || reasons.includes('not_fixable')) {
      return fromTemplate
        // Per-row reasons sit under each box and say which of these it was; this is the summary.
        ? 'Nothing was filled in. Each row below says why — usually an image that already has alt text, or a template that produced nothing for it. Check your template in Image Alt Text settings, or write the values yourself.'
        : 'Rankvora AI has no stored evidence for these rows to draft from, so nothing was requested. Re-analyze the store, or write the values yourself.';
    }
    if (reasons.includes('nothing_to_plan')) {
      return 'These rows are not covered by automatic values yet — write them yourself, or edit the suggestions above.';
    }
    return fromTemplate
      ? 'Your template could not be applied right now. Nothing has been filled in for you — the boxes are exactly as they were.'
      : 'AI could not draft these right now. Nothing has been filled in for you — the boxes are exactly as they were.';
  };

  /**
   * Opens EMPTY, in manual mode. Nothing is written for the merchant until they ask.
   *
   * This used to pre-fill every box with the deterministic suggestion and then quietly call the
   * model for whatever was still blank. Both halves were wrong for the same reason: the merchant
   * never chose either. What they saw was a column of values they had not asked for — and for
   * short titles that value was the store name appended to their own title, which reads as a
   * recommendation while being pure boilerplate.
   *
   * Writing a value is now always a deliberate act: type it, or press the fill button.
   */
  useEffect(() => {
    if (applied.length > 0) return;
    setDrafts(Object.fromEntries(rows.map((row) => [row.id, ''])));
    setIsGenerating(false);
  }, [applied.length, rows]);

  /** The explicit action: draft every selected row from the resources' own content. */
  const redraftWithAi = async () => {
    setFillMode('ai');
    setIsDrafting(true);
    setAiNotice(null);
    const { filled, ids, skips, model, reasons } = await draftWithAi(false, drafts);
    const count = Object.keys(filled).length;
    setAiCount(count);
    setAiModel(model);
    setProposalIds((existing) => ({ ...existing, ...ids }));
    // Replaced wholesale rather than merged: these describe THIS draft attempt, and carrying a
    // stale reason onto a row the model has since filled would be worse than showing nothing.
    setSkipReasons(skips);
    if (count > 0) setDrafts((existing) => ({ ...existing, ...filled }));
    else setAiNotice(noticeFor(reasons));
    setIsDrafting(false);
  };

  /** Back to typing: clears what the model wrote, so "manual" means manual. */
  const switchToManual = () => {
    setFillMode('manual');
    setAiNotice(null);
    setAiCount(0);
    setDrafts(Object.fromEntries(rows.map((row) => [row.id, ''])));
  };

  const reviews = useMemo(
    () => rows.map((row) => ({ row, value: drafts[row.id] ?? '', error: validate(row, drafts[row.id] ?? '', mode, titleBounds) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, titleBounds.minLength, titleBounds.maxLength, mode, rows],
  );
  const ready = reviews.filter((item) => !item.error);
  const needsReview = reviews.length - ready.length;

  const updateDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }));

  /**
   * Rows Shopify can actually be asked to save.
   *
   * A row qualifies two ways, and BOTH matter: it was drafted by AI (so a proposal exists), or it
   * belongs to a real finding (so the server can create one from the merchant's own text). Gating
   * on the proposal alone made "write it yourself" a dead end — the value could be typed and
   * validated and then had nowhere to go, which is the opposite of what an editable preview is for.
   */
  const writable = ready.filter(
    ({ row }) => proposalIds[row.id] !== undefined || isPersistedFinding(findingIdByRowId[row.id]),
  );
  const applyErrorCount = Object.keys(applyErrors).length;

  /**
   * Writes the approved values to the merchant's real Shopify store.
   *
   * THIS USED TO BE A LOCAL STATE UPDATE. The button said "Apply N test fixes" and did exactly
   * that: it rewrote the rows on screen and nothing else. The storefront never changed, so the
   * next audit re-measured the same missing descriptions and the score never moved — which is
   * precisely what made the feature look broken.
   *
   * The table is now updated from what the SERVER confirmed, not from what was submitted. A row
   * Shopify rejected keeps its old value and shows the reason, because showing it as fixed would
   * be the same lie in a new place.
   */
  const handleApply = async () => {
    if (writable.length === 0 || isApplying) return;
    setIsApplying(true);
    setApplyNotice(null);
    setApplyErrors({});

    try {
      // The EDITED text is sent, not the drafted text — the merchant's correction is the point of
      // an editable preview. The server re-checks it against the same bounds either way.
      const result = await applyFixes(
        writable.map(({ row, value }) =>
          proposalIds[row.id] !== undefined
            ? { proposalId: proposalIds[row.id]!, value: value.trim() }
            // No proposal yet — the server creates one from this text, anchored to the finding's
            // own evidence so the ref cannot point at a resource the audit never saw.
            : { findingId: Number(findingIdByRowId[row.id]), resourceRef: row.id, value: value.trim() },
        ),
      );

      // Matched by REF, not by proposal id: a manual fix has no id until the server creates one, so
      // the id alone could not identify which row an outcome belongs to.
      // The re-audit the save queued is followed like any analysis: the banner shows it, and the
      // page reloads its results when it finishes.
      if (result.reauditJobId) followAuditRun(result.reauditJobId);

      const byRef = new Map(result.results.map((entry) => [entry.resourceRef, entry]));
      const failures: Record<string, string> = {};
      const updates: AppliedUpdate[] = [];

      for (const { row, value } of writable) {
        const outcome = byRef.get(row.id);
        if (outcome?.status === 'applied') {
          updates.push({
            id: row.id,
            before: row.current?.value ?? '',
            after: value.trim(),
            beforeStatus: row.status,
            status: 'Healthy',
          });
        } else if (outcome) {
          failures[row.id] = outcome.detail ?? 'Shopify did not accept this change.';
        }
      }

      setApplyErrors(failures);
      if (updates.length > 0) {
        onApply(updates);
        setApplied(updates);
      }

      // The re-audit is what actually moves the score, so it is stated rather than left implied —
      // a merchant who sees "12 saved" and an unchanged score would reasonably assume a bug.
      const reaudit =
        result.reaudit === 'queued'
          ? ' A fresh audit is running — scores update when it finishes.'
          : result.reaudit === 'already-running'
            ? ' An audit is already running and will pick these up.'
            : '';

      // The reasons are carried IN the notice rather than promised somewhere else on screen. Every
      // distinct reason is shown once — twenty rows refused for one missing scope is one sentence,
      // not twenty.
      const distinct = [...new Set(Object.values(failures))];
      const why = distinct.length > 0 ? ` ${distinct.join(' ')}` : '';

      setApplyNotice(
        result.applied === 0
          ? `Nothing was saved to Shopify.${why}`
          : `Saved ${result.applied} change${result.applied === 1 ? '' : 's'} to Shopify.${reaudit}${
              result.failed + result.skipped > 0 ? ` ${result.failed + result.skipped} could not be saved.${why}` : ''
            }`,
      );
    } catch (error) {
      setApplyNotice(
        error instanceof ApiError && [400, 403, 409, 429, 502].includes(error.status)
          ? error.message
          : 'We could not save these changes to Shopify. Please try again.',
      );
    } finally {
      setIsApplying(false);
    }
  };

  // handleUndo is deliberately gone. It swapped the before/after values back in this table and
  // touched nothing else, which was honest while the whole flow was in-memory. Now that Save writes
  // to Shopify, a local undo would revert only the display and leave the storefront changed — worse
  // than having no undo at all, because the merchant would believe they had rolled it back.

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" className="absolute inset-0 cursor-default bg-surface-950/25" onClick={onClose} aria-label="Close bulk fix review" />
      <section role="dialog" aria-modal="true" aria-labelledby="bulk-fix-title" className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-xl bg-surface-0 shadow-2xl sm:rounded-xl">
        <header className="flex items-start justify-between gap-3 border-b border-surface-200 px-4 py-2.5">
          <div>
            {/* The copy here described a sandbox because that is what this screen used to be. It
                now writes to the merchant's live store, so it says so BEFORE the button is
                pressed — "test mode" above a control that edits a real storefront is the most
                expensive kind of wrong wording. */}
            <p className={eyebrow}>Review before saving to Shopify</p>
            <h2 id="bulk-fix-title" className="mt-0.5 text-[15px] font-semibold tracking-tight text-surface-950">Review {mode === 'title-tags' ? 'title tag' : 'recommended'} fixes</h2>
            <p className="text-[11px] text-surface-500">Nothing changes until you press Save. Saved values are written to your live store.</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-surface-500 hover:bg-surface-100 hover:text-surface-900" aria-label="Close review">
            <X size={15} />
          </button>
        </header>

        {isGenerating ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-[12.5px] text-surface-600">
            <Loader2 size={18} className="animate-spin text-brand-600" />
            Drafting recommendations from your store's own content…
          </div>
        ) : applied.length > 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <CheckCircle2 size={24} className="text-success-600" />
            <h3 className="text-[15px] font-semibold text-surface-950">
              {applied.length} change{applied.length === 1 ? '' : 's'} saved to Shopify
            </h3>
            {/* THE UNDO BUTTON IS GONE, and its absence is the point. It only ever reverted this
                table; now that the value is genuinely on the storefront, a control labelled "Undo"
                that leaves Shopify untouched would tell a merchant they had rolled back a change
                that is still live. There is no safe local undo for a remote write, so the screen
                says where the real one is instead of faking one. */}
            <p className="max-w-md text-[12.5px] text-surface-600">
              These values are now live on your store. A fresh audit is running — scores update when
              it finishes. To change one back, edit it in Shopify admin under Search engine listing.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              <button type="button" onClick={() => setShowHistory((value) => !value)} className="btn-ghost btn-xs"><History size={12} /> What changed</button>
              <button type="button" onClick={onClose} className="btn-primary btn-xs">Done</button>
            </div>
            {showHistory && <p className={`${card} mt-2 px-3 py-2 text-left text-[11.5px] text-surface-600`}>{applied.length} resource{applied.length === 1 ? '' : 's'} updated on Shopify.</p>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2.5 border-b border-surface-200 bg-surface-50/60 px-4 py-1.5 text-[11.5px]">
              <span className="font-semibold text-surface-800">{rows.length} to fix</span>
              {leftOutCount > 0 && (
                <span className="text-surface-500" title="Rows the latest analysis found nothing wrong with have nothing to fix.">
                  {leftOutCount} healthy {leftOutCount === 1 ? 'row' : 'rows'} left out
                </span>
              )}
              <span className="text-success-700">{ready.length} ready</span>
              {needsReview > 0 && <span className="text-warning-700">{needsReview} need review</span>}
              {aiCount > 0 && (
                <span className="inline-flex items-center gap-1 text-brand-700">
                  <Sparkles size={11} aria-hidden="true" />
                  {aiCount} {words.filled}
                  {/* Named only when a model actually wrote them. A template value has no model,
                      and inventing one here would credit a vendor that was never called. */}
                  {!fromTemplate && aiModel ? ` · ${aiModel}` : ''}
                </span>
              )}

              {/* ── Two ways to fill these boxes, and the merchant picks ────
                  Manual is the default and writes nothing at all. AI drafts every selected row
                  from the resources' own content. Neither happens on its own: a value the
                  merchant did not ask for is not a recommendation, it is a surprise. */}
              <div className="ml-auto flex items-center gap-1.5">
                <div className="inline-flex gap-0.5 rounded-md border border-surface-200 bg-surface-100/70 p-0.5" role="group" aria-label="How to fill the recommendations">
                  <button
                    type="button"
                    onClick={switchToManual}
                    aria-pressed={fillMode === 'manual'}
                    className={`cursor-pointer rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                      fillMode === 'manual' ? 'bg-surface-0 text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)]' : 'text-surface-500 hover:text-surface-800'
                    }`}
                  >
                    Write manually
                  </button>
                  <button
                    type="button"
                    onClick={() => void redraftWithAi()}
                    aria-pressed={fillMode === 'ai'}
                    disabled={isDrafting}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      fillMode === 'ai' ? 'bg-surface-0 text-brand-700 shadow-[0_1px_2px_var(--c-shadow-md)]' : 'text-surface-500 hover:text-surface-800'
                    }`}
                  >
                    {isDrafting
                      ? <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <Sparkles size={11} aria-hidden="true" />}
                    {isDrafting
                      ? (draftProgress && draftProgress.total > 0 ? `${words.busy.replace('…', '')} ${draftProgress.done} of ${draftProgress.total}…` : words.busy)
                      : words.action}
                  </button>
                </div>

                {fillMode === 'ai' && aiCount > 0 && !isDrafting && (
                  <button
                    type="button"
                    onClick={() => void redraftWithAi()}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-surface-500 transition-colors hover:text-brand-700"
                  >
                    {words.again}
                  </button>
                )}
              </div>
            </div>

            {/* Stated, not implied. An empty box with no explanation reads as a broken feature. */}
            {aiNotice && (
              <p className="flex items-start gap-1.5 border-b border-warning-100 bg-warning-50 px-4 py-2 text-[11.5px] leading-[1.45] text-warning-800">
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                {aiNotice}
              </p>
            )}
            <div className="overflow-y-auto px-4 py-2.5">
              <div className="space-y-2">
                {reviews.map(({ row, value, error }) => (
                  <article key={row.id} className="rounded-md border border-surface-200 p-2.5">
                    <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start">
                      <div className="min-w-0 flex-1">
                        {/* WHICH RESOURCE THIS BOX WILL CHANGE, said plainly and first.
                            It used to be a lone truncated URL. On meta descriptions that was the
                            ONLY identifier, because `current.value` there is the description —
                            which is empty on a store that has set none, so every row read
                            "No current value" under an unreadable URL. The name answers "what am
                            I editing?"; the path separates two products named alike. Both fall
                            back to the URL so an audit taken before these cells existed still
                            identifies its rows. */}
                        <p className="truncate text-[12px] font-semibold text-surface-900" title={String(row.cells.name ?? '')}>
                          {String(row.cells.name ?? row.cells.url ?? '')}
                        </p>
                        <p className="truncate font-mono text-[10.5px] text-surface-500" title={String(row.cells.url ?? '')}>
                          {String(row.cells.path ?? row.cells.url ?? '')}
                        </p>
                        <p className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-400">Current value</p>
                        <p className="mt-0.5 text-[12.5px] leading-[1.45] text-surface-700">{row.current?.value || 'No current value'}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <label className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-surface-400" htmlFor={`bulk-fix-${row.id}`}>Recommended value</label>
                        <textarea id={`bulk-fix-${row.id}`} value={value} onChange={(event) => updateDraft(row.id, event.target.value)} rows={2} className="mt-1 w-full resize-y rounded-md border border-surface-200 bg-surface-50 px-2.5 py-1.5 text-[12.5px] text-surface-900 outline-none focus:border-brand-400 focus:bg-surface-0 focus:ring-2 focus:ring-brand-100" />
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px]">
                          <span className={error ? 'text-warning-700' : 'text-success-700'}>{error ?? 'Ready to apply'}</span>
                          <span className="tabular-nums text-surface-400">{mode === 'title-tags' ? `${value.length}/${maxTitleLength}` : `${value.length} characters`}</span>
                        </div>
                        {/* WHY THIS ROW IS BLANK, on the row itself. "Recommendation is empty"
                            describes the box; it does not answer the only question the merchant
                            has, which is why the model filled four of five. The server sends a
                            per-resource reason and this is where it belongs — beside the empty box,
                            not buried in a banner about the batch. Shown only while the row is
                            still empty, so it disappears the moment they type. */}
                        {!value && skipReasons[row.id] && (
                          <p className="mt-1 text-[10.5px] leading-[1.4] text-surface-500">{skipReasons[row.id]}</p>
                        )}
                        {applyErrors[row.id] && (
                          <p className="mt-1 text-[10.5px] leading-[1.4] text-critical-700">{applyErrors[row.id]}</p>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <footer className="flex flex-col-reverse gap-2 border-t border-surface-200 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex items-center gap-1.5 text-[11.5px] text-surface-500"><ClipboardCheck size={13} /> Validated before saving to your live store</div>
              <div className="flex flex-col items-end gap-1.5">
                {/* Says plainly what the button does. It used to read "Apply N test fixes" while
                    only rewriting the table — the wording was accurate and the behaviour was the
                    problem. Both are fixed: this writes to Shopify, and it says so. */}
                {applyNotice && (
                  <p role="status" className={`text-[11px] leading-[1.4] ${applyErrorCount > 0 ? 'text-critical-700' : 'text-success-700'}`}>
                    {applyNotice}
                  </p>
                )}
                {ready.length > writable.length && (
                  <p className="text-[11px] leading-[1.4] text-surface-500">
                    {ready.length - writable.length} row{ready.length - writable.length === 1 ? '' : 's'} can't be saved
                    from here — Rankvora AI has no stored evidence linking them to a finding. Update those in Shopify admin.
                  </p>
                )}
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={onClose} className="btn-secondary btn-xs">Cancel</button>
                  <button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={writable.length === 0 || isApplying}
                    className="btn-primary btn-xs"
                  >
                    {isApplying ? 'Saving to Shopify…' : `Save ${writable.length} to Shopify`}
                  </button>
                </div>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}