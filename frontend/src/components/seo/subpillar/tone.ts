// Visual tokens for every SEO sub-pillar page.
//
// Direction (approved on Title Tags): hairline borders instead of soft
// shadows, tinted section headers for structure, accent colour used
// sparingly at high contrast.

import type { Severity } from '../../../data/seo/subpillar.model';

export type Tone = Severity | 'healthy';

/** Full class strings so Tailwind sees them at build time. */
export const toneStyles: Record<Tone, { badge: string; bar: string; dot: string; tile: string; text: string; rail: string }> = {
  healthy: {
    badge: 'bg-success-50 text-success-700 ring-1 ring-inset ring-success-600/15',
    bar: 'bg-success-500',
    dot: 'bg-success-500',
    tile: 'bg-success-50 text-success-700 ring-1 ring-inset ring-success-600/15',
    text: 'text-success-700',
    rail: 'bg-success-500',
  },
  critical: {
    badge: 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-600/15',
    bar: 'bg-critical-500',
    dot: 'bg-critical-500',
    tile: 'bg-critical-50 text-critical-700 ring-1 ring-inset ring-critical-600/15',
    text: 'text-critical-700',
    rail: 'bg-critical-500',
  },
  high: {
    badge: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-600/20',
    bar: 'bg-warning-500',
    dot: 'bg-warning-500',
    tile: 'bg-warning-50 text-warning-700 ring-1 ring-inset ring-warning-600/20',
    text: 'text-warning-700',
    rail: 'bg-warning-500',
  },
  medium: {
    badge: 'bg-info-50 text-info-700 ring-1 ring-inset ring-info-600/15',
    bar: 'bg-info-500',
    dot: 'bg-info-500',
    tile: 'bg-info-50 text-info-700 ring-1 ring-inset ring-info-600/15',
    text: 'text-info-700',
    rail: 'bg-info-500',
  },
  low: {
    badge: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-900/10',
    bar: 'bg-surface-400',
    dot: 'bg-surface-400',
    tile: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-900/10',
    text: 'text-surface-600',
    rail: 'bg-surface-300',
  },
};

/**
 * Hairline-bordered surface. No drop shadow — the border does the work.
 *
 * `bg-surface-0`, NOT `bg-white`. This is the raised-sheet token — white in light mode, a lifted
 * near-black in dark — and index.css introduced it as, in its own words, "what `bg-white` used to
 * hardcode and could never adapt". Every card on every sub-pillar page comes from this one
 * constant, so while it said `bg-white` those pages rendered a white sheet holding
 * `text-surface-950` headings, which are near-WHITE in dark mode: the score, the metric strip and
 * the evidence table were all invisible.
 */
export const card = 'rounded-xl border border-surface-200 bg-surface-0';

/**
 * Tinted header band that separates a card's title from its content.
 *
 * Carries its own padding now. Every consumer wrote `${cardHeader} px-6 py-4` and had to be kept
 * in step by hand, which is how the findings card and the evidence card ended up with different
 * header heights on the same page.
 */
export const cardHeader = 'border-b border-surface-200 bg-surface-50/60 px-3.5 py-2';

/** Small uppercase section eyebrow. */
export const eyebrow = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-surface-400';

/** Section heading inside a card. One step below a page section, two below the page title. */
export const cardTitle = 'text-[12.5px] font-semibold tracking-[-0.01em] text-surface-950';

/**
 * Eyebrow and title on ONE baseline instead of stacked.
 *
 * Every card header used to spend two lines on its own name — a 10px category label, then the
 * heading under it. Across the four cards on a sub-pillar page that is roughly 60px of height
 * that names things the customer can already see. Side by side they read as one label
 * ("EVIDENCE Affected URLs") and cost one line.
 */
export const cardHeadingRow = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';

export const statusFromScore = (score: number) =>
  score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical';

/**
 * Stroke colour for the score dial.
 *
 * These four literals were EXACTLY the light-mode values of the semantic -600 tokens
 * (#16a34a/#4f46e5/#ca8a04/#dc2626), so this is a drop-in: light mode is pixel-identical, and
 * dark mode now gets the lifted values the rest of the UI already uses. The dial was previously
 * the one element on the page still painted from the light palette.
 *
 * `var()` is valid in an SVG `stroke` because presentation attributes ARE CSS properties.
 */
export const scoreHex = (score: number) =>
  score >= 90
    ? 'var(--c-success-600)'
    : score >= 75
      ? 'var(--c-brand-600)'
      : score >= 50
        ? 'var(--c-warning-600)'
        : 'var(--c-critical-600)';
