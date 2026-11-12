import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import RankvoraLogo from '../auth/RankvoraLogo';

/**
 * ─── Guided-setup building blocks ────────────────────────────────────
 *
 * Built on the app's surface/brand tokens, so setup follows light and dark mode without a single
 * `dark:` variant.
 *
 * THE LAYOUT. Two light surfaces side by side: a soft lavender GUIDE panel (where you are, every
 * step on one line) and a white SHEET (the step itself). Both are drawn from theme tokens, so the whole
 * flow stays light in light mode and follows the theme in dark mode; nothing is hard-coded.
 *
 * THE CONTROLS. Modern "filled" fields: a soft well that lifts to white with a brand ring on focus,
 * 48px tall, with an optional leading icon that warms up when the field does. Choices are tiles with
 * an icon, a plain-language line and a clear selected state; on/off settings are real switches.
 * Required / Optional are quiet words next to the label, never pills.
 *
 * COLOUR, USED SPARINGLY. Brand means "this is chosen", "this is progress" and "press this": one
 * colour for all three, so the eye is never asked to decode a second accent.
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
 * Done is green with a tick; the current step is the one filled brand disc, with a soft halo; the
 * rest are quiet outlines. `text-surface-0` on the filled colours inverts with the theme, so the mark
 * stays legible in both.
 */
