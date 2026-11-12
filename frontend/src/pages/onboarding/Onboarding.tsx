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
  PILLAR_GOALS,
  StepBusiness,
  StepMeasurement,
  StepPermissions,
  StepPriorities,
  StepStore,
  type StepProps,
} from '../../components/onboarding/OnboardingSteps';
import SetupComplete, { type CompletionRow } from '../../components/onboarding/SetupComplete';
import { isPillarVisible } from '../../config/modules';
import { describeGoogleOutcome } from '../../data/google.repository';
import {
  REQUIRED_FIELD_MESSAGE,
  STEP_META,
  consentLabel,
  TOTAL_STEPS,
  completeOnboarding,
  describeOnboardingError,
  fetchOnboarding,
  fetchOnboardingSuggestions,
  firstUnansweredStep,
  invalidAnswers,
  missingRequired,
  saveOnboardingStep,
  type OnboardingSnapshot,
  type InvalidField,
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
 * A GUIDE AND ONE RAISED SURFACE. On large screens a guide sits beside the step — a progress bar and
 * the five steps on one vertical line — drawn directly on the page with no border of its own, so the
 * sheet the step sits on is the only lifted thing on screen and is unambiguously the thing to act on.
 * Below `lg` the guide becomes a segmented bar above the sheet. The step's fields pair up in two
 * columns, so most steps fit with little scrolling, and the actions live in a dock that floats under
 * the sheet and stays in reach while a long step scrolls. The look is described in
 * components/onboarding/OnboardingPrimitives.tsx.
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
  /** True when the request for the store's details failed — the steps then say so and offer a retry. */
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  /** False once the page has gone, so a late answer is dropped instead of set on an unmounted page. */
  const alive = useRef(true);
  const [draft, setDraft] = useState<StepPayload>({ step: 1 });
  const [step, setStep] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RequiredField | InvalidField, string>>>({});
  /** How many times the merchant has been stopped for a missing answer. Drives the scroll below. */
  const [stopCount, setStopCount] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Set once setup has been saved and marked complete — the screen then reads the answers back. */
  const [finished, setFinished] = useState(false);

  const patch = useCallback((changes: Partial<StepPayload>) => {
    setDraft((previous) => ({ ...previous, ...changes }));
    setSaveError(null);
    // The moment a flagged field is touched it stops being flagged. Whether the new value actually
    // satisfies the requirement is decided on Continue — re-judging mid-keystroke would put the
    // field back in the red on the way to a perfectly good answer.
    setFieldErrors((previous) => {
      const remaining = { ...previous };
      for (const key of Object.keys(changes)) delete remaining[key as RequiredField | InvalidField];
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

  // ── The store's details ────────────────────────────────────────────
  // Read once, in parallel with the merchant reading step 1, so the later steps have their suggestions
  // ready instead of making the merchant wait on a catalogue read. They are SUGGESTIONS: setup never
  // depends on them, so a failure does not block anything — but it is not silent either. It is
  // recorded, the steps say so, and the merchant can ask again without reloading the page.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const derived = await fetchOnboardingSuggestions();
      if (!alive.current) return;
      setSuggestions(derived);
      setSuggestionsFailed(false);
    } catch {
      if (!alive.current) return;
      setSuggestions(null);
      setSuggestionsFailed(true);
    } finally {
      if (alive.current) setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!snapshot?.connected) {
      setSuggestionsLoading(false);
      return;
    }
    void loadSuggestions();
  }, [snapshot?.connected, loadSuggestions]);

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

  /**
   * Marks, on the step `target`, every required answer that is missing AND every answer that is filled
   * in but cannot be saved (an address that is not one), and returns the missing ones.
   */
  const flagMissing = (target: number): RequiredField[] => {
    const missing = missingRequired(target, draft);
    const invalid = invalidAnswers(target, draft);
    if (missing.length > 0 || Object.keys(invalid).length > 0) {
      setFieldErrors({ ...Object.fromEntries(missing.map((field) => [field, REQUIRED_FIELD_MESSAGE[field]])), ...invalid });
      setStopCount((count) => count + 1);
    }
    return missing;
  };

  /**
   * Flags what `target` is missing or has wrong and says so in the action bar. Returns true when it is
   * all in order.
   *
   * Nothing is saved and nothing moves when this fails: the merchant stays exactly where they are,
   * with the fields that need them marked. An address the server would refuse is caught here, at its
   * field, rather than after the save with a message in the action bar.
   */
  const requireAnswers = (target: number): boolean => {
    const missing = flagMissing(target);
    const invalid = Object.keys(invalidAnswers(target, draft)).length;
    if (missing.length === 0 && invalid === 0) return true;

    if (invalid === 0) {
      setSaveError(
        missing.length === 1
          ? 'One answer is still needed on this step.'
          : `${missing.length} answers are still needed on this step.`,
      );
    } else if (missing.length === 0) {
      setSaveError(invalid === 1 ? 'Check the highlighted answer on this step.' : 'Check the highlighted answers on this step.');
    } else {
      setSaveError(`${missing.length + invalid} answers need attention on this step.`);
    }
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
      setBusy(false);
      setFinished(true);
      // The step's own scroll position belongs to the form, not to this screen.
      scrollRef.current?.scrollTo({ top: 0 });
      window.scrollTo({ top: 0 });
    } catch (error) {
      setSaveError(describeOnboardingError(error));
      setBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <Frame scrollRef={scrollRef}>
        <Sheet>
          <div className="px-6 py-10 text-center sm:px-10 sm:py-12">
            <StateMark tone="warning">
              <AlertTriangle size={22} strokeWidth={1.8} aria-hidden="true" />
            </StateMark>
            <h1 className="mt-5 text-balance text-[22px] font-semibold leading-[1.15] tracking-[-0.03em] text-surface-950">
              Setup could not be loaded
            </h1>
            <p className="mx-auto mt-2 max-w-md text-pretty text-[14px] leading-[1.6] text-surface-500">{loadError}</p>
            <div className="mt-6 flex justify-center">
              <ActionButton onClick={() => window.location.reload()}>
                <RefreshCw size={16} aria-hidden="true" />
                Try again
              </ActionButton>
            </div>
          </div>
        </Sheet>
      </Frame>
    );
  }

  if (!snapshot) return <LoadingFrame scrollRef={scrollRef} />;

  // Setup's suggestions all come from the connected store, so there is nothing useful to do
  // without one. Sending the merchant to connect is the only honest next step.
  if (!snapshot.connected) {
    return (
      <Frame scrollRef={scrollRef}>
        <Sheet>
          <div className="px-6 py-10 sm:px-10 sm:py-12">
            <StateMark tone="brand">
              <Store size={22} strokeWidth={1.8} aria-hidden="true" />
            </StateMark>
            <h1 className="mt-5 text-balance text-[28px] font-semibold leading-[1.1] tracking-[-0.035em] text-surface-950 sm:text-[36px]">
              Connect Shopify first
            </h1>

            <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <ActionButton onClick={() => navigate('/integrations')}>
                Connect Shopify
                <ArrowRight size={16} aria-hidden="true" />
              </ActionButton>
              <ActionButton variant="ghost" onClick={() => navigate('/')}>
                Skip for now
              </ActionButton>
            </div>
          </div>
        </Sheet>
      </Frame>
    );
  }

  // Setup just finished: say so, and read back what was saved, before the dashboard.
  if (finished) {
    return (
      <Frame scrollRef={scrollRef}>
        <Sheet>
          <SetupComplete rows={completionRows(draft)} onContinue={() => navigate('/', { replace: true })} />
        </Sheet>
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
      {/* Below `lg` the guide is gone, so progress rides on top of the step instead. */}
      <div className="mb-3 rounded-2xl bg-surface-0/80 px-4 pb-2 pt-1 ring-1 ring-inset ring-surface-200/70 backdrop-blur-sm lg:hidden">
        <Stepper current={step} steps={stepperSteps} onJump={jump} />
      </div>

      <Sheet>
        {editing && (
          <div className="relative flex items-center gap-2 rounded-t-[22px] border-b border-success-100 bg-success-50 px-5 py-2.5 sm:px-10">
            <Check size={15} className="flex-shrink-0 text-success-700" aria-hidden="true" />
            <p className="text-[12.5px] font-medium leading-[1.45] text-success-700">Setup is complete. Edit any step.</p>
          </div>
        )}

        <StepHeader step={step} total={TOTAL_STEPS} title={meta.title} purpose={meta.purpose} icon={STEP_ICONS[step]} />

        {/* Keyed on the step so each one enters rather than swapping in place — the sheet is the only
            thing that changes between steps, and without this the transition is invisible. */}
        <div key={step} className="relative px-5 pb-10 pt-8 motion-safe:animate-fade-in sm:px-10 sm:pb-12">
          <StepComponent
            draft={draft}
            patch={patch}
            snapshot={snapshot}
            suggestions={suggestions}
            suggestionsLoading={suggestionsLoading}
            suggestionsFailed={suggestionsFailed}
            onRetrySuggestions={() => void loadSuggestions()}
            errors={fieldErrors}
            notice={googleNotice}
          />
        </div>
      </Sheet>

      {/* The action dock floats under the sheet and stays in reach while a long step scrolls. It is a
          separate surface from the sheet, so the primary action never sits inside the form it
          submits. */}
      <footer className="sticky bottom-3 z-10 mt-4 rounded-2xl bg-surface-0/85 p-2.5 shadow-[0_18px_40px_-20px_var(--c-shadow-lg),0_2px_8px_-2px_var(--c-shadow-md)] ring-1 ring-inset ring-surface-200/80 backdrop-blur-xl sm:p-3">
        {saveError && (
          <p
            role="alert"
            className="mb-2.5 flex items-start gap-2 rounded-xl bg-critical-50 px-3.5 py-2.5 text-[13px] font-medium leading-[1.5] text-critical-700 ring-1 ring-inset ring-critical-100"
          >
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
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

          <p className="hidden px-1 text-[12.5px] font-medium tabular-nums text-surface-500 sm:block">
            {step} / {TOTAL_STEPS}
          </p>

          {/* ml-auto keeps the forward action on the right even when the bar wraps on a phone.
              There is nothing beside it: every step is required, so the only way forward is
              through this button. */}
          <div className="ml-auto flex flex-1 items-center justify-end gap-2.5 sm:flex-none">
            {step < TOTAL_STEPS ? (
              <ActionButton loading={busy} onClick={() => void goTo(step + 1)} className="flex-1 sm:min-w-48 sm:flex-none">
                {busy ? 'Saving…' : editing ? 'Next' : step === 1 ? 'Confirm and continue' : 'Continue'}
                {!busy && <ArrowRight size={16} aria-hidden="true" />}
              </ActionButton>
            ) : (
              <ActionButton loading={busy} onClick={() => void onFinish()} className="flex-1 sm:min-w-48 sm:flex-none">
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Finish setup'}
                {!busy && <Check size={16} aria-hidden="true" />}
              </ActionButton>
            )}
          </div>
        </div>
      </footer>
    </Frame>
  );
}

/**
 * What the completion screen reads back: the merchant's own saved answers, in plain words.
 *
 * A row is left out when its answer is empty rather than shown as "none": an optional question that
 * was not answered is not something to announce at the end.
 */
function completionRows(draft: StepPayload): CompletionRow[] {
  const rows: CompletionRow[] = [];
  const add = (label: string, value: string | undefined | null) => {
    if (value && value.trim()) rows.push({ label, value });
  };
  add('Store', draft.organizationName);
  const markets = draft.targetCountries ?? [];
  add('Markets', markets.length > 0 ? markets.join(', ') : null);
  const industries = draft.industries ?? [];
  add('Industry', industries.length > 0 ? industries.join(', ') : null);
  const focus = (draft.priorityPillars ?? []).filter(isPillarVisible).map((key) => PILLAR_GOALS[key]?.label ?? key);
  add('Improve first', focus.length > 0 ? focus.join(' → ') : null);
  add('Change approval', draft.automationConsent ? consentLabel(draft.automationConsent) : null);
  if (draft.autoAnalysis !== undefined) {
    add('Scheduled analysis', draft.autoAnalysis ? (draft.analysisFrequency ?? 'On') : 'Off');
  }
  return rows;
}

/**
 * The page frame: an ambient backdrop, the guide beside the step, and (without a guide) a centred sheet.
 *
 * SCROLLING IS NOT NEGOTIABLE, and none of the design below changes it.
 * `h-full`, not `min-h-full`: outside the Shopify admin html, body and #root are fixed to the viewport
 * with overflow hidden, so this div must be exactly viewport-high to become the scroll container. With
 * `min-h-full` it grew to fit the sheet and the bottom of a long step was clipped with no way to scroll
 * to it.
 *
 * `min-h-screen` is for INSIDE the admin, where the page itself scrolls and #root has no fixed height
 * (index.css, data-embedded): `h-full` then resolves to the sheet's own height and the backdrop would
 * stop partway down the window. A full viewport minimum keeps it full-bleed, and a longer step simply
 * makes the page scroll.
 *
 * There, too, this wrapper must NOT be a scroll container, which `.onboarding-frame` in index.css sees
 * to. Left as `overflow-y: auto` with `overscroll-behavior: contain`, it was a scroller that had nothing
 * to scroll, and the browser still handed it the mouse wheel and refused to pass it on to the page — so
 * a step taller than the window could not be scrolled at all.
 *
 * THE BACKDROP is drawn from theme tokens only, so it follows light and dark mode: two soft brand
 * glows on the page wash and a fine grain over the top that breaks the flatness of a plain gradient.
 * The glows and grain are `fixed`, so they hold still while a long step scrolls over them. Nothing in
 * it resembles a chart or a figure — a backdrop that looked like data would be a picture of a
 * measurement nobody took, behind a form where the merchant has told us nothing yet.
 *
 * THE LOGO lives in the guide panel on wide screens, so the header carries it only below `lg` (and on
 * the screens that have no guide). The "Save and close" button of an edit session is rendered ONCE, in
 * the header, which therefore stays on wide screens for that case alone.
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
    <div ref={scrollRef} className="onboarding-frame relative h-full min-h-screen overflow-y-auto overscroll-contain bg-surface-50">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-40 h-[34rem] w-[34rem] rounded-full bg-brand-200/40 blur-[110px]" />
        <div className="absolute -bottom-48 -right-24 h-[30rem] w-[30rem] rounded-full bg-brand-100/60 blur-[120px]" />
        <div className="absolute inset-0 opacity-[0.035] mix-blend-multiply" style={{ backgroundImage: GRAIN }} />
      </div>

      <div className="relative mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-4 py-5 sm:px-6 lg:py-8">
        <header className={`mb-6 flex items-center justify-between gap-3 ${rail && !exit ? 'lg:hidden' : 'lg:mb-5'}`}>
          <span className={rail ? 'lg:invisible' : ''}>
            <RankvoraLogo />
          </span>
          {exit && (
            // Tighter on a phone: the logo and this button share a 320px row, and "Save and close"
            // at full padding pushed the pair past the viewport.
            <ActionButton variant="secondary" onClick={exit.onClick} disabled={exit.disabled} className="h-10 px-3.5 text-[13px] sm:px-5">
              {exit.label}
            </ActionButton>
          )}
        </header>

        {rail ? (
          <div className="grid flex-1 items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-8">
            <aside className="hidden lg:sticky lg:top-8 lg:block">{rail}</aside>
            <div className="min-w-0 pb-4">{children}</div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        )}
      </div>
    </div>
  );
}

/** A fine monochrome grain, as an inline SVG so it needs no file and stays crisp at any size. */
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

/**
 * The one light raised surface on the page: the step sits on it.
 *
 * It does NOT clip its contents. A drop-down list opens over whatever is below its field, and with
 * `overflow-hidden` on the sheet the lists of the fields near the bottom were cut off at its edge. The
 * corner glow is clipped instead, in a layer of its own that is exactly the sheet's size and shape.
 */
function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className="relative rounded-[22px] bg-surface-0 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_36px_70px_-40px_var(--c-shadow-lg),0_10px_28px_-16px_var(--c-shadow-md)] ring-1 ring-inset ring-surface-900/[0.07]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-[22px]">
        <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand-100/70 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-300/70 to-transparent" />
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}

/** The large mark above a full-screen message (an error, a prompt to connect). */
function StateMark({ tone, children }: { tone: 'brand' | 'warning'; children: ReactNode }) {
  const look =
    tone === 'warning'
      ? 'bg-warning-50 text-warning-700 ring-warning-100'
      : 'bg-brand-600 text-surface-0 ring-transparent shadow-[0_14px_28px_-16px_var(--c-brand-600)]';
  return (
    <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ring-inset sm:mx-0 ${look}`}>
      {children}
    </span>
  );
}

/**
 * What the merchant sees for the one request that decides which step opens.
 *
 * A skeleton of the real layout rather than a spinner on a line: the page it resolves into is a tinted
 * guide beside a sheet, so showing that shape immediately means nothing jumps when the data lands.
 */
function LoadingFrame({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const bar = 'animate-pulse rounded-md bg-surface-200/80 motion-reduce:animate-none';
  const tint = 'animate-pulse rounded-md bg-brand-100/80 motion-reduce:animate-none';
  return (
    <Frame
      scrollRef={scrollRef}
      rail={
        <div className="rounded-[22px] bg-gradient-to-b from-brand-50 via-brand-50/60 to-surface-0 p-7 ring-1 ring-inset ring-brand-100 lg:min-h-[38rem]" aria-hidden="true">
          <div className={`${tint} h-9 w-36`} />
          <div className={`${tint} mt-9 h-6 w-48`} />
          <div className={`${tint} mt-3 h-3.5 w-40`} />
          <div className={`${tint} mt-8 h-10 w-24`} />
          <div className={`${tint} mt-4 h-1.5 w-full rounded-full`} />
          <div className="mt-9 space-y-5">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} className="flex items-center gap-4">
                <div className={`${tint} h-8 w-8 flex-shrink-0 rounded-full`} />
                <div className={`${tint} h-3.5 flex-1`} style={{ maxWidth: `${140 - index * 10}px` }} />
              </div>
            ))}
          </div>
        </div>
      }
    >
      <Sheet>
        <div role="status" aria-live="polite" className="px-5 py-8 sm:px-10 sm:py-10">
          <span className="sr-only">Loading your store…</span>
          <div aria-hidden="true">
            <div className="flex items-center gap-3">
              <div className={`${bar} h-11 w-11 flex-shrink-0 rounded-2xl`} />
              <div className={`${bar} h-3 w-20`} />
            </div>
            <div className={`${bar} mt-6 h-9 w-72 max-w-full`} />
            <div className={`${bar} mt-3 h-3.5 w-full max-w-md`} />
            <div className="mt-10 grid gap-x-8 gap-y-9 md:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="space-y-2.5">
                  <div className={`${bar} h-3.5 w-32`} />
                  <div className={`${bar} h-3 w-44 max-w-full`} />
                  <div className={`${bar} h-12 w-full rounded-xl`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Sheet>
    </Frame>
  );
}
