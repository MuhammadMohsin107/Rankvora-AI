import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Info,
  Loader2,
  Plus,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * ─── Guided-setup building blocks ────────────────────────────────────
 *
 * Built on the app's surface/brand tokens, so setup follows light and dark mode without a single
 * `dark:` variant.
 *
 * THE LOOK. Setup is the first thing a merchant does, so it is allowed to be calmer and larger than
 * the data screens behind it: 44px controls, 14px control text, display-size step titles, and space
 * between questions instead of a box around each one. Structure comes from whitespace and hairlines;
 * the one raised surface is the sheet the step sits on (see pages/onboarding/Onboarding.tsx).
 *
 * COLOUR, USED SPARINGLY. The brand colour means "this is chosen" or "this is progress" — a selected
 * tile, a filled chip, the progress bar. The one thing a merchant is meant to press is an ink button
 * (`surface-950` on `surface-0`, which the semantic ramp inverts in dark mode), the same restraint as
 * the Shopify admin's own primary buttons.
 *
 * `DetectedNote` and `UnavailableNote` keep one promise visible throughout the flow: a suggested
 * value always states where it came from, and a value we could not read says so rather than
 * appearing as an empty field the merchant assumes is optional.
 *
 * NOTHING HERE FILLS A FIELD. Placeholders say what to type, never an example answer that could be
 * mistaken for one already given.
 */

export type StepStatus = 'complete' | 'pending';

interface StepEntry {
  step: number;
  title: string;
  status: StepStatus;
  /** True for a step that never blocks finishing (measurement). It can be passed without answering. */
  optional?: boolean;
}

/**
 * How far along the steps the merchant may jump: up to and including the first REQUIRED step that
 * is not answered yet. Anything before that is open, and so is an optional step on the way.
 *
 * An optional step must not be a gate. Measurement stays "not connected" for a merchant who chose
 * to set it up later, and if that held the steps after it shut, "Set up later" would quietly strand
 * them one step short of the end.
 */
export function furthestReachable(current: number, steps: StepEntry[]): number {
  let furthest = 1;
  for (const entry of [...steps].sort((a, b) => a.step - b.step)) {
    furthest = Math.max(furthest, entry.step);
    if (entry.status !== 'complete' && !entry.optional) break;
  }
  return Math.max(current, furthest);
}

/** What a step's state is called on screen. An optional step that is not done is not "unanswered". */
function statusLabel(entry: StepEntry): string {
  if (entry.status === 'complete') return 'Complete';
  return entry.optional ? 'Optional' : 'Not answered yet';
}

/** Required steps still owed — what "N steps to go" counts, so an optional one is never a chore. */
export function stepsOwed(steps: StepEntry[]): number {
  return steps.filter((entry) => !entry.optional && entry.status !== 'complete').length;
}

/** "3 steps to go" / "Ready to finish" / "All steps complete" — one sentence for both progress views. */
function progressSentence(steps: StepEntry[], completed: number): string {
  const owed = stepsOwed(steps);
  if (owed === 0) return completed === steps.length ? 'All steps complete' : 'Ready to finish';
  return `${owed} step${owed === 1 ? '' : 's'} to go`;
}

// ─── Progress ────────────────────────────────────────────────────────

/**
 * The numbered marker beside a step.
 *
 * `text-surface-0`, never `text-white`: success-600 is a dark green in light mode and a bright one
 * in dark, so a fixed white glyph on it goes from readable to invisible. surface-0 inverts with the
 * theme and stays legible on both.
 */
function StepBadge({ entry, isCurrent }: { entry: StepEntry; isCurrent: boolean }) {
  const tone =
    entry.status === 'complete'
      ? 'bg-success-600 text-surface-0'
      : isCurrent
        ? 'bg-brand-600 text-surface-0 shadow-[0_0_0_4px_var(--c-brand-100)]'
        : 'bg-surface-0 text-surface-500 ring-1 ring-inset ring-surface-300';

  return (
    <span
      aria-hidden="true"
      className={`relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums transition-[background-color,box-shadow,color] duration-300 ${tone}`}
    >
      {entry.status === 'complete' ? <Check size={14} strokeWidth={3} /> : entry.step}
    </span>
  );
}