function StepBadge({ entry, isCurrent }: { entry: StepEntry; isCurrent: boolean }) {
  const tone =
    entry.status === 'complete'
      ? 'bg-success-600 text-surface-0'
      : isCurrent
        ? 'bg-brand-600 text-surface-0 shadow-[0_0_0_5px_var(--c-brand-100)]'
        : 'bg-surface-0 text-surface-500 ring-1 ring-inset ring-surface-300';

  return (
    <span
      aria-hidden="true"
      className={`relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold tabular-nums transition-[background-color,box-shadow,color] duration-300 ${tone}`}
    >
      {entry.status === 'complete' ? <Check size={15} strokeWidth={3} /> : entry.step}
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
      className={`h-1.5 w-full overflow-hidden rounded-full bg-brand-100 ${className}`}
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * The guide for wide screens: a soft lavender panel holding the brand, how far setup has got, and
 * every step on one vertical line.
 *
 * It is tinted rather than white, so it reads as the "map" beside the white "form" while staying as
 * light as the rest of the page. The line between the markers fills green as steps are completed, so
 * progress reads as one continuous stroke, and the number at the top says it in the plainest way
 * there is.
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
  const percent = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;

  return (
    <nav
      aria-label="Setup progress"
      className="relative flex flex-col overflow-hidden rounded-[22px] bg-gradient-to-b from-brand-50 via-brand-50/60 to-surface-0 p-7 shadow-[0_36px_70px_-44px_var(--c-shadow-lg),0_10px_28px_-18px_var(--c-shadow-md)] ring-1 ring-inset ring-brand-100 lg:min-h-[38rem]"
    >
      {/* A soft light and a hairline, so the panel has a little depth instead of being a flat tint. */}
      <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-brand-200/50 blur-[80px]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-300/70 to-transparent" />

      <div className="relative flex flex-1 flex-col">
        <RankvoraLogo />

        <div className="mt-9">
          <p className="text-balance text-[22px] font-semibold leading-[1.15] tracking-[-0.03em] text-surface-950">Let’s set up your store</p>
          <p className="mt-2 text-pretty text-[13px] leading-[1.55] text-surface-500">Your answers shape how Rankvora analyses it.</p>
        </div>

        <div className="mt-7">
          <div className="flex items-end justify-between gap-3">
            <p className="text-[44px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-surface-950">
              {percent}
              <span className="ml-0.5 text-[20px] font-medium text-surface-400">%</span>
            </p>
            <p className="pb-1 text-[12.5px] font-medium tabular-nums text-surface-500">
              {completed} of {steps.length}
            </p>
          </div>
          <ProgressBar completed={completed} total={steps.length} className="mt-3" />
          <p className="mt-2.5 text-[12.5px] text-surface-500">{progressSentence(steps, completed)}</p>
        </div>

        <ol className="mb-8 mt-8 flex flex-col">
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
                    className={`absolute left-[15px] top-[38px] h-[calc(100%-30px)] w-px transition-colors duration-500 motion-reduce:transition-none ${
                      entry.status === 'complete' ? 'bg-success-500' : 'bg-brand-200'
                    }`}
                  />
                )}
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && !isCurrent && onJump(entry.step)}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`group relative flex w-full items-start gap-4 rounded-xl py-2.5 pr-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-50 ${
                    reachable && !isCurrent ? 'cursor-pointer' : isCurrent ? 'cursor-default' : 'cursor-not-allowed'
                  }`}
                >
                  <StepBadge entry={entry} isCurrent={isCurrent} />
                  <span className="min-w-0 pt-0.5">
                    <span
                      className={`block text-[14px] font-semibold leading-tight tracking-[-0.01em] transition-colors ${
                        isCurrent ? 'text-surface-950' : reachable ? 'text-surface-700 group-hover:text-surface-950' : 'text-surface-400'
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

        <p className="mt-auto flex items-start gap-2.5 border-t border-brand-100 pt-5 text-pretty text-[12.5px] leading-[1.55] text-surface-500">
          <ShieldCheck size={16} strokeWidth={1.8} className="mt-px flex-shrink-0 text-success-600" aria-hidden="true" />
          <span>Rankvora never changes your store without your approval. Your answers save as you move between steps.</span>
        </p>
      </div>
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
 * A very large, very faint numeral sits behind the top-right corner. It is decoration only
 * (`aria-hidden`): the real "Step 2 of 5" is in the text, and the numeral just gives each step a
 * face of its own as the sheet changes.
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
    <header className="relative px-5 pb-1 pt-6 sm:px-10 sm:pt-10">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-6 top-3 select-none text-[120px] font-semibold leading-none tracking-[-0.06em] text-surface-100 tabular-nums sm:right-10 sm:text-[148px]"
      >
        {String(step).padStart(2, '0')}
      </span>
      <div className="relative flex items-center gap-3">
        {Icon && (
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-surface-0 shadow-[0_10px_22px_-12px_var(--c-brand-600)]">
            <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
          </span>
        )}
        <p className="text-[12.5px] font-medium tabular-nums text-surface-500">
          Step {step} of {total}
        </p>
      </div>
      <h1 className="relative mt-5 max-w-[16ch] text-balance text-[28px] font-semibold leading-[1.08] tracking-[-0.035em] text-surface-950 sm:max-w-none sm:text-[36px]">
        {title}
      </h1>
      {purpose && <p className="relative mt-2.5 max-w-[56ch] text-pretty text-[14.5px] leading-[1.55] text-surface-500">{purpose}</p>}
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
  return <div className="onboarding-stagger -mb-9 grid gap-x-8 gap-y-0 md:grid-cols-2">{children}</div>;
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
 * `error` renders in the control's own cell, directly under it: a merchant who has just been stopped
 * should read what is wrong before they read a suggestion, and in the shared row below it would sit
 * beneath the TALLEST control in the row, a neighbouring tag field's helper line included.
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
    <div className={`row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 pb-9 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <label htmlFor={htmlFor} className="text-[14px] font-semibold tracking-[-0.01em] text-surface-950">
          {label}
        </label>
        {badge && <Badge tone={badge}>{badge === 'required' ? 'Required' : 'Optional'}</Badge>}
      </div>
      <p id={`${htmlFor}-hint`} className="mt-1 text-pretty text-[12.5px] leading-[1.45] text-surface-500">
        {hint}
      </p>
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
      className={`row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0 pb-9 ${className}`}
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
 * Setup's buttons: 48px, the size of a comfortable thumb target, because this is the one thing a
 * merchant is meant to press.
 *
 * The primary is the brand colour: the same one that marks what is chosen and how far along setup
 * is, so there is a single accent in the whole flow. `text-surface-0` inverts with the theme, which
 * keeps its label readable on the brand fill in both.
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
      'bg-brand-600 text-surface-0 shadow-[0_1px_2px_var(--c-shadow-md),inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-brand-500 hover:shadow-[0_14px_26px_-14px_var(--c-brand-600)]',
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
      className={`inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-6 text-[14.5px] font-semibold tracking-[-0.01em] transition-[background-color,box-shadow,transform,color] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none motion-reduce:active:scale-100 ${tone} ${className}`}
    >
      {loading && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * A fact Shopify reported, shown read-only. A missing value says so instead of showing a default.
 *
 * WHY it is missing is said too. "Not reported by Shopify" is only true when Shopify was asked and
 * did not say; when the request itself failed, nothing was reported because nothing was heard, and
 * `missing` lets the caller say that instead.
 */
export function FactTile({ label, value, icon: Icon, missing = 'Not reported by Shopify' }: { label: string; value: string | null; icon?: LucideIcon; missing?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-surface-50 px-4 py-3.5 ring-1 ring-inset ring-surface-200/70">
      {Icon && (
        <span className="mt-px flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-surface-0 text-surface-500 ring-1 ring-inset ring-surface-200">
          <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-[11.5px] font-medium text-surface-500">{label}</p>
        {value ? (
          <p className="mt-0.5 truncate text-[14px] font-semibold tracking-[-0.01em] text-surface-950" title={value}>
            {value}
          </p>
        ) : (
          <p className="mt-0.5 text-[13px] text-surface-400">{missing}</p>
        )}
      </div>
    </div>
  );
}

// ─── Controls ────────────────────────────────────────────────────────

/**
 * The "filled" field: a soft well with a hairline ring that lifts to white and takes a brand ring
 * on focus. `ring-inset` keeps the 1px/2px line inside the box, so a field never changes size when
 * it is focused, and the leading icon (when there is one) sits in the padding the input reserves.
 */
const controlBase =
  'w-full rounded-xl border-0 bg-surface-50 text-[14.5px] text-surface-950 outline-none ring-1 ring-inset transition-[box-shadow,background-color] duration-150 placeholder:text-surface-400 focus:bg-surface-0 focus:ring-2';

/** Neutral or flagged. Kept in one place so every control in the flow marks a missing answer the
 * same way — a red ring that survives focus, rather than a border that disappears when tabbed to. */
function controlTone(invalid?: boolean) {
  return invalid
    ? 'bg-critical-50/50 ring-critical-300 hover:ring-critical-400 focus:ring-critical-500 focus:shadow-[0_0_0_4px_var(--c-critical-100)]'
    : 'ring-surface-200 hover:bg-surface-0 hover:ring-surface-300 focus:ring-brand-500 focus:shadow-[0_0_0_4px_var(--c-brand-100)]';
}

/**
 * Both ids are named whether or not the error exists: a description that points at a missing
 * element is ignored, and naming it unconditionally means the message is announced the moment it
 * appears without re-wiring the field.
 */
function describedBy(id: string) {
  return `${id}-hint ${id}-error`;
}

/** The icon inside a field. It warms to the brand colour when the field has focus. */
function LeadingIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      size={17}
      strokeWidth={1.8}
      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 transition-colors duration-150 group-focus-within:text-brand-600"
      aria-hidden="true"
    />
  );
}

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  icon,
  maxLength,
  onBlur,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** A mark for what the field holds, shown inside it on the left. */
  icon?: LucideIcon;
  /** The longest value the server will take, so the field stops there instead of a save failing. */
  maxLength?: number;
  /** Called when the field loses focus — the moment to check what was typed. */
  onBlur?: () => void;
}) {
  return (
    <div className="group relative">
      {icon && <LeadingIcon icon={icon} />}
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        aria-describedby={describedBy(id)}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={`${controlBase} ${controlTone(invalid)} h-12 ${icon ? 'pl-11' : 'pl-4'} pr-4`}
      />
    </div>
  );
}

