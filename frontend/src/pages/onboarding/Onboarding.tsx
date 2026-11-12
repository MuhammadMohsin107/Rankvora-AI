import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Building2,
  Check,
  RefreshCw,
  ShieldCheck,
  Store,
  Target,
  type LucideIcon,
} from 'lucide-react';
import RankvoraLogo from '../../components/auth/RankvoraLogo';
import {
  ActionButton,
  StepHeader,
  StepRail,
  Stepper,
} from '../../components/onboarding/OnboardingPrimitives';
import {
  StepBusiness,
  StepMeasurement,
  StepPermissions,
  StepPriorities,
  StepStore,
  type StepProps,
} from '../../components/onboarding/OnboardingSteps';
import { describeGoogleOutcome } from '../../data/google.repository';
import {
  REQUIRED_FIELD_MESSAGE,
  STEP_META,
  TOTAL_STEPS,
  completeOnboarding,
  describeOnboardingError,
  fetchOnboarding,
  fetchOnboardingSuggestions,
  firstUnansweredStep,
  missingRequired,
  saveOnboardingStep,
  type OnboardingSnapshot,
  type OnboardingSuggestions,
  type RequiredField,
  type StepPayload,
} from '../../data/onboarding.repository';

/**
 * ─── Guided setup ────────────────────────────────────────────────────
 *
 * Five steps, shown on their own page rather than inside the app shell: a merchant answering
 * these has nothing to navigate to yet, and a sidebar full of empty dashboards is a distraction
 * from the only task on screen.
 *
 * TWO PANES, ONE RAISED SURFACE. A progress rail sits beside the step on large screens, drawn
 * directly on the page wash with no border of its own, so the step card is the only lifted thing
 * on screen and is unambiguously the thing to act on. Below `lg` the rail becomes a segmented bar
 * across the top of the card. The step's fields pair up in two columns, so most steps fit with
 * little scrolling, and the action bar is pinned to the bottom of the card so the primary action
 * is always in reach on the longer ones.
 *
 * FOUR STEPS ARE REQUIRED, ONE IS NOT. Confirming the store, the business, the priorities and the
 * permissions must be answered before Continue will move. The measurement step (4) is optional: a
 * merchant who has no Search Console to connect passes straight through, and nothing about that is
 * held against them. Not every FIELD of a required step is required either — most are optional, and
 * the few that are carry a badge. Finish checks every required step, not just the last one.
 * `missingRequired` in the repository holds that rule and mirrors the server's, which decides.
 *
 * BEING STOPPED IS EXPLAINED WHERE IT HAPPENS. The missing field goes red and says what to enter,
 * and the action bar says how many answers are outstanding. A disabled Continue button with no
 * explanation would leave a merchant to work out for themselves which of a dozen fields it meant.
 *
 * ONE PRIMARY ACTION PER STEP. Back sits on the left and Continue is the only filled button in the
 * bar. The one way to leave setup early is reserved for a merchant editing finished answers —
 * "Save and close" in the header returns them to the app they came from, which is not the same
 * thing as abandoning setup.
 *
 * ONE DRAFT, HELD HERE. The step components are presentational, so switching steps cannot lose an
 * answer to a component unmounting. Each step is persisted when the merchant leaves it, which is
 * what makes a reload — or the same store on another device — resume exactly where they were. It
 * is also why the draft can be checked as a whole: every answer the merchant has given is in it,
 * not only the ones on screen.
 *
 * NOTHING IS PRE-FILLED. Every field opens empty unless the merchant saved an answer to it. What
 * Shopify tells us about the store is shown beside a field as a one-click suggestion, never written
 * into it: each step is saved on Continue and Skip, so a value placed in a field for the merchant
 * would be stored as their answer, tick the step as complete, and reappear on every reload as if
 * they had typed it.
 */

