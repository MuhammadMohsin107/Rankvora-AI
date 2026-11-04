import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { applyFixes, fetchAiFixStatus, planAiFixes } from '../../data/findings.repository';
import { invalidateCatalogs } from '../../data/catalog.repository';
import { followAuditRun } from '../../data/useAuditRun';
import Button from '../../components/polaris/Button';
import Banner from '../polaris/Banner';
import { TextAreaField, TextField } from '../polaris/fields';

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
      <Banner tone="success" heading={`${label} saved to your store.`}>
        {saved.reaudit && <s-text>{saved.reaudit}</s-text>}
        <Button slot="secondary-actions" variant="secondary" onClick={() => { setSaved(null); setProposalId(null); }}>Edit again</Button>
      </Banner>
    );
  }

  const fieldId = `fix-${rowId}`;
  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button loading={busy === 'saving'} variant="primary" onClick={() => void save()} disabled={!canSave}>
        {busy === 'saving' ? 'Saving…' : 'Apply to your store'}
      </Button>
      {showDraft && (
        <Button loading={busy === 'drafting'} variant="secondary" onClick={() => void draftValue()} disabled={!canDraft}>
          {busy === 'drafting' ? (draft === 'template' ? 'Filling…' : 'Drafting…') : draft === 'template' ? 'Fill from template' : 'Draft with AI'}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-1.5">
      {multiline ? (
        <TextAreaField
          id={fieldId}
          label={label}
          labelHidden={compact}
          rows={3}
          value={value}
          onChange={(next) => { setValue(next); setDraftNote(null); }}
          disabled={busy === 'saving'}
          details={compact ? undefined : `${trimmed.length} characters`}
        />
      ) : (
        <TextField
          id={fieldId}
          label={label}
          labelHidden={compact}
          value={value}
          onChange={(next) => { setValue(next); setDraftNote(null); }}
          disabled={busy === 'saving'}
          details={compact ? undefined : `${trimmed.length} characters`}
        />
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
