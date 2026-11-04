import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
 * Built on the app's surface/brand tokens so setup looks like the product it opens, and so it
 * follows light and dark mode without a single `dark:` variant.
 *
 * A COMPACT SCALE, one step up from the app's own. The app's controls are 32px rows with 12.5px
 * type; setup runs 36px controls (40px for the buttons that move between steps), 13px control text,
 * 12px help text, a 19–21px step title and 20px between field rows — tight enough that a step fits
 * on one laptop screen with little or no scrolling. Nothing here goes below the 10.5–11px the app
 * already uses for its uppercase meta labels.
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
function furthestReachable(current: number, steps: StepEntry[]): number {
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
function stepsOwed(steps: StepEntry[]): number {
  return steps.filter((entry) => !entry.optional && entry.status !== 'complete').length;
}

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
      ? 'bg-success-600 text-surface-0 ring-success-600/20'
      : isCurrent
        ? 'bg-brand-600 text-surface-0 ring-brand-500/25'
        : 'border border-surface-300 bg-surface-0 text-surface-500 ring-transparent';

  return (
    <span
      aria-hidden="true"
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ring-4 transition-colors ${tone}`}
    >
      {entry.status === 'complete' ? <Check size={14} strokeWidth={3} /> : entry.step}
    </span>
  );
}

// ─── Progress ────────────────────────────────────────────────────────

/** A donut showing how much of setup is done. Reads the theme through `stroke-current`, so the
 * track and the arc both follow light and dark mode. */
function ProgressRing({ completed, total }: { completed: number; total: number }) {
  const size = 44;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? completed / total : 0;

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-current text-surface-200"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className="stroke-current text-brand-600 transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-surface-900">
        {completed}/{total}
      </span>
    </div>
  );
}

/**
 * Vertical progress for wide screens: every step, its state, and how far through setup is.
 *
 * Deliberately NOT a bordered box. The rail sits directly on the page wash so the step card is the
 * only raised surface on screen and reads as the thing to act on; the current step is the one item
 * here lifted onto its own sheet, which is what makes "you are here" legible at a glance.
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
    <nav aria-label="Setup progress" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <ProgressRing completed={completed} total={steps.length} />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">Guided setup</p>
          <p className="mt-0.5 text-[13px] leading-tight text-surface-600">
            {stepsOwed(steps) === 0
              ? completed === steps.length ? 'All steps complete' : 'Ready to finish'
              : `${stepsOwed(steps)} step${stepsOwed(steps) === 1 ? '' : 's'} to go`}
          </p>
        </div>
      </div>

      <ol className="relative flex flex-col gap-0.5">
        {steps.map((entry, index) => {
          const isCurrent = entry.step === current;
          const reachable = entry.step <= furthest;
          const isLast = index === steps.length - 1;
          return (
            <li key={entry.step} className="relative">
              {/* The connector, drawn behind the badges and filled once the step above is done, so
                  the rail shows progress as a continuous line rather than five loose markers. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[25px] top-[40px] h-[calc(100%-26px)] w-0.5 rounded-full transition-colors duration-500 motion-reduce:transition-none ${
                    entry.status === 'complete' ? 'bg-success-500' : 'bg-surface-200'
                  }`}
                />
              )}
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && !isCurrent && onJump(entry.step)}
                aria-current={isCurrent ? 'step' : undefined}
                className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-[background-color,box-shadow,color] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
                  isCurrent
                    ? 'bg-surface-0 shadow-[0_6px_20px_-14px_var(--c-shadow-lg)] ring-1 ring-surface-200'
                    : reachable
                      ? 'cursor-pointer hover:bg-surface-0/70'
                      : 'cursor-not-allowed'
                }`}
              >
                <StepBadge entry={entry} isCurrent={isCurrent} />
                <span className="min-w-0">
                  <span
                    className={`block text-[13px] font-semibold leading-tight ${
                      isCurrent ? 'text-surface-950' : reachable ? 'text-surface-700' : 'text-surface-400'
                    }`}
                  >
                    {entry.title}
                  </span>
                  <span className={`mt-0.5 block text-[11px] leading-tight ${isCurrent ? 'text-brand-600' : 'text-surface-500'}`}>
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
 * Progress for narrow screens, where the rail is hidden.
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
    <nav aria-label="Setup progress" className="px-4 pb-2 pt-2.5 sm:px-6">
      <ol className="flex items-center gap-1.5">
        {steps.map((entry) => {
          const isCurrent = entry.step === current;
          const reachable = entry.step <= furthest;
          const fill =
            entry.status === 'complete' ? 'bg-success-500' : isCurrent ? 'bg-brand-600' : 'bg-surface-200';
          return (
            <li key={entry.step} className="flex-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && !isCurrent && onJump(entry.step)}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={`Step ${entry.step}: ${entry.title} — ${statusLabel(entry)}`}
                className={`group flex w-full items-center py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
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
      <p className="text-[11.5px] font-medium tabular-nums text-surface-500">
        {stepsOwed(steps) === 0 ? 'Ready to finish' : `${completed} of ${steps.length} steps complete`}
      </p>
    </nav>
  );
}