const STEP_FIELDS: Record<number, Array<keyof StepPayload>> = {
  1: ['organizationName', 'primaryDomain', 'targetCountries', 'targetLanguages', 'primaryMarket'],
  2: ['brandName', 'brandedTerms', 'industries', 'sellsDescription', 'contentLanguage'],
  3: ['priorityPillars', 'targetKeywords', 'competitorDomains', 'priorityResources', 'customerQuestions'],
  // Nothing is stored for measurement: whether a source is connected is read from the connection.
  4: [],
  5: ['automationConsent', 'alertFrequency', 'protectedPaths', 'autoAnalysis', 'analysisFrequency', 'preferredScanHour'],
};

const STEP_COMPONENTS: Record<number, (props: StepProps) => ReactElement> = {
  1: StepStore,
  2: StepBusiness,
  3: StepPriorities,
  4: StepMeasurement,
  5: StepPermissions,
};

const STEP_ICONS: Record<number, LucideIcon> = {
  1: Store,
  2: Building2,
  3: Target,
  4: BarChart3,
  5: ShieldCheck,
};

/**
 * Where setup opens. A merchant who has answered nothing always starts at step 1.
 *
 * Derived from what is actually answered, not from the stored `currentStep` pointer: setup opens at
 * the first step that is neither answered nor deliberately skipped. The pointer only ever moved
 * forward, so clearing an earlier answer — or pressing Continue past steps without answering them —
 * could still send the merchant to a later step than the first one that needs them. A completed
 * setup opens at step 1, because arriving then means reviewing answers from the top.
 */
function openingStep(state: OnboardingSnapshot): number {
  if (state.completedAt) return 1;
  const firstOpen = [...state.progress]
    .sort((a, b) => a.step - b.step)
    // The first step still owed — OR the optional step the merchant has reached but not passed. The
    // stored pointer only moves past an optional step once they have continued from it, so resuming
    // after step 3 lands on measurement (which they have not seen) and resuming after step 4 does
    // not drag them back to it just because Google is still unconnected.
    .find((entry) => entry.status !== 'complete' && (entry.required || entry.step === state.currentStep));
  return firstOpen?.step ?? TOTAL_STEPS;
}

/**
 * The starting draft: what the merchant has saved, from both places it is stored. Fields the
 * merchant has never answered stay absent — nothing is filled in on their behalf.
 *
 * `autoAnalysis` and `analysisFrequency` ARE shown as their current values, because they are real
 * settings that already take effect on the store (scheduled analysis is on, weekly, by default);
 * showing them blank would hide a schedule that is genuinely running.
 */
function startingDraft(state: OnboardingSnapshot, opening: number): StepPayload {
  const { preferences, schedule, answers } = state;
  return {
    step: opening,
    ...answers,
    contentLanguage: preferences.contentLanguage,
    priorityResources: preferences.priorityResources,
    protectedPaths: preferences.protectedPaths,
    preferredScanHour: preferences.preferredScanHour,
    autoAnalysis: schedule.enabled,
    analysisFrequency: schedule.frequency,
    // New questions only. Ones already tracked come back as `trackedQuestions` and are listed there.
    customerQuestions: [],
  };
}