// ─── Searchable pickers ──────────────────────────────────────────────

/**
 * One thing a picker can offer: what is stored, and what the merchant reads.
 *
 * Both are kept because the two differ for anything an id stands behind — a product's handle and its
 * title, a language's code and its name — and a picker that showed the value would show the id.
 */
export interface ComboOption {
  value: string;
  label: string;
}

/** The most options drawn at once. A longer list is searched, not scrolled: it says how many more there are. */
const MAX_OPTIONS_SHOWN = 100;

/** The options whose label contains `query`, those that START with it first, so "can" finds Canada before Mexican. */
function matchOptions<T extends { label: string }>(options: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  const starting: T[] = [];
  const containing: T[] = [];
  for (const option of options) {
    const label = option.label.toLowerCase();
    if (label.startsWith(needle)) starting.push(option);
    else if (label.includes(needle)) containing.push(option);
  }
  return [...starting, ...containing];
}

/** Keeps the highlighted option in view as the arrow keys move through a long list. */
function useScrollActiveIntoView(open: boolean, listId: string, active: number) {
  useEffect(() => {
    if (!open) return;
    const element = document.getElementById(`${listId}-opt-${active}`);
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
  }, [open, listId, active]);
}

/**
 * The drop-down list both pickers share.
 *
 * Options take the press on `mousedown` and stop it (`preventDefault`), so the input keeps focus: the
 * list closes when the input loses focus, and without this the click that is meant to choose an
 * option would first close the list and never reach it.
 */