/**
 * The step's own heading. One task, named, with a line saying what answering it changes.
 *
 * The icon tile is the step's identity and repeats nowhere else on screen, so it carries the number
 * as well on narrow screens — where the rail is gone, it is the only place the step's own mark sits
 * beside its title.
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
  purpose: string;
  icon?: LucideIcon;
}) {
  return (
    <header className="border-b border-surface-200 px-3.5 py-2.5 sm:px-5 sm:py-3">
      <div className="flex items-start gap-2.5 sm:gap-3">
        {Icon && (
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-200/70 sm:h-9 sm:w-9">
            <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-600">
            Step {step} of {total}
          </p>
          <h1 className="mt-0.5 text-[16px] font-semibold leading-[1.2] tracking-[-0.02em] text-surface-950 sm:text-[17px]">
            {title}
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] leading-[1.45] text-surface-500">{purpose}</p>
        </div>
      </div>
    </header>
  );
}

// ─── Layout ──────────────────────────────────────────────────────────

function Badge({ children, tone }: { children: ReactNode; tone: 'required' | 'optional' }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${
        tone === 'required'
          ? 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-100'
          : 'bg-surface-100 text-surface-500 ring-1 ring-inset ring-surface-200'
      }`}
    >
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
 */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-4 gap-y-3.5 md:grid-cols-2">{children}</div>;
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
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium leading-[1.45] text-critical-700">
      <AlertTriangle size={12} className="mt-[3px] flex-shrink-0" aria-hidden="true" />
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
    <div className={`row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor={htmlFor} className="text-[12.5px] font-semibold tracking-[-0.01em] text-surface-900">
          {label}
        </label>
        {badge && <Badge tone={badge}>{badge === 'required' ? 'Required' : 'Optional'}</Badge>}
      </div>
      <p id={`${htmlFor}-hint`} className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">
        {hint}
      </p>
      <div className="mt-1.5 min-w-0">{children}</div>
      <div className="min-w-0">
        {error && <FieldError id={`${htmlFor}-error`}>{error}</FieldError>}
        {extras}
      </div>
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
      aria-invalid={error ? true : undefined}
      className={`row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0 ${className}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-[12.5px] font-semibold tracking-[-0.01em] text-surface-900">
          {title}
        </h2>
        {badge && <Badge tone={badge}>{badge === 'required' ? 'Required' : 'Optional'}</Badge>}
      </div>
      <p className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">{description}</p>
      {/* `self-start`, not the default stretch. A card is `h-full`, and a percentage height only
          resolves against a parent whose height is definite — which a grid item that stretches to
          its row track is. With stretch, a lone card followed by anything else (the Scheduled
          monitoring switch, then its two selects) was sized to the WHOLE block, so it ballooned and
          the selects were pushed out of the row onto the next section. Sized to its own content,
          `h-full` resolves to auto and a card is only as tall as its text. */}
      <div className="mt-1.5 min-w-0 self-start">
        {children}
        {error && <FieldError>{error}</FieldError>}
      </div>
    </section>
  );
}