export default function Onboarding() {
  const navigate = useNavigate();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Set when Google has just sent the merchant back from connecting. Read from the URL ONCE, then the
   * parameters are stripped, so a refresh does not replay a message about something already seen.
   */
  const [googleNotice, setGoogleNotice] = useState<ReturnType<typeof describeGoogleOutcome>>(null);
  const returnedFromGoogle = useRef(false);

  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [suggestions, setSuggestions] = useState<OnboardingSuggestions | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [draft, setDraft] = useState<StepPayload>({ step: 1 });
  const [step, setStep] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RequiredField, string>>>({});
  /** How many times the merchant has been stopped for a missing answer. Drives the scroll below. */
  const [stopCount, setStopCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const patch = useCallback((changes: Partial<StepPayload>) => {
    setDraft((previous) => ({ ...previous, ...changes }));
    setSaveError(null);
    // The moment a flagged field is touched it stops being flagged. Whether the new value actually
    // satisfies the requirement is decided on Continue — re-judging mid-keystroke would put the
    // field back in the red on the way to a perfectly good answer.
    setFieldErrors((previous) => {
      const remaining = { ...previous };
      for (const key of Object.keys(changes)) delete remaining[key as RequiredField];
      return remaining;
    });
  }, []);

  // A new step starts at its top. The action bar is pinned to the bottom, so without this the
  // merchant would land halfway down the next step with its heading scrolled out of view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    // Inside the Shopify admin the PAGE scrolls, not the container above (index.css releases html, body and
    // #root from a fixed height there), so the container has nothing to scroll and the window must go to the top.
    window.scrollTo({ top: 0 });
  }, [step]);

  // Being stopped is no use if the field is off-screen. Declared after the scroll-to-top above so
  // that on a jump back to an earlier step this wins: the merchant lands on the answer they owe,
  // with the cursor already in it where it can take one.
  //
  // Keyed on the COUNT of times they have been stopped, not on the errors themselves: clearing one
  // flag while another is still outstanding must not yank the cursor across the form mid-sentence.
  useEffect(() => {
    if (stopCount === 0) return;
    const flagged = scrollRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!flagged) return;
    flagged.scrollIntoView({ block: 'center' });
    // Card groups flag the section, which cannot take focus — for those, the message and the
    // scroll are the whole signal.
    if (flagged instanceof HTMLInputElement || flagged instanceof HTMLSelectElement) {
      flagged.focus({ preventScroll: true });
    }
  }, [stopCount]);

  // ── Initial load ───────────────────────────────────────────────────
  // Runs once on arrival: it reads and then clears the ?google= result from the address, so re-running
  // when the address changes would be wrong. Hence no `location.search` in the dependencies below.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    let cancelled = false;

    // Coming back from Google: remember the outcome, and clear it from the address.
    const params = new URLSearchParams(location.search);
    const outcome = describeGoogleOutcome(params.get('google'), params.get('reason'));
    if (outcome) {
      returnedFromGoogle.current = true;
      setGoogleNotice(outcome);
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }

    (async () => {
      try {
        const state = await fetchOnboarding();
        if (cancelled) return;

        // A completed setup is not redirected away — the gate never sends anyone here once it is
        // finished, so arriving with `completedAt` set means the merchant came deliberately to
        // change an answer. The page becomes an edit surface, and saving leaves it complete.
        // Returning from Google always lands on measurement, which is where they were.
        const opening = returnedFromGoogle.current ? 4 : openingStep(state);
        setSnapshot(state);
        setStep(opening);

        // Only what the merchant saved. Shopify's values are offered by the steps as suggestions.
        setDraft(startingDraft(state, opening));
      } catch (error) {
        if (!cancelled) setLoadError(describeOnboardingError(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // ── Catalogue-derived suggestions ──────────────────────────────────
  // Fetched once, in parallel with the merchant reading step 1, so steps 2–4 are ready when they
  // arrive rather than making them wait on a catalogue read. Shown as suggestions only.
  useEffect(() => {
    if (!snapshot?.connected) {
      setSuggestionsLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const derived = await fetchOnboardingSuggestions();
        if (!cancelled) setSuggestions(derived);
      } catch {
        // Suggestions are an accelerant, not a dependency. A failure leaves the fields empty and
        // the steps say so — it never blocks setup.
        if (!cancelled) setSuggestions(null);
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshot?.connected]);

  /** Only the current step's fields, so a save can never write across the form. */
  const payloadForStep = (target: number): StepPayload => {
    const payload: StepPayload = { step: target };
    for (const field of STEP_FIELDS[target]) {
      const value = draft[field];
      if (value !== undefined) Object.assign(payload, { [field]: value });
    }
    return payload;
  };

  const persist = async (target: number): Promise<OnboardingSnapshot | null> => {
    try {
      const saved = await saveOnboardingStep(payloadForStep(target));
      setSnapshot(saved);
      // The questions just sent are tracked now and come back in `trackedQuestions`; leaving them in
      // the draft would offer to add them again on the next save.
      if (target === 3) setDraft((previous) => ({ ...previous, customerQuestions: [] }));
      return saved;
    } catch (error) {
      setSaveError(describeOnboardingError(error));
      return null;
    }
  };

  /** Marks every required answer `target` is missing, and returns them. */
  const flagMissing = (target: number): RequiredField[] => {
    const missing = missingRequired(target, draft);
    if (missing.length > 0) {
      setFieldErrors(Object.fromEntries(missing.map((field) => [field, REQUIRED_FIELD_MESSAGE[field]])));
      setStopCount((count) => count + 1);
    }
    return missing;
  };

  /**
   * Flags what `target` is missing and says so in the action bar. Returns true when it is answered.
   *
   * Nothing is saved and nothing moves when this fails: the merchant stays exactly where they are,
   * with the fields they still owe marked.
   */
  const requireAnswers = (target: number): boolean => {
    const missing = flagMissing(target);
    if (missing.length === 0) return true;

    setSaveError(
      missing.length === 1
        ? 'One answer is still needed on this step.'
        : `${missing.length} answers are still needed on this step.`,
    );
    return false;
  };

  const goTo = async (target: number) => {
    if (busy) return;
    // Forward only. Going back to review an earlier step is always allowed — it is the way a
    // merchant fixes the very answer they are being asked for.
    if (target > step && !requireAnswers(step)) return;

    setBusy(true);
    // Save what is on screen before moving, in both directions — going back to review step 2 must
    // not discard what was typed on step 3.
    const saved = await persist(step);
    setBusy(false);
    if (saved) {
      setFieldErrors({});
      setStep(Math.min(TOTAL_STEPS, Math.max(1, target)));
    }
  };

  /**
   * Leaving an edit session. Only reachable once setup is complete: the merchant came from the app
   * to change an answer, so saving the step they are on and handing them back the app is the whole
   * job — there is nothing to defer, setup is already finished.
   *
   * Still holds the step to its required answers. Saving a cleared one on the way out would leave
   * a setup marked complete over an answer that is no longer there.
   */
  const onSaveAndClose = async () => {
    if (busy) return;
    if (!requireAnswers(step)) return;
    setBusy(true);
    const saved = await persist(step);
    if (!saved) {
      setBusy(false);
      return;
    }
    navigate('/', { replace: true });
  };

  const onFinish = async () => {
    if (busy) return;
    if (!requireAnswers(TOTAL_STEPS)) return;

    // Every step, not just this one. An answer can be cleared on a step the merchant went back to,
    // and the server refuses to finish while any of them is short — so rather than let it 400,
    // take them to the step that needs them and flag the field there.
    const unanswered = firstUnansweredStep(draft);
    if (unanswered !== null) {
      setStep(unanswered);
      flagMissing(unanswered);
      setSaveError(`${STEP_META[unanswered - 1].title} still needs an answer.`);
      return;
    }

    setBusy(true);
    try {
      const saved = await persist(TOTAL_STEPS);
      if (!saved) {
        setBusy(false);
        return;
      }
      await completeOnboarding();
      navigate('/', { replace: true });
    } catch (error) {
      setSaveError(describeOnboardingError(error));
      setBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <Frame scrollRef={scrollRef}>
        <Card>
          <div className="px-5 py-6 text-center sm:px-8 sm:py-7">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-100">
              <AlertTriangle size={20} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <h1 className="mt-3.5 text-[17px] font-semibold tracking-[-0.02em] text-surface-950">
              Setup could not be loaded
            </h1>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-[1.55] text-surface-500">{loadError}</p>
            <div className="mt-4 flex justify-center">
              <ActionButton onClick={() => window.location.reload()}>
                <RefreshCw size={16} aria-hidden="true" />
                Try again
              </ActionButton>
            </div>
          </div>
        </Card>
      </Frame>
    );
  }

  if (!snapshot) return <LoadingFrame scrollRef={scrollRef} />;

  // Setup's suggestions all come from the connected store, so there is nothing useful to do
  // without one. Sending the merchant to connect is the only honest next step.
  if (!snapshot.connected) {
    return (
      <Frame scrollRef={scrollRef}>
        <Card>
          <div className="px-5 py-6 sm:px-8 sm:py-7">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-200/70">
              <Store size={20} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <h1 className="mt-3.5 text-[18px] font-semibold leading-[1.15] tracking-[-0.02em] text-surface-950 sm:text-[21px]">
              Connect Shopify first
            </h1>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
              <ActionButton onClick={() => navigate('/integrations')}>
                Connect Shopify
                <ArrowRight size={16} aria-hidden="true" />
              </ActionButton>
              <ActionButton variant="ghost" onClick={() => navigate('/')}>
                Skip for now
              </ActionButton>
            </div>
          </div>
        </Card>
      </Frame>
    );
  }

  const meta = STEP_META[step - 1];
  const StepComponent = STEP_COMPONENTS[step];
  const editing = Boolean(snapshot.completedAt);
  const stepperSteps = STEP_META.map((entry) => ({
    step: entry.step,
    title: entry.title,
    status: snapshot.progress.find((progress) => progress.step === entry.step)?.status ?? 'pending',
    optional: entry.optional,
  }));
  const jump = (target: number) => void goTo(target);

  return (
    <Frame
      scrollRef={scrollRef}
      rail={<StepRail current={step} steps={stepperSteps} onJump={jump} />}
      // Nothing in the header during first-time setup: the steps themselves are the way through,
      // and each one can be skipped. Editing finished answers is the one case that needs a way
      // back to the app the merchant came from.
      exit={editing ? { label: 'Save and close', onClick: () => void onSaveAndClose(), disabled: busy } : undefined}
    >
      <Card>
        {editing && (
          <div className="flex items-start gap-2 rounded-t-xl border-b border-success-100 bg-success-50 px-3.5 py-1.5 sm:px-5">
            <Check size={15} className="mt-px flex-shrink-0 text-success-700" aria-hidden="true" />
            <p className="text-[12px] leading-[1.45] text-success-700">
              Setup is complete. Edit any step.
            </p>
          </div>
        )}

        <div className="border-b border-surface-200 lg:hidden">
          <Stepper current={step} steps={stepperSteps} onJump={jump} />
        </div>

        <StepHeader step={step} total={TOTAL_STEPS} title={meta.title} purpose={meta.purpose} icon={STEP_ICONS[step]} />

        {/* Keyed on the step so each one enters rather than swapping in place — the card is the only
            thing that changes between steps, and without this the transition is invisible. */}
        <div key={step} className="px-3.5 py-3.5 motion-safe:animate-fade-in sm:px-5 sm:py-4">
          <StepComponent
            draft={draft}
            patch={patch}
            snapshot={snapshot}
            suggestions={suggestions}
            suggestionsLoading={suggestionsLoading}
            errors={fieldErrors}
            notice={googleNotice}
          />
        </div>

        <footer className="sticky bottom-0 z-10 rounded-b-xl border-t border-surface-200 bg-surface-0/95 px-3.5 py-2 backdrop-blur-sm sm:px-5">
          {saveError && (
            <p
              role="alert"
              className="mb-2 flex items-start gap-2 rounded-lg bg-critical-50 px-3 py-1.5 text-[12px] font-medium leading-[1.5] text-critical-700"
            >
              <AlertTriangle size={14} className="mt-px flex-shrink-0" aria-hidden="true" />
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            {step > 1 && (
              <ActionButton variant="ghost" onClick={() => void goTo(step - 1)} disabled={busy}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </ActionButton>
            )}

            {/* ml-auto keeps the forward action on the right even when the bar wraps on a phone.
                There is nothing beside it: every step is required, so the only way forward is
                through this button. */}
            <div className="ml-auto flex flex-1 items-center justify-end gap-2.5 sm:flex-none">
              {step < TOTAL_STEPS ? (
                <ActionButton loading={busy} onClick={() => void goTo(step + 1)} className="flex-1 sm:flex-none">
                  {busy ? 'Saving…' : editing ? 'Next' : step === 1 ? 'Confirm and continue' : 'Continue'}
                  {!busy && <ArrowRight size={16} aria-hidden="true" />}
                </ActionButton>
              ) : (
                <ActionButton loading={busy} onClick={() => void onFinish()} className="flex-1 sm:flex-none">
                  {busy ? 'Saving…' : editing ? 'Save changes' : 'Finish setup'}
                  {!busy && <Check size={16} aria-hidden="true" />}
                </ActionButton>
              )}
            </div>
          </div>
        </footer>
      </Card>
    </Frame>
  );
}

/**
 * The page frame: logo, an optional progress rail, and the step card.
 *
 * `h-full`, not `min-h-full`: outside the Shopify admin html, body and #root are fixed to the viewport
 * with overflow hidden, so this div must be exactly viewport-high to become the scroll container. With
 * `min-h-full` it grew to fit the card and the bottom of a long step was clipped with no way to scroll
 * to it.
 *
 * `min-h-screen` is for INSIDE the admin, where the page itself scrolls and #root has no fixed height
 * (index.css, data-embedded): `h-full` then resolves to the card's own height and the backdrop would stop
 * partway down the window. A full viewport minimum keeps it full-bleed, and a longer step simply makes
 * the page scroll.
 *
 * There, too, this wrapper must NOT be a scroll container, which `.onboarding-frame` in index.css sees
 * to. Left as `overflow-y: auto` with `overscroll-behavior: contain`, it was a scroller that had nothing
 * to scroll, and the browser still handed it the mouse wheel and refused to pass it on to the page — so
 * a step taller than the window could not be scrolled at all.
 *
 * Without a rail (loading, errors, not connected) the card is centred at a reading width.
 */
function Frame({
  children,
  rail,
  exit,
  scrollRef,
}: {
  children: ReactNode;
  rail?: ReactNode;
  /**
   * A way back to the app, in the header rather than competing with Continue. Only an edit session
   * has one — first-time setup is a flow to be walked, not a page to be left.
   */
  exit?: { label: string; onClick: () => void; disabled?: boolean };
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={scrollRef}
      className="onboarding-frame h-full min-h-screen overflow-y-auto overscroll-contain bg-surface-50"
      /**
       * Three layers, front to back.
       *
       * 1. `onboarding-bg.svg` — a bespoke, purely decorative backdrop: a sweep of hairline arcs
       *    over a fading dot field. Drawn for this app rather than sourced, so there is no licence
       *    to honour and no stock photograph to date the product. It carries NO text and nothing
       *    that reads as a measurement — a backdrop resembling a chart would be a picture of data
       *    nobody produced, behind a form where the merchant has told us nothing yet.
       *
       * 2–3. The brand wash, kept from before and still built from theme tokens, so the colour
       *    follows light and dark mode rather than being fixed by the artwork.
       *
       * The SVG's inks are mid-tone indigo and the logo's emerald at low alpha, which sit
       * correctly on both washes — an SVG used as a CSS background cannot read the page's custom
       * properties, so a token-coloured artwork is not available without shipping two files.
       *
       * The dot texture is the FIRST layer and lives here rather than in the file: a 28px grid
       * stated in CSS pixels stays crisp at any viewport, where the same dots inside a `cover`-
       * scaled artwork would grow with the window and coarsen on a large display.
       *
       * `cover` + `fixed` on the artwork: the background box for a fixed layer is the viewport, so
       * it is full-bleed on an ultrawide and on a laptop alike, and it holds still while the step
       * scrolls over it — a backdrop that scrolled with a long step would read as wallpaper.
       */
      style={{
        backgroundImage: [
          'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.09) 1px, transparent 0)',
          'url(/onboarding-bg.svg)',
          'radial-gradient(1100px 460px at 50% -160px, var(--c-brand-100), transparent 70%)',
          'radial-gradient(700px 420px at 0% 100%, var(--c-brand-50), transparent 65%)',
        ].join(', '),
        backgroundSize: '28px 28px, cover, auto, auto',
        backgroundPosition: 'top center, top center, top center, bottom left',
        backgroundRepeat: 'repeat, no-repeat, no-repeat, no-repeat',
        backgroundAttachment: 'fixed, fixed, scroll, scroll',
      }}
    >
      {/* Compacted to the density the rest of the app uses. Setup was laid out like a marketing
          page — 1180px wide on a 6-unit gutter, with a 6-unit gap to the rail — and on a laptop
          that pushed the action bar off the fold on the longer steps, so merchants scrolled to
          find Continue on every one of the five. */}
      <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col px-3 py-3 sm:px-5 lg:py-4">
        <header className="mb-3 flex items-center justify-between gap-3">
          <RankvoraLogo />
          {exit && (
            // Tighter on a phone: the logo and this button share a 320px row, and "Save and close"
            // at full padding pushed the pair past the viewport.
            <ActionButton
              variant="secondary"
              onClick={exit.onClick}
              disabled={exit.disabled}
              className="px-3 text-[13px] sm:px-4"
            >
              {exit.label}
            </ActionButton>
          )}
        </header>

        {rail ? (
          <div className="grid flex-1 items-start gap-4 lg:grid-cols-[212px_minmax(0,1fr)] xl:gap-5">
            <aside className="hidden lg:sticky lg:top-4 lg:block">{rail}</aside>
            <div className="min-w-0">{children}</div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-2xl">{children}</div>
        )}
      </div>
    </div>
  );
}

/**
 * What the merchant sees for the one request that decides which step opens.
 *
 * A skeleton of the real layout rather than a spinner on a line: the page it resolves into is a
 * rail beside a card, so showing that shape immediately means nothing jumps when the data lands.
 */
function LoadingFrame({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const bar = 'animate-pulse rounded-md bg-surface-200 motion-reduce:animate-none';
  return (
    <Frame
      scrollRef={scrollRef}
      rail={
        <div className="flex flex-col gap-4" aria-hidden="true">
          <div className="flex items-center gap-3">
            <div className={`${bar} h-[44px] w-[44px] rounded-full`} />
            <div className="flex-1 space-y-2">
              <div className={`${bar} h-3 w-24`} />
              <div className={`${bar} h-3 w-20`} />
            </div>
          </div>
          <div className="space-y-4 px-3">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex items-center gap-3.5">
                <div className={`${bar} h-7 w-7 rounded-full`} />
                <div className={`${bar} h-3 flex-1`} style={{ maxWidth: `${120 - index * 8}px` }} />
              </div>
            ))}
          </div>
        </div>
      }
    >
      <Card>
        <div role="status" aria-live="polite" className="px-4 py-4 sm:px-6 sm:py-5">
          <span className="sr-only">Loading your store…</span>
          <div aria-hidden="true">
            <div className="flex items-start gap-4">
              <div className={`${bar} h-11 w-11 flex-shrink-0 rounded-xl`} />
              <div className="min-w-0 flex-1 space-y-3">
                <div className={`${bar} h-2.5 w-20`} />
                <div className={`${bar} h-6 w-56 max-w-full`} />
                <div className={`${bar} h-3 w-full max-w-md`} />
              </div>
            </div>
            <div className="mt-6 grid gap-x-5 gap-y-5 md:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="space-y-2">
                  <div className={`${bar} h-3 w-32`} />
                  <div className={`${bar} h-2.5 w-44 max-w-full`} />
                  <div className={`${bar} h-9 w-full rounded-lg`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </Frame>
  );
}

/** No `overflow-hidden`: it would stop the action bar from sticking. Corners are rounded on the
 * first and last children instead. */
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-surface-200 bg-surface-0 shadow-[0_18px_44px_-32px_var(--c-shadow-lg)]">
      {children}
    </div>
  );
}