function OptionList({
  id,
  options,
  active,
  selectedValue,
  hiddenCount,
  emptyText,
  onPick,
  onHover,
}: {
  id: string;
  options: readonly ComboOption[];
  active: number;
  selectedValue?: string;
  hiddenCount: number;
  emptyText: string;
  onPick: (option: ComboOption) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      className="absolute left-0 right-0 top-full z-30 mt-1.5 max-h-64 overflow-y-auto rounded-xl bg-surface-0 p-1.5 shadow-[0_24px_48px_-20px_var(--c-shadow-lg),0_4px_14px_-6px_var(--c-shadow-md)] ring-1 ring-inset ring-surface-200"
    >
      {options.length === 0 ? (
        <div role="presentation" className="px-3 py-2.5 text-[13px] text-surface-500">
          {emptyText}
        </div>
      ) : (
        options.map((option, index) => {
          const chosen = option.value === selectedValue;
          return (
            <div
              key={option.value}
              id={`${id}-opt-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={chosen}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(option);
              }}
              onMouseEnter={() => onHover(index)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-[14px] ${
                index === active ? 'bg-brand-50 text-brand-900' : 'text-surface-800'
              } ${chosen ? 'font-semibold' : ''}`}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {chosen && <Check size={15} strokeWidth={2.6} className="flex-shrink-0 text-brand-600" aria-hidden="true" />}
            </div>
          );
        })
      )}
      {hiddenCount > 0 && (
        <div role="presentation" className="px-3 pb-1 pt-2 text-[12px] text-surface-500">
          {hiddenCount.toLocaleString()} more — keep typing to narrow the list
        </div>
      )}
    </div>
  );
}

/**
 * A searchable single choice: type to narrow the list, arrow keys and Enter to choose, Escape to close.
 *
 * It replaces the browser's own drop-down, which for a long list (250 countries, a store's whole
 * catalogue) offers nothing but a scroll. This is the WAI-ARIA combobox: the input is the
 * `combobox`, the list is a `listbox`, and the highlighted option is named by `aria-activedescendant`
 * so a screen reader follows the arrows without focus ever leaving the field.
 *
 * Closed, the field shows the chosen label. Open, it shows what is being typed, with the chosen label
 * as the placeholder so the current answer is never lost from view. `value=""` with no option for
 * "" is the "add one" form: choosing calls `onChange` and the field goes back to its prompt.
 */