/**
 * Setup's buttons: 40px. The app's `.btn-*` classes are 32px — right for a toolbar, too small to be
 * the one thing a merchant is meant to press on a phone.
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
      'border-brand-700 bg-brand-600 text-surface-0 shadow-[0_1px_2px_var(--c-shadow-md),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-brand-500 hover:shadow-[0_6px_16px_-8px_var(--c-shadow-lg)]',
    secondary:
      'border-surface-200 bg-surface-0 text-surface-700 shadow-sm hover:border-surface-300 hover:bg-surface-50 hover:text-surface-900',
    ghost: 'border-transparent bg-transparent text-surface-600 hover:bg-surface-100 hover:text-surface-900',
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      /* 36px, down from 40. Still comfortably above the 32px the app's toolbars use — this is the
         one thing a merchant is meant to press on a phone — but no longer setting the height of a
         sticky bar that has to share the fold with the step. */
      className={`inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3.5 text-[12.5px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,box-shadow,transform] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none motion-reduce:active:scale-100 ${tone} ${className}`}
    >
      {loading && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A fact Shopify reported, shown read-only. A missing value says so instead of showing a default. */
export function FactTile({ label, value, icon: Icon }: { label: string; value: string | null; icon?: LucideIcon }) {
  return (
    <div className="rounded-lg border border-surface-200 bg-surface-50/60 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-surface-500">
        {Icon && <Icon size={12} strokeWidth={2.2} className="text-surface-400" aria-hidden="true" />}
        {label}
      </p>
      {value ? (
        <p className="mt-0.5 truncate text-[13px] font-semibold text-surface-900" title={value}>
          {value}
        </p>
      ) : (
        <p className="mt-0.5 text-[12.5px] text-surface-400">Not reported by Shopify</p>
      )}
    </div>
  );
}

// ─── Controls ────────────────────────────────────────────────────────

const controlBase =
  'w-full rounded-lg border bg-surface-0 text-[13px] text-surface-900 shadow-[0_1px_2px_var(--c-shadow-sm)] outline-none transition-[border-color,box-shadow] placeholder:text-surface-400 focus:ring-4';

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
      className={`${controlBase} ${controlTone(invalid)} h-9 px-3`}
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
        className={`${controlBase} ${controlTone(invalid)} h-9 cursor-pointer appearance-none pl-3 pr-9 ${value ? '' : 'text-surface-400'}`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option} className="text-surface-900">
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-surface-400"
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
        className={`${controlBase} ${controlTone(invalid)} h-9 cursor-pointer appearance-none pl-3 pr-9 disabled:cursor-not-allowed disabled:opacity-60 ${value ? '' : 'text-surface-400'}`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value} className="text-surface-900">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-surface-400"
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
        className={`${controlBase} ${controlTone(false)} block resize-y px-3 py-2 leading-[1.5]`}
      />
      <p className="mt-1 text-right font-mono text-[11px] tabular-nums text-surface-400">
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
    <div className="mt-2 flex flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-lg border border-brand-200/70 bg-brand-50/60 px-3 py-2">
      <Sparkles size={13} className="mt-[2px] flex-shrink-0 text-brand-500" aria-hidden="true" />
      <p className="min-w-[10rem] flex-1 text-[12px] leading-[1.5] text-surface-600">{children}</p>
      {action &&
        (action.applied ? (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-[11.5px] font-semibold text-success-700">
            <Check size={12} strokeWidth={2.6} aria-hidden="true" />
            In use
          </span>
        ) : (
          <button
            type="button"
            onClick={action.onApply}
            className="flex-shrink-0 rounded-md bg-surface-0 px-2 py-0.5 text-[11.5px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 transition-colors hover:bg-brand-50 hover:ring-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
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
    <div className="flex items-start gap-2.5 rounded-lg border border-warning-100 bg-warning-50 px-3 py-2">
      <AlertTriangle size={14} className="mt-px flex-shrink-0 text-warning-700" aria-hidden="true" />
      <p className="text-[12px] leading-[1.5] text-warning-700">{children}</p>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-info-100 bg-info-50 px-3 py-2">
      <Info size={14} className="mt-px flex-shrink-0 text-info-700" aria-hidden="true" />
      <p className="text-[12px] leading-[1.5] text-info-700">{children}</p>
    </div>
  );
}

/** Muted inline text for a pending read or an empty list. */
export function QuietNote({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-1.5 text-[12px] text-surface-500">{children}</p>;
}

// ─── Pop-ups ─────────────────────────────────────────────────────────

export interface ToastMessage {
  id: string;
  tone: 'success' | 'info';
  message: string;
}

/** How long a pop-up stays before it leaves by itself — long enough to read two lines without rushing. */
const TOAST_MS = 9000;

function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  // Held while the pointer or keyboard focus is on it, so a merchant who is still reading is not
  // cut off. The clock starts again from the full time when they let go.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [held, onDismiss, toast.id]);

  const success = toast.tone === 'success';
  const Icon = success ? Check : Info;
  return (
    <div
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-[0_16px_40px_-16px_rgba(15,23,42,0.35)] motion-safe:animate-scale-in ${
        success ? 'border-success-100 bg-success-50 text-success-700' : 'border-info-100 bg-info-50 text-info-700'
      }`}
    >
      <Icon size={14} className="mt-px flex-shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[12px] leading-[1.5]">{toast.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 flex-shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Short-lived messages, shown over the page instead of inside it.
 *
 * For what is worth saying once and is not part of the form: "Google connected", "none of this is
 * needed". Left inline, each of those sat in the step for good and pushed the real content down.
 * Anything the merchant must ACT on — a failed connection, a missing answer — stays inline, where it
 * cannot disappear before it is read.
 *
 * Rendered into the document body rather than where it is used: a step sits inside an animated
 * wrapper, and a transformed ancestor would make `fixed` position the pop-up against the step
 * instead of the window.
 */
export function ToastStack({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

// ─── Choice cards ────────────────────────────────────────────────────

function cardClasses(selected: boolean, className = '') {
  return `relative flex h-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-[border-color,background-color,box-shadow] ${
    selected
      ? 'border-brand-500 bg-brand-50/60 shadow-[0_0_0_1px_var(--c-brand-500),0_8px_20px_-16px_var(--c-shadow-lg)]'
      : 'border-surface-200 bg-surface-0 hover:border-surface-300 hover:bg-surface-50/70 hover:shadow-[0_4px_14px_-12px_var(--c-shadow-lg)]'
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
        className={`mt-[1px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 ${
          selected ? 'border-brand-600 bg-brand-600' : 'border-surface-300 bg-surface-0'
        }`}
      >
        {/* surface-0, not white: brand-600 is a pale lavender in dark mode and a white dot on it
            disappears. */}
        {selected && <span className="h-[6px] w-[6px] rounded-full bg-surface-0" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-semibold leading-snug ${selected ? 'text-brand-800' : 'text-surface-800'}`}>
          {label}
        </span>
        {description && <span className="mt-0.5 block text-[12px] leading-[1.45] text-surface-500">{description}</span>}
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
        className={`mt-[1px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 ${
          checked ? 'border-brand-600 bg-brand-600 text-surface-0' : 'border-surface-300 bg-surface-0'
        }`}
      >
        {checked && <Check size={12} strokeWidth={3.2} />}
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-semibold leading-snug ${checked ? 'text-brand-800' : 'text-surface-800'}`}>
          {label}
        </span>
        {description && <span className="mt-0.5 block text-[12px] leading-[1.45] text-surface-500">{description}</span>}
      </span>
    </label>
  );
}

// ─── Lists ───────────────────────────────────────────────────────────

/** A removable value the merchant added. */
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
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={`flex flex-wrap gap-1.5 rounded-lg border p-1.5 ${
        invalid ? 'border-critical-300 bg-critical-50/40' : 'border-surface-200 bg-surface-50/60'
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
            className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              isSelected
                ? 'border-brand-600 bg-brand-600 text-surface-0'
                : 'border-surface-200 bg-surface-0 text-surface-700 hover:border-brand-300 hover:bg-brand-50/60 hover:text-brand-700'
            }`}
          >
            {isSelected && <Check size={11} strokeWidth={2.8} aria-hidden="true" />}
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function Chip({ label, onRemove, disabled = false }: { label: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-brand-50 py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-brand-800 ring-1 ring-inset ring-brand-200/70">
      <span className="truncate">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="rounded-md p-0.5 text-brand-500 transition-colors hover:bg-brand-100 hover:text-brand-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-500"
      >
        <X size={12} strokeWidth={2.5} />
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
        className={`flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1 shadow-[0_1px_2px_var(--c-shadow-sm)] transition-[border-color,box-shadow] focus-within:ring-4 ${
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
          className="min-w-[9rem] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-surface-900 outline-none placeholder:text-surface-400 disabled:cursor-not-allowed"
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className={`text-[11.5px] ${notice ? 'font-medium text-warning-700' : 'text-surface-500'}`} aria-live="polite">
          {notice ?? 'Press Enter or comma to add.'}
        </p>
        <p className="flex-shrink-0 font-mono text-[11px] tabular-nums text-surface-400">
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
    <div className="rounded-lg border border-dashed border-surface-300 bg-surface-50/60 px-3 py-2">
      <p id={headingId} className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-surface-500">
        <Sparkles size={12} className="text-brand-500" aria-hidden="true" />
        {label}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-labelledby={headingId}>
        {suggestions.map((suggestion) => {
          const added = lowered.includes(suggestion.value.toLowerCase());
          return (
            <button
              key={suggestion.value}
              type="button"
              disabled={disabled || added}
              onClick={() => onAdd(suggestion.value)}
              title={suggestion.hint}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                added
                  ? 'cursor-default border-success-100 bg-success-50 text-success-700'
                  : 'cursor-pointer border-surface-200 bg-surface-0 text-surface-700 hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700'
              }`}
            >
              {added ? <Check size={12} strokeWidth={2.6} aria-hidden="true" /> : <Plus size={12} strokeWidth={2.6} aria-hidden="true" />}
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
    'flex h-7 w-7 items-center justify-center rounded-md border border-surface-200 bg-surface-0 text-surface-500 transition-colors hover:border-surface-300 hover:bg-surface-50 hover:text-surface-900 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

  return (
    <ol className="divide-y divide-surface-100 overflow-hidden rounded-lg border border-surface-200 bg-surface-0">
      {items.map((item, index) => (
        <li key={item.key} className="flex items-center gap-2.5 px-3 py-1.5">
          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-surface-100 font-mono text-[11.5px] font-semibold tabular-nums text-surface-600">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-surface-800">{item.label}</span>
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