/** A thin bar that fills with the share of steps done. The width animates; the number does not need to. */
function ProgressBar({ completed, total, className = '' }: { completed: number; total: number; className?: string }) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-200 ${className}`}
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * The guide for wide screens: where setup stands, then every step on one vertical line.
 *
 * It sits directly on the page, not in a box, so the sheet beside it is the only raised surface and
 * reads as the thing to act on. The line between the markers fills green as steps are completed, so
 * progress reads as one continuous stroke instead of five loose dots.
 */
export function StepRail({
  current,
  steps,
  onJump,
}: {
  current: number;
  steps: StepEntry[];
  onJump: (step: number) => void;
}) {
  const furthest = furthestReachable(current, steps);
  const completed = steps.filter((entry) => entry.status === 'complete').length;

  return (
    <nav aria-label="Setup progress" className="flex flex-col">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px] font-semibold tracking-[-0.01em] text-surface-950">Guided setup</p>
          <p className="text-[12px] font-medium tabular-nums text-surface-500">
            {completed} of {steps.length}
          </p>
        </div>
        <ProgressBar completed={completed} total={steps.length} className="mt-2.5" />
        <p className="mt-2 text-[12.5px] text-surface-500">{progressSentence(steps, completed)}</p>
      </div>

      <ol className="mt-7 flex flex-col">
        {steps.map((entry, index) => {
          const isCurrent = entry.step === current;
          const reachable = entry.step <= furthest;
          const isLast = index === steps.length - 1;
          return (
            <li key={entry.step} className="relative">
              {/* The connector runs behind the markers and is drawn from this marker to the next. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[13px] top-[34px] h-[calc(100%-26px)] w-px transition-colors duration-500 motion-reduce:transition-none ${
                    entry.status === 'complete' ? 'bg-success-500' : 'bg-surface-300'
                  }`}
                />
              )}
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && !isCurrent && onJump(entry.step)}
                aria-current={isCurrent ? 'step' : undefined}
                className={`group relative flex w-full items-start gap-3.5 rounded-xl py-2.5 pr-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-50 ${
                  reachable && !isCurrent ? 'cursor-pointer' : isCurrent ? 'cursor-default' : 'cursor-not-allowed'
                }`}
              >
                <StepBadge entry={entry} isCurrent={isCurrent} />
                <span className="min-w-0 pt-px">
                  <span
                    className={`block text-[14px] font-semibold leading-tight tracking-[-0.01em] transition-colors ${
                      isCurrent
                        ? 'text-surface-950'
                        : reachable
                          ? 'text-surface-700 group-hover:text-surface-950'
                          : 'text-surface-400'
                    }`}
                  >
                    {entry.title}
                  </span>
                  <span className={`mt-1 block text-[12px] leading-tight ${isCurrent ? 'text-brand-700' : 'text-surface-500'}`}>
                    {isCurrent && entry.status !== 'complete' ? 'In progress' : statusLabel(entry)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Progress for narrow screens, where the guide is hidden.
 *
 * A segmented bar rather than a row of numbered dots: five segments read as "how far through" from
 * across the room, and each one is a real tap target — the visible bar is 5px, but the button around
 * it is 24px tall, so jumping back to an earlier step works with a thumb.
 */
export function Stepper({
  current,
  steps,
  onJump,
}: {
  current: number;
  steps: StepEntry[];
  onJump: (step: number) => void;
}) {
  const furthest = furthestReachable(current, steps);
  const completed = steps.filter((entry) => entry.status === 'complete').length;

  return (
    <nav aria-label="Setup progress">
      <ol className="flex items-center gap-1.5">
        {steps.map((entry) => {
          const isCurrent = entry.step === current;
          const reachable = entry.step <= furthest;
          const fill =
            entry.status === 'complete' ? 'bg-success-500' : isCurrent ? 'bg-brand-600' : 'bg-surface-300';
          return (
            <li key={entry.step} className="flex-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && !isCurrent && onJump(entry.step)}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`Step ${entry.step}: ${entry.title} — ${statusLabel(entry)}`}
                className={`group flex w-full items-center py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 ${
                  reachable && !isCurrent ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-[5px] w-full rounded-full transition-colors duration-300 motion-reduce:transition-none ${fill} ${
                    reachable && !isCurrent ? 'group-hover:bg-brand-400' : ''
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ol>
      {/* Deliberately NOT "Step 2 of 5 · What you sell": the step header sits directly under this
          and already says both. This says the one thing the header cannot — how much is done. */}
      <p className="text-[12px] font-medium tabular-nums text-surface-500">{progressSentence(steps, completed)}</p>
    </nav>
  );
}

/**
 * The step's own heading: its mark, where it sits in the sequence, a display-size title and — only
 * where the title is not enough — one line saying what it is for.
 *
 * The icon tile is the step's identity and repeats nowhere else on screen, so it is also the only
 * place the step's own mark sits beside its title once the guide is gone on a narrow screen.
 */
export function StepHeader({
  step,
  total,
  title,
  purpose,
  icon: Icon,
}: {
  step: number;
  total: number;
  title: string;
  purpose?: string;
  icon?: LucideIcon;
}) {
  return (
    <header className="px-5 pb-1 pt-6 sm:px-9 sm:pt-9">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
            <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
          </span>
        )}
        <p className="text-[12.5px] font-medium tabular-nums text-surface-500">
          Step {step} of {total}
        </p>
      </div>
      <h1 className="mt-4 text-balance text-[26px] font-semibold leading-[1.1] tracking-[-0.03em] text-surface-950 sm:text-[32px]">
        {title}
      </h1>
      {purpose && <p className="mt-2 max-w-[56ch] text-pretty text-[14px] leading-[1.55] text-surface-500">{purpose}</p>}
    </header>
  );
}

// ─── Layout ──────────────────────────────────────────────────────────

/**
 * Required / Optional, as a quiet word beside the label rather than a coloured pill. A required
 * question carries a small brand dot so it is findable at a glance without shouting.
 */
function Badge({ children, tone }: { children: ReactNode; tone: 'required' | 'optional' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-surface-500">
      {tone === 'required' && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * The grid every step lays its fields out on: two equal columns from `md`, one below.
 *
 * WHY THE FIELDS ALIGN. `FormField` and `FormSection` place themselves on this grid's rows with
 * CSS subgrid — a field spans four row tracks (label, description, control, extras), a section
 * three. Items side by side share those tracks, so when one description wraps to two lines and its
 * neighbour's does not, both controls still start on the same line. A plain two-column grid lets
 * the longer description push its input down, and the pair stops lining up.
 *
 * Anything that should take the whole row passes `className="md:col-span-2"`.
 *
 * The children rise in one after another (`.onboarding-stagger`, index.css). The delay is set by
 * position in CSS, not by wrapping each child: a wrapper would not be a grid item and would break
 * the subgrid alignment above.
 */
export function FormGrid({ children }: { children: ReactNode }) {
  // No row gap: the fields are subgrid items, and a subgrid shares its parent's tracks and gaps, so a
  // row gap here would also open up the space between a label and its control. The distance between
  // one question and the next is each field's own bottom padding instead, and the last row's is
  // pulled back with the negative margin so the sheet's padding stays the bottom edge.
  return <div className="onboarding-stagger -mb-8 grid gap-x-7 gap-y-0 md:grid-cols-2">{children}</div>;
}

/**
 * Why a required answer is missing, said where the merchant is looking.
 *
 * Carries the field's own `${id}-error`, which every control in this file names in its
 * `aria-describedby` — so a screen reader reads the problem with the field rather than only the
 * summary in the action bar.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-2 flex items-start gap-1.5 text-[12.5px] font-medium leading-[1.45] text-critical-700">
      <AlertTriangle size={13} className="mt-[3px] flex-shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

/**
 * One labelled control. The description sits between the label and the control; anything that
 * belongs under the control — a suggestion from Shopify, a list of chips — goes in `extras`, so it
 * stays attached to the control instead of shifting the next row.
 *
 * `error` renders directly beneath the control and above `extras`: a merchant who has just been
 * stopped should read what is wrong before they read a suggestion.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  badge,
  children,
  extras,
  error,
  className = '',
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  badge?: 'required' | 'optional';
  children: ReactNode;
  extras?: ReactNode;
  /** Set when a required answer is missing. Pass the control `invalid` too, so the field is marked
   * as well as explained. */
  error?: string;
  className?: string;
}) {
  return (
    // Always four children, even when a hint or extras are absent, so the subgrid rows line up.
    <div className={`row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 pb-8 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <label htmlFor={htmlFor} className="text-[14px] font-semibold tracking-[-0.01em] text-surface-950">
          {label}
        </label>
        {badge && <Badge tone={badge}>{badge === 'required' ? 'Required' : 'Optional'}</Badge>}
      </div>
      <p id={`${htmlFor}-hint`} className="mt-1 text-pretty text-[12.5px] leading-[1.45] text-surface-500">
        {hint}
      </p>
      {/* The error sits in the control's own cell, right under the input. In the row below it would
          be placed after the TALLEST control in the row — a neighbouring tag field's helper line made
          that a gap of 40px between a field and the sentence explaining it. */}
      <div className="mt-2.5 min-w-0">
        {children}
        {error && <FieldError id={`${htmlFor}-error`}>{error}</FieldError>}
      </div>
      <div className="min-w-0">{extras}</div>
    </div>
  );
}

/** A group of cards or other non-input controls, announced as one group. Aligns on FormGrid rows
 * exactly as FormField does, over three tracks: title, description, content. */
export function FormSection({
  title,
  description,
  badge,
  children,
  error,
  className = '',
}: {
  title: string;
  description?: string;
  badge?: 'required' | 'optional';
  children: ReactNode;
  /** Set when the group's required choice has not been made. A card group has no single input to
   * mark, so the message under it is the whole signal — hence `aria-invalid` on the group itself. */
  error?: string;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      role="group"
      aria-labelledby={headingId}
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- kept for the error styling hook; not announced by role=group
      aria-invalid={error ? true : undefined}
      className={`row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0 pb-8 ${className}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-[14px] font-semibold tracking-[-0.01em] text-surface-950">
          {title}
        </h2>
        {badge && <Badge tone={badge}>{badge === 'required' ? 'Required' : 'Optional'}</Badge>}
      </div>
      <p className="mt-1 text-pretty text-[12.5px] leading-[1.45] text-surface-500">{description}</p>
      {/* `self-start`, not the default stretch. A card is `h-full`, and a percentage height only
          resolves against a parent whose height is definite — which a grid item that stretches to
          its row track is. With stretch, a lone card followed by anything else (the Scheduled
          monitoring switch, then its two selects) was sized to the WHOLE block, so it ballooned and
          the selects were pushed out of the row onto the next section. Sized to its own content,
          `h-full` resolves to auto and a card is only as tall as its text. */}
      <div className="mt-2.5 min-w-0 self-start">
        {children}
        {error && <FieldError>{error}</FieldError>}
      </div>
    </section>
  );
}

/**
 * Setup's buttons: 44px, the size of a comfortable thumb target, because this is the one thing a
 * merchant is meant to press.
 *
 * The primary is ink (`surface-950`), not the brand colour: brand marks what is chosen and how far
 * along setup is, and a primary action in the same colour would blur the two. The ramp inverts in
 * dark mode, so the same classes give a light button on a dark ground.
 */
export function ActionButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  loading = false,
  className = '',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Shows a spinner and blocks the press, for an action already in flight. */
  loading?: boolean;
  className?: string;
}) {
  const tone = {
    primary:
      'bg-surface-950 text-surface-0 shadow-[0_1px_2px_var(--c-shadow-md),inset_0_1px_0_rgba(255,255,255,0.14)] hover:bg-surface-800 hover:shadow-[0_10px_22px_-12px_var(--c-shadow-lg)]',
    secondary:
      'bg-surface-0 text-surface-800 ring-1 ring-inset ring-surface-200 shadow-[0_1px_2px_var(--c-shadow-sm)] hover:bg-surface-50 hover:text-surface-950 hover:ring-surface-300',
    ghost: 'bg-transparent text-surface-600 hover:bg-surface-100 hover:text-surface-950',
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 text-[14px] font-semibold tracking-[-0.01em] transition-[background-color,box-shadow,transform,color] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none motion-reduce:active:scale-100 ${tone} ${className}`}
    >
      {loading && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A fact Shopify reported, shown read-only. A missing value says so instead of showing a default. */
export function FactTile({ label, value, icon: Icon }: { label: string; value: string | null; icon?: LucideIcon }) {
  return (
    <div className="rounded-xl bg-surface-50 px-3.5 py-3 ring-1 ring-inset ring-surface-200/70">
      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-surface-500">
        {Icon && <Icon size={13} strokeWidth={2} className="text-surface-400" aria-hidden="true" />}
        {label}
      </p>
      {value ? (
        <p className="mt-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-surface-950" title={value}>
          {value}
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-surface-400">Not reported by Shopify</p>
      )}
    </div>
  );
}

// ─── Controls ────────────────────────────────────────────────────────

const controlBase =
  'w-full rounded-xl border bg-surface-0 text-[14px] text-surface-950 outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-surface-400 focus:ring-4';

/** Neutral or flagged. Kept in one place so every control in the flow marks a missing answer the
 * same way — a red edge that survives focus, rather than a border that disappears when tabbed to. */
function controlTone(invalid?: boolean) {
  return invalid
    ? 'border-critical-300 hover:border-critical-400 focus:border-critical-500 focus:ring-critical-100'
    : 'border-surface-200 hover:border-surface-300 focus:border-brand-500 focus:ring-brand-100';
}

/**
 * Both ids are named whether or not the error exists: a description that points at a missing
 * element is ignored, and naming it unconditionally means the message is announced the moment it
 * appears without re-wiring the field.
 */
function describedBy(id: string) {
  return `${id}-hint ${id}-error`;
}

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-describedby={describedBy(id)}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
      className={`${controlBase} ${controlTone(invalid)} h-11 px-3.5`}
    />
  );
}

/**
 * A select whose empty state is a prompt, not the first option. Without the placeholder a native
 * select shows its first real option, which reads as an answer the merchant never chose.
 */
export function SelectField({
  id,
  value,
  options,
  placeholder,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  options: readonly string[];
  placeholder: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        aria-describedby={describedBy(id)}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlBase} ${controlTone(invalid)} h-11 cursor-pointer appearance-none pl-3.5 pr-10 ${value ? '' : 'text-surface-400'}`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option} className="text-surface-900">
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-surface-400"
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * A select whose options show one thing and store another: a product's title and its handle, a
 * language's name and its code. `SelectField` above shows its value as the label, which is right
 * for a country and wrong for anything an id stands behind.
 */
export function LabelledSelect({
  id,
  value,
  options,
  placeholder,
  onChange,
  invalid,
  disabled = false,
}: {
  id: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy(id)}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlBase} ${controlTone(invalid)} h-11 cursor-pointer appearance-none pl-3.5 pr-10 disabled:cursor-not-allowed disabled:bg-surface-50 disabled:opacity-60 ${value ? '' : 'text-surface-400'}`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value} className="text-surface-900">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-surface-400"
        aria-hidden="true"
      />
    </div>
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 3,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength: number;
  rows?: number;
}) {
  return (
    <div>
      <textarea
        id={id}
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-describedby={describedBy(id)}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlBase} ${controlTone(false)} block resize-y px-3.5 py-2.5 leading-[1.55]`}
      />
      <p className="mt-1.5 text-right font-mono text-[11.5px] tabular-nums text-surface-400">
        {value.length}/{maxLength}
      </p>
    </div>
  );
}

// ─── Notes ───────────────────────────────────────────────────────────

/**
 * States what the merchant's own Shopify store says about a field, and which part of it.
 *
 * With an `action`, the value is offered as a one-click answer. It is never written into the field
 * on its own: a value the merchant did not choose would be saved as theirs the moment they pressed
 * Continue, and would come back on every reload looking like something they typed.
 */
export function DetectedNote({
  children,
  action,
}: {
  children: ReactNode;
  action?: { label: string; applied: boolean; onApply: () => void };
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-brand-50/70 px-3.5 py-2.5 ring-1 ring-inset ring-brand-100">
      <Sparkles size={14} className="flex-shrink-0 text-brand-600" aria-hidden="true" />
      <p className="min-w-[10rem] flex-1 text-pretty text-[12.5px] leading-[1.5] text-surface-700">{children}</p>
      {action &&
        (action.applied ? (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-[12px] font-semibold text-success-700">
            <Check size={13} strokeWidth={2.6} aria-hidden="true" />
            In use
          </span>
        ) : (
          <button
            type="button"
            onClick={action.onApply}
            className="flex-shrink-0 rounded-lg bg-surface-0 px-2.5 py-1 text-[12px] font-semibold text-brand-700 shadow-[0_1px_2px_var(--c-shadow-sm)] ring-1 ring-inset ring-brand-200 transition-[background-color,transform] hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] motion-reduce:active:scale-100"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}

/** Says plainly that something could not be read. Never replaced by a placeholder value. */
export function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-warning-50 px-3.5 py-2.5 ring-1 ring-inset ring-warning-100">
      <AlertTriangle size={15} className="mt-px flex-shrink-0 text-warning-700" aria-hidden="true" />
      <p className="text-pretty text-[12.5px] leading-[1.5] text-warning-700">{children}</p>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-info-50 px-3.5 py-2.5 ring-1 ring-inset ring-info-100">
      <Info size={15} className="mt-px flex-shrink-0 text-info-700" aria-hidden="true" />
      <p className="text-pretty text-[12.5px] leading-[1.5] text-info-700">{children}</p>
    </div>
  );
}

/** Muted inline text for a pending read or an empty list. */
export function QuietNote({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-1.5 text-[12.5px] text-surface-500">{children}</p>;
}

// ─── Pop-ups ─────────────────────────────────────────────────────────
// Moved to components/Toast.tsx so the whole app can use them; re-exported for the setup steps.
export { ToastStack, type ToastMessage } from '../Toast';

// ─── Choice cards ────────────────────────────────────────────────────

function cardClasses(selected: boolean, className = '') {
  return `group relative flex h-full cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3.5 transition-[border-color,background-color,box-shadow,transform] duration-200 motion-safe:hover:-translate-y-px ${
    selected
      ? 'border-brand-500 bg-brand-50/60 shadow-[0_0_0_1px_var(--c-brand-500),0_12px_26px_-20px_var(--c-brand-600)]'
      : 'border-surface-200 bg-surface-0 hover:border-surface-300 hover:shadow-[0_10px_24px_-18px_var(--c-shadow-lg)]'
  } ${className}`;
}

/** A selectable option with a title and an explanation of what choosing it does. */
export function ChoiceCard({
  name,
  value,
  selected,
  label,
  description,
  onSelect,
  className,
}: {
  name: string;
  value: string;
  selected: boolean;
  label: string;
  description?: string;
  onSelect: (value: string) => void;
  /** Grid placement, e.g. letting the last card of an odd row span it. */
  className?: string;
}) {
  const id = `${name}-${value.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label htmlFor={id} className={cardClasses(selected, className)}>
      <input
        id={id}
        type="radio"
        name={name}
        checked={selected}
        onChange={() => onSelect(value)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-px flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-0 ${
          selected ? 'border-brand-600 bg-brand-600' : 'border-surface-300 bg-surface-0 group-hover:border-surface-400'
        }`}
      >
        {/* surface-0, not white: brand-600 is a pale lavender in dark mode and a white dot on it
            disappears. */}
        {selected && <span className="h-[6px] w-[6px] rounded-full bg-surface-0" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-[14px] font-semibold leading-snug tracking-[-0.01em] ${selected ? 'text-brand-900' : 'text-surface-900'}`}>
          {label}
        </span>
        {description && <span className="mt-1 block text-pretty text-[12.5px] leading-[1.45] text-surface-500">{description}</span>}
      </span>
    </label>
  );
}

/** Multi-select with the same anatomy as ChoiceCard. */
export function CheckCard({
  id,
  checked,
  label,
  description,
  onToggle,
}: {
  id: string;
  checked: boolean;
  label: string;
  description?: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className={cardClasses(checked)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-px flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-0 ${
          checked ? 'border-brand-600 bg-brand-600 text-surface-0' : 'border-surface-300 bg-surface-0 group-hover:border-surface-400'
        }`}
      >
        {checked && <Check size={12} strokeWidth={3.2} />}
      </span>
      <span className="min-w-0">
        <span className={`block text-[14px] font-semibold leading-snug tracking-[-0.01em] ${checked ? 'text-brand-900' : 'text-surface-900'}`}>
          {label}
        </span>
        {description && <span className="mt-1 block text-pretty text-[12.5px] leading-[1.45] text-surface-500">{description}</span>}
      </span>
    </label>
  );
}

// ─── Lists ───────────────────────────────────────────────────────────

/**
 * A closed vocabulary where MORE THAN ONE answer is true.
 *
 * Toggle chips rather than a multi-select `<select multiple>` or a stack of checkboxes: twenty-one
 * industries as checkboxes is a column taller than the step card, and a native multi-select hides
 * every unselected option behind a scroll and requires ctrl-click to add a second — which is the
 * single least discoverable interaction on the web.
 *
 * Every option is visible, selected ones read as selected without needing their colour decoded
 * (they carry a tick), and the whole group is one tab stop's worth of ordinary buttons.
 *
 * `aria-pressed` rather than checkboxes because these are toggles, not a form group whose value is
 * submitted by name — the draft is held in React state and saved on Continue.
 */
export function MultiSelectChips({
  options,
  selected,
  onToggle,
  invalid = false,
  describedBy,
  label,
}: {
  options: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** Marks the group when a required answer is missing — see FormField's error. */
  invalid?: boolean;
  describedBy?: string;
  /** Names the group for a screen reader, since the chips have no visible heading of their own. */
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/role-supports-aria-props -- kept for the error styling hook; not announced by role=group
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      // A flagged group is outlined OUTSIDE its box, so the chips do not move when the flag appears.
      className={`flex flex-wrap gap-2 rounded-xl ${
        invalid ? 'outline outline-1 outline-offset-[6px] outline-critical-300' : ''
      }`}
    >
      {options.map((option) => {
        const isSelected = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onToggle(option)}
            className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium ring-1 ring-inset transition-[background-color,color,box-shadow,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] motion-reduce:active:scale-100 ${
              isSelected
                ? 'bg-brand-600 text-surface-0 ring-brand-600'
                : 'bg-surface-0 text-surface-700 ring-surface-200 hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200'
            }`}
          >
            {isSelected && <Check size={13} strokeWidth={2.8} aria-hidden="true" />}
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** A removable value the merchant added. */
export function Chip({ label, onRemove, disabled = false }: { label: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-lg bg-brand-50 py-1 pl-3 pr-1.5 text-[13px] font-medium text-brand-900 ring-1 ring-inset ring-brand-100">
      <span className="truncate">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="rounded-md p-1 text-brand-500 transition-colors hover:bg-brand-100 hover:text-brand-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed"
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </span>
  );
}

/**
 * A list the merchant builds by typing. Enter or comma commits; × removes.
 *
 * Enforces `max` and rejects case-insensitive duplicates rather than accepting them and silently
 * de-duplicating on save — a merchant should see immediately that a term is already in the list.
 */
export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  max,
  disabled = false,
  invalid,
  transform,
}: {
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max: number;
  disabled?: boolean;
  invalid?: boolean;
  /** Normalises an entry as it is committed (lower-casing a keyword, stripping a URL to a host). */
  transform?: (raw: string) => string | null;
}) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const full = values.length >= max;

  const commit = (raw: string) => {
    const candidate = transform ? transform(raw) : raw.trim();
    if (!candidate) {
      setNotice(transform ? "That doesn't look like a valid entry." : null);
      return;
    }
    if (values.some((value) => value.toLowerCase() === candidate.toLowerCase())) {
      setNotice('Already in the list.');
      setDraft('');
      return;
    }
    if (full) {
      setNotice(`You can add up to ${max}.`);
      return;
    }
    onChange([...values, candidate]);
    setDraft('');
    setNotice(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (draft.trim()) commit(draft);
      return;
    }
    // Backspace on an empty field removes the last chip — the behaviour every tag field has.
    if (event.key === 'Backspace' && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
      setNotice(null);
    }
  };

  return (
    <div>
      <div
        className={`flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1.5 transition-[border-color,box-shadow] duration-150 focus-within:ring-4 ${
          disabled
            ? 'border-surface-200 bg-surface-50'
            : invalid
              ? 'border-critical-300 bg-surface-0 hover:border-critical-400 focus-within:border-critical-500 focus-within:ring-critical-100'
              : 'border-surface-200 bg-surface-0 hover:border-surface-300 focus-within:border-brand-500 focus-within:ring-brand-100'
        }`}
      >
        {values.map((value) => (
          <Chip
            key={value}
            label={value}
            disabled={disabled}
            onRemove={() => {
              onChange(values.filter((item) => item !== value));
              setNotice(null);
            }}
          />
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled || full}
          aria-describedby={describedBy(id)}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setNotice(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft.trim() && commit(draft)}
          placeholder={full ? `Maximum of ${max} reached` : values.length === 0 ? placeholder : 'Add another…'}
          className="min-w-[9rem] flex-1 bg-transparent px-1.5 py-1 text-[14px] text-surface-950 outline-none placeholder:text-surface-400 disabled:cursor-not-allowed"
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <p className={`text-[12px] ${notice ? 'font-medium text-warning-700' : 'text-surface-500'}`} aria-live="polite">
          {notice ?? 'Press Enter or comma to add.'}
        </p>
        <p className="flex-shrink-0 font-mono text-[11.5px] tabular-nums text-surface-400">
          {values.length}/{max}
        </p>
      </div>
    </div>
  );
}

/**
 * Suggestions derived from the merchant's own store, offered one click at a time.
 *
 * Each chip carries the reason it was suggested (`hint`) because a merchant deciding whether a term
 * belongs in their targets needs to know which part of their catalogue it came from. Already-added
 * suggestions are shown as added rather than hidden, so the list does not reflow under the cursor.
 */
export function SuggestionRow({
  label,
  suggestions,
  selected,
  onAdd,
  disabled = false,
}: {
  label: string;
  suggestions: Array<{ value: string; hint: string }>;
  selected: string[];
  onAdd: (value: string) => void;
  disabled?: boolean;
}) {
  const headingId = useId();
  if (suggestions.length === 0) return null;

  const lowered = selected.map((value) => value.toLowerCase());

  return (
    <div className="rounded-xl border border-dashed border-surface-300 bg-surface-50/70 px-3.5 py-3">
      <p id={headingId} className="flex items-center gap-1.5 text-[12px] font-medium text-surface-600">
        <Sparkles size={13} className="text-brand-600" aria-hidden="true" />
        {label}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-labelledby={headingId}>
        {suggestions.map((suggestion) => {
          const added = lowered.includes(suggestion.value.toLowerCase());
          return (
            <button
              key={suggestion.value}
              type="button"
              disabled={disabled || added}
              onClick={() => onAdd(suggestion.value)}
              title={suggestion.hint}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium ring-1 ring-inset transition-[background-color,color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] motion-reduce:active:scale-100 ${
                added
                  ? 'cursor-default bg-success-50 text-success-700 ring-success-100'
                  : 'cursor-pointer bg-surface-0 text-surface-700 ring-surface-200 hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200'
              }`}
            >
              {added ? <Check size={13} strokeWidth={2.6} aria-hidden="true" /> : <Plus size={13} strokeWidth={2.6} aria-hidden="true" />}
              {suggestion.value}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Ordered priority list. Position is the answer, so moving an item is the interaction. */
export function PriorityList({
  items,
  onReorder,
}: {
  items: Array<{ key: string; label: string }>;
  onReorder: (keys: string[]) => void;
}) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((item) => item.key));
  };

  const moveButton =
    'flex h-8 w-8 items-center justify-center rounded-lg text-surface-500 ring-1 ring-inset ring-surface-200 transition-[background-color,color,transform] hover:bg-surface-100 hover:text-surface-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 motion-reduce:active:scale-100';

  return (
    <ol className="divide-y divide-surface-100 overflow-hidden rounded-xl bg-surface-0 ring-1 ring-inset ring-surface-200">
      {items.map((item, index) => (
        <li key={item.key} className="flex items-center gap-3 px-3.5 py-2.5">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 font-mono text-[12px] font-semibold tabular-nums text-brand-700">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-surface-900">{item.label}</span>
          <span className="flex flex-shrink-0 gap-1.5">
            <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${item.label} up`} className={moveButton}>
              <ArrowUp size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === items.length - 1}
              aria-label={`Move ${item.label} down`}
              className={moveButton}
            >
              <ArrowDown size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}
