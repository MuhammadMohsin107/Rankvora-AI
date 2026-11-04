import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Save, Sparkles } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { applyFixes, fetchAiFixStatus, planAiFixes } from '../../data/findings.repository';
import { invalidateCatalogs } from '../../data/catalog.repository';
import { followAuditRun } from '../../data/useAuditRun';

/**
 * Fixes a field of one item without leaving Rankvora AI: the value is typed (or drafted) here and written
 * to the merchant's store through the same endpoint the bulk fix workflow uses — `applyFixes`, the
 * one call in the app that changes a storefront. Nothing is written until the merchant presses Save,
 * and the server re-checks the value against the field's own rules and against the finding's own
 * evidence, so what this box can aim at is what the audit already flagged and nothing else.
 *
 * Nothing here is invented: the box starts from the check's own suggestion when it had one, else the
 * field's current text, and a draft is whatever the server's planner returned.
 */

/** Whether the server has a model to draft with — read once, and only ever hides the button. */
let aiDrafting: Promise<boolean> | null = null;
function aiDraftingAvailable(): Promise<boolean> {
  aiDrafting ??= fetchAiFixStatus()
    .then((status) => status.enabled)
    .catch(() => {
      aiDrafting = null;
      return false;
    });
  return aiDrafting;
}

const REASON_TEXT: Record<string, string> = {
  disabled: 'AI drafting is turned off on this server — write the value yourself.',
  not_configured: 'AI drafting is not set up on this server yet — write the value yourself.',
  not_fixable: 'This field cannot be drafted for this item — write the value yourself.',
  nothing_to_fix: 'There is nothing left to draft for this item — write the value yourself.',
};

const REAUDIT_TEXT: Record<string, string> = {
  queued: ' A fresh audit is running — your scores update when it finishes.',
  'already-running': ' An audit is already running and will pick this up.',
  failed: ' The follow-up audit could not be started — run one from the dashboard to update your scores.',
};

interface FixEditorProps {
  /** The evidence row this fix is aimed at ("product:123", "productImage:123/456"). */
  rowId: string;
  /** The finding that owns the row — the authorization the server anchors on. */
  findingId: string;
  /** The field's name, in the merchant's words: "SEO title". */
  label: string;
  /** What the field says now. */
  current: string;
  /** What the check itself suggested, when it had a suggestion. */
  suggested: string | null;
  /** Where a draft comes from: a model, or the merchant's own template. */
  draft: 'ai' | 'template';
  /** One line (alt text) or a paragraph (a meta description). */
  multiline?: boolean;
  /** No label above, for a row in a table. */
  compact?: boolean;
  /** Whether the draft button is offered. Off where the planner does not accept the row's ref. */
  allowDraft?: boolean;
  /** Called with the value the store now has, once the server has confirmed the write. */
  onSaved: (value: string) => void;
}