export function Combobox({
  id,
  value,
  options,
  placeholder,
  onChange,
  invalid,
  disabled = false,
  icon,
  emptyText = 'No matches',
}: {
  id: string;
  value: string;
  options: readonly ComboOption[];
  placeholder: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  emptyText?: string;
}) {
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.value === value);
  const matches = useMemo(() => matchOptions(options, query), [options, query]);
  const shown = matches.slice(0, MAX_OPTIONS_SHOWN);
  useScrollActiveIntoView(open, listId, active);

  const show = () => {
    if (disabled) return;
    setOpen(true);
    const index = shown.findIndex((option) => option.value === value);
    setActive(index >= 0 ? index : 0);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (option: ComboOption) => {
    onChange(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) show();
      else setActive((index) => Math.min(index + 1, Math.max(0, shown.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && shown[active]) {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="group relative">
      {icon && <LeadingIcon icon={icon} />}
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown.length > 0 ? `${listId}-opt-${active}` : undefined}
        aria-describedby={describedBy(id)}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : (selected?.label ?? '')}
        placeholder={open && selected ? selected.label : placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={show}
        onClick={show}
        onBlur={close}
        onKeyDown={onKeyDown}
        className={`${controlBase} ${controlTone(invalid)} h-12 ${icon ? 'pl-11' : 'pl-4'} pr-11 disabled:cursor-not-allowed disabled:bg-surface-100 disabled:opacity-60 disabled:hover:bg-surface-100`}
      />
      <ChevronDown
        size={16}
        className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-surface-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        aria-hidden="true"
      />
      {open && (
        <OptionList
          id={listId}
          options={shown}
          active={active}
          selectedValue={selected?.value}
          hiddenCount={matches.length - shown.length}
          emptyText={emptyText}
          onPick={pick}
          onHover={setActive}
        />
      )}
    </div>
  );
}

/**
 * The classes of a field that holds chips: the same "filled" well as a text field, drawn around the
 * chips and the input together, so the whole box takes the focus ring.
 */
function chipWell(invalid: boolean | undefined, disabled: boolean, hasIcon: boolean): string {
  const tone = disabled
    ? 'bg-surface-100 ring-surface-200'
    : invalid
      ? 'bg-critical-50/50 ring-critical-300 hover:ring-critical-400 focus-within:ring-critical-500 focus-within:shadow-[0_0_0_4px_var(--c-critical-100)]'
      : 'group bg-surface-50 ring-surface-200 hover:bg-surface-0 hover:ring-surface-300 focus-within:ring-brand-500 focus-within:shadow-[0_0_0_4px_var(--c-brand-100)]';
  return `flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl py-1.5 pr-2 ring-1 ring-inset transition-[box-shadow,background-color] duration-150 focus-within:bg-surface-0 focus-within:ring-2 ${
    hasIcon ? 'pl-3' : 'pl-2'
  } ${tone}`;
}

/**
 * A searchable multiple choice from a closed list: the chosen ones sit as chips inside the field, and
 * typing narrows what is left to add.
 *
 * Each choice is made once — an option already chosen is not offered again — and Backspace on an empty
 * field takes the last one back, as in any tag field. It reports adds and removes separately
 * (`onAdd` / `onRemove`) rather than handing back a new list, because the caller has rules that hang
 * on each: adding the first market also makes it the primary one.
 */
export function MultiCombobox({
  id,
  values,
  options,
  onAdd,
  onRemove,
  placeholder,
  invalid,
  icon: Icon,
  max,
  emptyText = 'No matches',
}: {
  id: string;
  values: readonly string[];
  options: readonly string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  placeholder: string;
  invalid?: boolean;
  icon?: LucideIcon;
  max?: number;
  emptyText?: string;
}) {
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const full = max !== undefined && values.length >= max;
  const pool = useMemo(() => {
    const taken = new Set(values.map((value) => value.toLowerCase()));
    return options.filter((option) => !taken.has(option.toLowerCase())).map((option) => ({ value: option, label: option }));
  }, [options, values]);
  const matches = useMemo(() => matchOptions(pool, query), [pool, query]);
  const shown = matches.slice(0, MAX_OPTIONS_SHOWN);
  useScrollActiveIntoView(open, listId, active);

  const show = () => {
    if (full) return;
    setOpen(true);
    setActive(0);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (option: ComboOption) => {
    onAdd(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) show();
      else setActive((index) => Math.min(index + 1, Math.max(0, shown.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && open && shown[active]) {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Backspace' && !query && values.length > 0) {
      onRemove(values[values.length - 1]);
    }
  };

  return (
    <div className="relative">
      <div className={chipWell(invalid, false, Boolean(Icon))}>
        {Icon && <Icon size={17} strokeWidth={1.8} className="flex-shrink-0 text-surface-400" aria-hidden="true" />}
        {values.map((value) => (
          <Chip key={value} label={value} onRemove={() => onRemove(value)} />
        ))}
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown.length > 0 ? `${listId}-opt-${active}` : undefined}
          aria-describedby={describedBy(id)}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={full}
          value={query}
          placeholder={full ? `Maximum of ${max} reached` : values.length === 0 ? placeholder : 'Add another…'}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={show}
          onClick={show}
          onBlur={close}
          onKeyDown={onKeyDown}
          className="min-w-[9rem] flex-1 bg-transparent px-1.5 py-1.5 text-[14.5px] text-surface-950 outline-none placeholder:text-surface-400 disabled:cursor-not-allowed"
        />
      </div>
      {open && (
        <OptionList
          id={listId}
          options={shown}
          active={active}
          hiddenCount={matches.length - shown.length}
          emptyText={emptyText}
          onPick={pick}
          onHover={setActive}
        />
      )}
    </div>
  );
}

/**
 * A short, closed choice shown all at once: every option is visible and one press picks it.
 *
 * For a handful of options (how often, which of your markets) this beats a drop-down, which hides the
 * answers behind a click. It is a `radiogroup`: one tab stop for the whole group, arrow keys move the
 * choice (and make it), Home and End jump to the ends. With no value yet, the first option is the one
 * in the tab order, so the group is never unreachable.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  id,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | '';
  onChange: (value: T) => void;
  id?: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const current = options.findIndex((option) => option.value === value);

  const choose = (index: number) => {
    const target = options[(index + options.length) % options.length];
    onChange(target.value);
    refs.current.get(target.value)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') choose(index + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') choose(index - 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(options.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div id={id} role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-surface-100 p-1">
      {options.map((option, index) => {
        const on = index === current;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element) refs.current.set(option.value, element);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (current < 0 && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`h-10 rounded-lg px-4 text-[13.5px] font-medium transition-[background-color,color,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              on
                ? 'bg-surface-0 font-semibold text-surface-950 shadow-[0_1px_3px_var(--c-shadow-md)] ring-1 ring-surface-200'
                : 'text-surface-600 hover:text-surface-950'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A multi-line field with its length counter inside the box, bottom right, where the eye already is. */
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
    <div className="relative">
      <textarea
        id={id}
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-describedby={describedBy(id)}
        onChange={(event) => onChange(event.target.value)}
        className={`${controlBase} ${controlTone(false)} block resize-none px-4 pb-8 pt-3 leading-[1.55]`}
      />
      <p className="pointer-events-none absolute bottom-2.5 right-3.5 font-mono text-[11px] tabular-nums text-surface-400">
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
 *
 * ONCE USED, IT IS GONE. A suggestion has done its job when the merchant takes it, and leaving an
 * "In use" note under the field only repeats what the field already shows. It is not a one-way door:
 * `applied` is read from the field's current value, so if the merchant later changes that value to
 * something else the suggestion is offered again.
 */
export function DetectedNote({
  children,
  action,
}: {
  children: ReactNode;
  action?: { label: string; applied: boolean; onApply: () => void };
}) {
  if (action?.applied) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-brand-50/70 px-3.5 py-2.5 ring-1 ring-inset ring-brand-100">
      <Sparkles size={14} className="flex-shrink-0 text-brand-600" aria-hidden="true" />
      <p className="min-w-[10rem] flex-1 text-pretty text-[12.5px] leading-[1.5] text-surface-700">{children}</p>
      {action && (
        <button
          type="button"
          onClick={action.onApply}
          className="flex-shrink-0 rounded-lg bg-surface-0 px-2.5 py-1 text-[12px] font-semibold text-brand-700 shadow-[0_1px_2px_var(--c-shadow-sm)] ring-1 ring-inset ring-brand-200 transition-[background-color,transform] hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] motion-reduce:active:scale-100"
        >
          {action.label}
        </button>
      )}
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

/**
 * Said when the request for the store's details failed, with the way to try again.
 *
 * The details are only suggestions, so setup never depends on them — the note says so, and every
 * field stays usable. But a failure that leaves the merchant with no suggestions and no sign of why
 * (and no way to ask again short of reloading the page) is a failure they cannot act on.
 */
export function FetchFailedNote({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl bg-warning-50 px-4 py-3 ring-1 ring-inset ring-warning-100">
      <AlertTriangle size={16} className="flex-shrink-0 text-warning-700" aria-hidden="true" />
      <p className="min-w-[12rem] flex-1 text-pretty text-[13px] leading-[1.5] text-warning-700">
        We couldn’t load your store’s details to suggest answers. You can still fill everything in yourself.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg bg-surface-0 px-3.5 text-[13px] font-semibold text-warning-700 shadow-[0_1px_2px_var(--c-shadow-sm)] ring-1 ring-inset ring-warning-100 transition-[background-color,transform] hover:bg-warning-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-warning-600 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:active:scale-100"
      >
        {retrying ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
        {retrying ? 'Trying again…' : 'Try again'}
      </button>
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

// ─── Choice tiles ────────────────────────────────────────────────────

function cardClasses(selected: boolean, className = '') {
  return `group relative flex h-full cursor-pointer items-start gap-3.5 rounded-2xl p-4 ring-1 ring-inset transition-[background-color,box-shadow,transform] duration-200 motion-safe:hover:-translate-y-px ${
    selected
      ? 'bg-brand-50/70 ring-2 ring-brand-500 shadow-[0_10px_20px_-18px_var(--c-brand-600)]'
      : 'bg-surface-0 ring-surface-200 hover:bg-surface-50/70 hover:ring-surface-300 hover:shadow-[0_12px_26px_-20px_var(--c-shadow-lg)]'
  } ${className}`;
}

/**
 * The mark on a tile: it fills with the brand colour when the tile is chosen. With a `rank` it also
 * carries a small number on its corner — "this one is first" — so an ordering is visible on the very
 * tiles it applies to instead of only in a list somewhere else.
 */
function TileIcon({ icon: Icon, selected, rank }: { icon: LucideIcon; selected: boolean; rank?: number }) {
  return (
    <span aria-hidden="true" className="relative flex-shrink-0">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-200 ${
          selected ? 'bg-brand-600 text-surface-0' : 'bg-surface-100 text-surface-600 group-hover:bg-surface-200/70'
        }`}
      >
        <Icon size={18} strokeWidth={1.8} />
      </span>
      {rank !== undefined && (
        <span className="absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold tabular-nums leading-none text-surface-0 ring-2 ring-surface-0">
          {rank}
        </span>
      )}
    </span>
  );
}

/** The selection indicator, at the right edge of a tile: a round radio dot or a square tick. */
function Indicator({ selected, shape }: { selected: boolean; shape: 'round' | 'square' }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center border-2 transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-0 ${
        shape === 'round' ? 'rounded-full' : 'rounded-[7px]'
      } ${selected ? 'border-brand-600 bg-brand-600 text-surface-0' : 'border-surface-300 bg-surface-0 group-hover:border-surface-400'}`}
    >
      {/* surface-0, not white: brand-600 is a pale lavender in dark mode and a white mark on it
          disappears. */}
      {selected && (shape === 'round' ? <span className="h-[7px] w-[7px] rounded-full bg-surface-0" /> : <Check size={13} strokeWidth={3.2} />)}
    </span>
  );
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
  icon,
}: {
  name: string;
  value: string;
  selected: boolean;
  label: string;
  description?: string;
  onSelect: (value: string) => void;
  /** Grid placement, e.g. letting the last card of an odd row span it. */
  className?: string;
  /** A mark for what the option is. */
  icon?: LucideIcon;
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
      {icon && <TileIcon icon={icon} selected={selected} />}
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-semibold leading-snug tracking-[-0.01em] ${selected ? 'text-brand-900' : 'text-surface-950'}`}>
          {label}
        </span>
        {description && <span className="mt-1 block text-pretty text-[12.5px] leading-[1.5] text-surface-500">{description}</span>}
      </span>
      <Indicator selected={selected} shape="round" />
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
  icon,
  rank,
}: {
  id: string;
  checked: boolean;
  label: string;
  description?: string;
  onToggle: (next: boolean) => void;
  icon?: LucideIcon;
  /** Where this choice stands in an order the merchant is building (1 = first). Shown on its mark. */
  rank?: number;
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
      {icon && <TileIcon icon={icon} selected={checked} rank={rank} />}
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-semibold leading-snug tracking-[-0.01em] ${checked ? 'text-brand-900' : 'text-surface-950'}`}>
          {label}
        </span>
        {description && <span className="mt-1 block text-pretty text-[12.5px] leading-[1.5] text-surface-500">{description}</span>}
      </span>
      <Indicator selected={checked} shape="square" />
    </label>
  );
}

/**
 * An on/off setting as a real switch.
 *
 * It is still a native checkbox underneath (`role="switch"`), so it is one tab stop, toggles with
 * Space and is announced as on or off; the track and knob are drawn over it. Used where the answer
 * is a state of the product ("re-analyze automatically") rather than an item picked from a list,
 * which is what a CheckCard is for.
 */
export function ToggleCard({
  id,
  checked,
  label,
  description,
  onToggle,
  icon,
}: {
  id: string;
  checked: boolean;
  label: string;
  description?: string;
  onToggle: (next: boolean) => void;
  icon?: LucideIcon;
}) {
  return (
    <label htmlFor={id} className={cardClasses(checked)}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        className="peer sr-only"
      />
      {icon && <TileIcon icon={icon} selected={checked} />}
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-semibold leading-snug tracking-[-0.01em] ${checked ? 'text-brand-900' : 'text-surface-950'}`}>
          {label}
        </span>
        {description && <span className="mt-1 block text-pretty text-[12.5px] leading-[1.5] text-surface-500">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-0 ${
          checked ? 'bg-brand-600' : 'bg-surface-300'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-surface-0 shadow-[0_1px_3px_var(--c-shadow-md)] transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
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
            className={`inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl px-4 text-[13.5px] font-medium ring-1 ring-inset transition-[background-color,color,box-shadow,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] motion-reduce:active:scale-100 ${
              isSelected
                ? 'bg-brand-600 text-surface-0 ring-brand-600 shadow-[0_10px_20px_-14px_var(--c-brand-600)]'
                : 'bg-surface-0 text-surface-700 ring-surface-200 hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200'
            }`}
          >
            {isSelected && <Check size={14} strokeWidth={2.8} aria-hidden="true" />}
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
  icon: Icon,
  maxItemLength,
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
  /** A mark for what is being collected, at the start of the field. */
  icon?: LucideIcon;
  /** The longest single entry the server will take; a longer one is refused with a note, not sent. */
  maxItemLength?: number;
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
    if (maxItemLength !== undefined && candidate.length > maxItemLength) {
      setNotice(`Keep each entry to ${maxItemLength} characters or fewer.`);
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
      <div className={chipWell(invalid, disabled, Boolean(Icon))}>
        {Icon && <Icon size={17} strokeWidth={1.8} className="flex-shrink-0 text-surface-400" aria-hidden="true" />}
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
          className="min-w-[9rem] flex-1 bg-transparent px-1.5 py-1.5 text-[14.5px] text-surface-950 outline-none placeholder:text-surface-400 disabled:cursor-not-allowed"
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
 * belongs in their targets needs to know which part of their catalogue it came from.
 *
 * A suggestion that has been added is REMOVED from the row — it is in the field now, and the row is
 * only for what is still on offer. When nothing is left the whole row goes. (Removing a term from
 * the field puts its suggestion back, since the match is against the field's current values.)
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
  const lowered = selected.map((value) => value.toLowerCase());
  const remaining = suggestions.filter((suggestion) => !lowered.includes(suggestion.value.toLowerCase()));
  if (remaining.length === 0) return null;

  return (
    <div className="rounded-2xl border border-dashed border-surface-300 bg-surface-50/70 px-4 py-3.5">
      <p id={headingId} className="flex items-center gap-1.5 text-[12px] font-medium text-surface-600">
        <Sparkles size={13} className="text-brand-600" aria-hidden="true" />
        {label}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-labelledby={headingId}>
        {remaining.map((suggestion) => (
          <button
            key={suggestion.value}
            type="button"
            disabled={disabled}
            onClick={() => onAdd(suggestion.value)}
            title={suggestion.hint}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-surface-0 px-3 text-[13px] font-medium text-surface-700 ring-1 ring-inset ring-surface-200 transition-[background-color,color,transform] duration-150 hover:bg-brand-50 hover:text-brand-800 hover:ring-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:active:scale-100"
          >
            <Plus size={13} strokeWidth={2.6} aria-hidden="true" />
            {suggestion.value}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Ordered priority list. Position is the answer, so moving an item is the interaction.
 *
 * Each row carries the same mark as the tile it came from, so the two read as one thing. Labels wrap
 * rather than truncate: on a phone the two arrow buttons take a third of the row, and a name cut to
 * "Product & collection …" is a name the merchant can no longer tell from its neighbour.
 */
export function PriorityList({
  items,
  onReorder,
}: {
  items: Array<{ key: string; label: string; icon?: LucideIcon }>;
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
    'flex h-9 w-9 items-center justify-center rounded-lg text-surface-500 ring-1 ring-inset ring-surface-200 transition-[background-color,color,transform] hover:bg-surface-100 hover:text-surface-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 motion-reduce:active:scale-100';

  return (
    <ol className="divide-y divide-surface-100 overflow-hidden rounded-2xl bg-surface-0 ring-1 ring-inset ring-surface-200">
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <li key={item.key} className="flex items-center gap-3 px-3.5 py-2.5 sm:gap-3.5 sm:px-4">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 font-mono text-[12px] font-semibold tabular-nums text-brand-700 ring-1 ring-inset ring-brand-100">
              {index + 1}
            </span>
            {Icon && <Icon size={17} strokeWidth={1.8} className="hidden flex-shrink-0 text-surface-400 sm:block" aria-hidden="true" />}
            <span className="min-w-0 flex-1 text-pretty text-[14px] font-semibold leading-snug tracking-[-0.01em] text-surface-950">{item.label}</span>
            <span className="flex flex-shrink-0 gap-1.5">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${item.label} up`} className={moveButton}>
                <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                aria-label={`Move ${item.label} down`}
                className={moveButton}
              >
                <ArrowDown size={15} strokeWidth={2.4} aria-hidden="true" />
              </button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
