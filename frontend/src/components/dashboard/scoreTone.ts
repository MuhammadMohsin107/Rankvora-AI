import { AlertCircle, AlertTriangle, Info, Target, type LucideIcon } from 'lucide-react';
import type { ScoreStatus, Severity } from '../../data/dashboard/dashboard.types';

/** Score thresholds shared across the dashboard. */
export const SCORE_TARGET = 90; // "Excellent" threshold, shown as a target marker on bars

export function statusFromScore(score: number): ScoreStatus {
  if (score >= SCORE_TARGET) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 50) return 'needs-work';
  return 'critical';
}

export interface Tone {
  /** Small pill/badge styling. */
  badge: string;
  /** Filled bar / dot color. */
  bar: string;
  /** Plain text tint. */
  text: string;
  /** Hex used inside SVG rings. */
  hex: string;
}

// Full class strings so Tailwind can see them at build time.
export const statusTone: Record<ScoreStatus, Tone> = {
  excellent: {
    badge: 'bg-success-50 text-success-700 ring-1 ring-inset ring-success-100',
    bar: 'bg-success-500',
    text: 'text-success-700',
    hex: 'var(--c-success-600)',
  },
  good: {
    badge: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100',
    bar: 'bg-brand-500',
    text: 'text-brand-700',
    hex: 'var(--c-brand-600)',
  },
  'needs-work': {
    badge: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-100',
    bar: 'bg-warning-500',
    text: 'text-warning-700',
    hex: 'var(--c-warning-600)',
  },
  critical: {
    badge: 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-100',
    bar: 'bg-critical-500',
    text: 'text-critical-700',
    hex: 'var(--c-critical-600)',
  },
  // Neutral on purpose: an unmeasured store is not failing, so it must not borrow the
  // critical/warning palette that would read as a bad result.
  'not-measured': {
    badge: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-200',
    bar: 'bg-surface-300',
    text: 'text-surface-600',
    hex: 'var(--c-surface-300)',
  },
};

/**
 * Shared card shell used by every dashboard section.
 *
 * `bg-surface-0` rather than `bg-white`, for the same reason tone.ts's `card` changed: the sheet
 * has to invert with the theme or it ends up holding near-white text on white. The shadow moves
 * to the `--c-shadow-*` tokens, which exist because — as index.css puts it — shadows "read as
 * depth on light and as noise on dark"; the old literals were tuned for a white ground only.
 */
export const cardClass =
  'rounded-2xl border border-surface-200/80 bg-surface-0 shadow-[0_1px_2px_var(--c-shadow-sm),0_1px_3px_var(--c-shadow-sm)]';

/**
 * Hairline for rules INSIDE a card. `surface-100` is the obvious choice and is nearly invisible in
 * dark mode, where it sits two shades off the card itself (#191a1d on #17171a); 200 at reduced
 * opacity reads as a quiet rule in both themes.
 */
export const hairline = 'border-surface-200/70';

export const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low'];

/** How many of `items` carry each severity — every severity is present in the result, zero included.
 * The one count the Winning moves list and the Products moves panel share. */
export function countBySeverity(items: { severity: Severity }[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

export interface SeverityTone {
  label: string;
  icon: LucideIcon;
  /** Small pill carrying the severity word. */
  chip: string;
  /** Icon tile beside an issue row. */
  tile: string;
  /** Solid fill for dots and the row's accent edge. */
  dot: string;
}

/** One severity palette for the issue list and the action list, so the two cannot disagree. */
export const severityTone: Record<Severity, SeverityTone> = {
  critical: {
    label: 'Critical',
    icon: AlertCircle,
    chip: 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-100',
    tile: 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-100',
    dot: 'bg-critical-500',
  },
  high: {
    label: 'High',
    icon: AlertTriangle,
    chip: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-100',
    tile: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-100',
    dot: 'bg-warning-500',
  },
  medium: {
    label: 'Medium',
    icon: Target,
    chip: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100',
    tile: 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100',
    dot: 'bg-brand-500',
  },
  low: {
    label: 'Low',
    icon: Info,
    chip: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-200',
    tile: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-200',
    dot: 'bg-surface-400',
  },
};

/** Re-exported from the canonical definition in data/pillarMeta.ts so this module's existing
 * importers keep working while there is only one map to maintain. */
export { pillarRoutes } from '../../data/pillarMeta';

/**
 * The column class for a row of `count` pillar cards from `xl` up. Tailwind only emits class names
 * it can read whole, so the counts a row can have are spelled out — one card per visible pillar,
 * with no empty column left where a hidden pillar's card would have been.
 */
const PILLAR_COLUMNS: Record<number, string> = {
  1: 'xl:grid-cols-1',
  2: 'xl:grid-cols-2',
  3: 'xl:grid-cols-3',
  4: 'xl:grid-cols-4',
  5: 'xl:grid-cols-5',
};
export const pillarColumns = (count: number): string => PILLAR_COLUMNS[count] ?? PILLAR_COLUMNS[5];
