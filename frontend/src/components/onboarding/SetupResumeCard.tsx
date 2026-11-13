import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Sparkles } from 'lucide-react';
import { Button } from '../workflows/WorkflowPrimitives';
import {
  SHOWN_STEPS,
  STEP_META,
  fetchOnboardingShared,
  reopenOnboarding,
  type OnboardingSnapshot,
} from '../../data/onboarding.repository';

/**
 * Shown on the dashboard when guided setup exists but is not finished.
 *
 * This is where a merchant who left setup unfinished — an earlier deferral, a closed tab — gets it
 * back. It states exactly what is still outstanding — by name, not as a percentage — because
 * "2 of 5 steps" does not tell anyone whether the missing one matters, and "Keywords" does.
 *
 * Sized for the dashboard it sits on, not for the setup page. The flow's own scale would make this
 * shout over the store's actual numbers; what it borrows instead is the flow's language — the same
 * segmented progress, the same step names, the same brand tint — so arriving at setup from here
 * feels like continuing rather than jumping somewhere new.
 *
 * Renders nothing at all when there is no connected store, when setup is complete, or when the
 * check fails. A card that cannot say something true stays off the page.
 */
export default function SetupResumeCard() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await fetchOnboardingShared();
        if (!cancelled) setSnapshot(state);
      } catch {
        // Silent: a resume prompt is an aid, and failing to load one is not worth an error on a
        // merchant's dashboard.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot || !snapshot.connected || snapshot.completedAt) return null;

  // REQUIRED steps only. Measurement is optional: a merchant who chose to set it up later has
  // nothing outstanding, and this card must not tell them otherwise.
  const required = snapshot.progress.filter((entry) => entry.required && SHOWN_STEPS.includes(entry.step));
  const outstanding = required.filter((entry) => entry.status !== 'complete');
  if (outstanding.length === 0) return null;

  const total = required.length;
  const done = total - outstanding.length;

  const resume = async () => {
    setOpening(true);
    try {
      // Clears the deferral server-side, so returning here is a deliberate re-entry rather than
      // a redirect loop with the gate.
      await reopenOnboarding();
    } catch {
      // Navigating anyway is correct: the setup page re-reads state on mount and will show
      // whatever is actually true.
    }
    navigate('/onboarding');
  };

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-0 ring-1 ring-inset ring-brand-200/80">
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-brand-100/80 blur-3xl" />
      <div className="relative flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
          <Sparkles size={18} strokeWidth={1.9} aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-surface-950">Finish setup</h2>
            <span className="text-[12px] font-medium tabular-nums text-brand-700">
              {done} of {total} done
            </span>
          </div>

          {/* Progress and the step names are ONE control, not a bar above a separate list: each
              step owns its own segment and sits under it. `flex-1` with a floor width lets the five
              reflow into rows of two or three on a phone instead of shrinking into slivers. */}
          {/* Numbered, because this strip is the merchant's map of a flow they walk in order: "Step
              3" says where a name like "Markets" actually sits, and the number is what the setup
              page's own header says when they arrive. Two states only — done or not — so the strip
              can never show progress the count above it disagrees with. */}
          <ol className="mt-3 flex flex-wrap gap-x-3 gap-y-2" aria-label="Setup progress">
            {snapshot.progress.filter((entry) => SHOWN_STEPS.includes(entry.step)).map((entry, index) => {
              const title = STEP_META.find((meta) => meta.step === entry.step)?.title ?? `Step ${index + 1}`;
              const complete = entry.status === 'complete';
              // An optional step that is not done reads as optional, not as something left undone.
              const optional = !entry.required && !complete;
              return (
                <li key={entry.step} className="flex min-w-[96px] flex-1 flex-col gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 rounded-full transition-colors duration-500 ${complete ? 'bg-success-500' : 'bg-surface-200'}`}
                  />
                  <span className="flex items-baseline gap-1.5 leading-tight">
                    <span
                      className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                        complete ? 'text-success-700' : 'text-surface-400'
                      }`}
                    >
                      {complete ? (
                        <Check size={10} strokeWidth={3} aria-hidden="true" />
                      ) : (
                        <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-surface-300" />
                      )}
                      Step {index + 1}
                    </span>
                    <span className={`text-[11px] font-medium ${complete ? 'text-success-700' : 'text-surface-500'}`}>
                      {title}
                      {optional && <span className="ml-1 text-surface-400">(optional)</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex-shrink-0">
          <Button onClick={() => void resume()} disabled={opening}>
            {opening ? 'Opening…' : done > 0 ? 'Resume setup' : 'Start setup'}
          </Button>
        </div>
      </div>
    </section>
  );
}