export default function FixEditor({ rowId, findingId, label, current, suggested, draft, multiline = true, compact = false, allowDraft = true, onSaved }: FixEditorProps) {
  const [value, setValue] = useState(suggested ?? current);
  const [proposalId, setProposalId] = useState<number | null>(null);
  const [busy, setBusy] = useState<'saving' | 'drafting' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why a draft was not put in the box. Not an error of the merchant's: the box still holds what it
  // held, and that is said plainly beside the reason.
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ reaudit: string } | null>(null);
  const [aiReady, setAiReady] = useState(false);

  useEffect(() => {
    if (!allowDraft || draft !== 'ai') return;
    let live = true;
    void aiDraftingAvailable().then((enabled) => { if (live) setAiReady(enabled); });
    return () => { live = false; };
  }, [allowDraft, draft]);

  const trimmed = value.trim();
  const canSave = busy === null && trimmed !== '' && trimmed !== current.trim();
  const showDraft = allowDraft && (draft === 'template' || aiReady);
  const canDraft = busy === null && showDraft;

  const draftValue = async () => {
    setBusy('drafting');
    setError(null);
    setDraftNote(null);
    try {
      const result = await planAiFixes(findingId, [rowId]);
      // A reason given for THIS item wins over any draft the finding still holds for it from before.
      const skipped = result.skipped.some((candidate) => `${candidate.resourceType}:${candidate.resourceId}` === rowId);
      const proposal = skipped ? undefined : result.proposals.find((candidate) => `${candidate.resourceType}:${candidate.resourceId}` === rowId);
      if (proposal) {
        setValue(proposal.proposedValue);
        setProposalId(proposal.id);
      } else {
        const skip = result.skipped.find((candidate) => `${candidate.resourceType}:${candidate.resourceId}` === rowId);
        setDraftNote(skip?.reason ?? (result.unavailableReason ? REASON_TEXT[result.unavailableReason] : undefined) ?? 'Nothing could be drafted for this — write the value yourself.');
      }
    } catch {
      setDraftNote('Drafting is unavailable right now. You can write the value yourself.');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!canSave) return;
    setBusy('saving');
    setError(null);
    setDraftNote(null);
    try {
      // The EDITED text is what is sent, not the draft: the merchant's correction is the point. A
      // drafted row already has a proposal; a typed one has none, so the server creates it from the
      // finding's own evidence.
      const result = await applyFixes([
        proposalId !== null
          ? { proposalId, value: trimmed }
          : { findingId: Number(findingId), resourceRef: rowId, value: trimmed },
      ]);
      // Matched by ref, as the bulk workflow does — the outcome for THIS row, not the first one.
      const outcome = result.results.find((entry) => entry.resourceRef === rowId);
      if (outcome?.status === 'applied') {
        invalidateCatalogs();
        if (result.reauditJobId) followAuditRun(result.reauditJobId);
        setSaved({ reaudit: REAUDIT_TEXT[result.reaudit] ?? '' });
        onSaved(trimmed);
      } else {
        setError(outcome?.detail ?? 'Your store did not accept this change.');
      }
    } catch (failure) {
      setError(
        failure instanceof ApiError && [400, 403, 409, 429, 502].includes(failure.status)
          ? failure.message
          : 'We could not save this change to your store. Please try again.',
      );
    } finally {
      setBusy(null);
    }
  };

  if (saved) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-success-50 px-3 py-2 ring-1 ring-inset ring-success-100" role="status">
        <p className="flex items-start gap-1.5 text-[12px] leading-[1.5] text-success-700">
          <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span><span className="font-semibold">{label} saved to your store.</span>{saved.reaudit}</span>
        </p>
        <button type="button" className="btn-secondary btn-xs" onClick={() => { setSaved(null); setProposalId(null); }}>Edit again</button>
      </div>
    );
  }

  const fieldId = `fix-${rowId}`;
  const fieldClass = 'w-full rounded-lg border border-surface-200 bg-surface-0 px-3 py-2 text-[12.5px] leading-[1.5] text-surface-900 placeholder:text-surface-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:opacity-60';
  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className="btn-primary btn-xs" onClick={() => void save()} disabled={!canSave}>
        {busy === 'saving' ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Save size={12} aria-hidden="true" />}
        {busy === 'saving' ? 'Saving…' : 'Apply to your store'}
      </button>
      {showDraft && (
        <button type="button" className="btn-secondary btn-xs" onClick={() => void draftValue()} disabled={!canDraft}>
          {busy === 'drafting' ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
          {busy === 'drafting' ? (draft === 'template' ? 'Filling…' : 'Drafting…') : draft === 'template' ? 'Fill from template' : 'Draft with AI'}
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-1.5">
      {!compact && (
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={fieldId} className="text-[12px] font-medium text-surface-700">{label}</label>
          <span className="text-[11px] tabular-nums text-surface-500" aria-live="polite">{trimmed.length} characters</span>
        </div>
      )}
      {multiline ? (
        <textarea id={fieldId} rows={3} value={value} onChange={(event) => { setValue(event.target.value); setDraftNote(null); }} disabled={busy === 'saving'} className={`${fieldClass} resize-y`} />
      ) : (
        <input id={fieldId} type="text" value={value} onChange={(event) => { setValue(event.target.value); setDraftNote(null); }} disabled={busy === 'saving'} aria-label={compact ? label : undefined} className={fieldClass} />
      )}
      {draftNote && (
        <p className="text-[12px] leading-[1.5] text-warning-700" role="status">
          {draftNote} The box above is unchanged.
        </p>
      )}
      {error && <p className="text-[12px] leading-[1.5] text-critical-700" role="alert">{error}</p>}
      {controls}
    </div>
  );
}
