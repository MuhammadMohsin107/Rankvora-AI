import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { fetchAiRecommendation, fetchAiStatus, type AiRecommendation } from '../../data/findings.repository';
import Button from '../../components/polaris/Button';

interface Props {
  /** The finding's id as rendered by the UI. Only a numeric id is a real database row. */
  findingId: string;
}

/**
 * Optional AI enhancement for a single finding, rendered beneath the deterministic
 * recommendation that the drawer already shows.
 *
 * The deterministic text is the source of truth and is never replaced or hidden — AI output sits
 * below it as clearly-labelled advisory copy. Generation is user-triggered (one click, one call;
 * the backend caches the result on the finding), never fired on render, so opening a drawer
 * repeatedly costs nothing.
 *
 * The component renders NOTHING at all unless the server reports a model is configured and this
 * finding is a real database row, so the action is never offered where it is guaranteed to fail.
 */
export default function AiRecommendationPanel({ findingId }: Props) {
  // Catalog-derived findings carry slug ids ('ai-issue-1') and have no row to enhance.
  const isPersisted = /^\d+$/.test(findingId);

  const [available, setAvailable] = useState(false);
  const [ai, setAi] = useState<AiRecommendation | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** null = still asking the server. Distinguished from `false` so the option is not flashed as
   * unavailable while the status request is in flight. */
  const [statusKnown, setStatusKnown] = useState(false);

  useEffect(() => {
    if (!isPersisted) return;
    let active = true;
    // Clear when the drawer switches to a different finding.
    setAi(null);
    setMessage(null);
    setStatusKnown(false);
    fetchAiStatus()
      .then((status) => { if (active) { setAvailable(status.enabled); setModel(status.model); setStatusKnown(true); } })
      .catch(() => { if (active) { setAvailable(false); setStatusKnown(true); } });
    return () => { active = false; };
  }, [findingId, isPersisted]);

  /**
   * A finding with no database row has nothing to enhance, so the option genuinely does not apply
   * and is not shown.
   *
   * Everything else DOES show it. This panel used to return null whenever the server said AI was
   * off — or whenever the status request merely failed — which meant the one place a customer
   * could discover that Rankvora AI can draft copy for them was invisible exactly when something was
   * wrong. An option they never see is an option they do not have.
   */
  if (!isPersisted) return null;

  const generate = async (force: boolean) => {
    setPending(true);
    setMessage(null);
    try {
      const result = await fetchAiRecommendation(findingId, force);
      if (result.enhanced && result.ai) {
        setAi(result.ai);
        setModel(result.model);
      } else {
        // Never surface a provider error verbatim — the deterministic advice above still stands.
        setMessage('AI enhancement is unavailable right now.');
      }
    } catch {
      setMessage('AI enhancement is unavailable right now.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-2.5 border-t border-brand-100 pt-2.5">
      {ai && (
        <div className="rounded-md border border-brand-200 bg-surface-0/70 p-2.5">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-brand-700">
            <Sparkles size={11} aria-hidden="true" />
            AI-enhanced recommendation
            <span className="ml-auto font-medium normal-case tracking-normal text-surface-500">
              {ai.confidence} confidence{model ? ` · ${model}` : ''}
            </span>
          </p>
          <p className="mt-1.5 text-[12.5px] leading-[1.5] text-surface-700">{ai.recommendation}</p>
          <p className="mt-1.5 text-[11.5px] leading-[1.45] text-surface-600">
            <span className="font-semibold">Why it matters: </span>{ai.whyItMatters}
          </p>
          <p className="mt-1 text-[11.5px] leading-[1.45] text-surface-600">
            <span className="font-semibold">Next step: </span>{ai.suggestedAction}
          </p>
          <p className="mt-1.5 text-[10.5px] text-surface-400">
            Advisory only. Nothing was changed on your store.
          </p>
        </div>
      )}

      {message && <p className="text-[11.5px] text-surface-500">{message}</p>}

      {/* The option is always visible once the finding is eligible. When the server cannot run it,
          the control is disabled and says why — a customer learns the capability exists and what
          it would take to use it, instead of the feature simply not being there. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button variant="secondary" onClick={() => void generate(ai !== null)} loading={pending} disabled={!available || !statusKnown}>
          {pending ? 'Generating…' : ai ? 'Regenerate with AI' : 'Improve with AI'}
        </Button>

        {statusKnown && !available && (
          <span className="text-[10.5px] text-surface-500">
            Not available right now.
          </span>
        )}
      </div>
    </div>
  );
}
