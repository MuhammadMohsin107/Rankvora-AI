import { Link } from 'react-router-dom';
import { ArrowRight, Check, CircleDashed, Minus } from 'lucide-react';
import {
  CAPABILITY_STATUS_LABEL,
  type Capability,
  type CapabilityStatus,
} from '../../data/onboarding.repository';

/**
 * ─── What the store can actually do ──────────────────────────────────
 *
 * One row per capability, each reporting its REAL state with the reason and the one action that
 * changes it. This replaces "All answered": a store can have answered every question while its
 * Search Console connection is missing and its AI questions are empty, and the first thing a
 * merchant needs to know is which of those is true.
 *
 * Every row comes from the server, derived from live records (connections, audits, tracked
 * questions, the schedule) — nothing on this list is a stored claim that could go stale.
 *
 * TONE. A capability that needs the merchant is shown in the brand colour with the action beside
 * it; it is NOT red. Not having connected Search Console is a thing they can do next, not a fault in
 * their store, and the screen must not read it as one.
 */

const ROW_ICON: Record<CapabilityStatus, { icon: typeof Check; tone: string }> = {
  complete: { icon: Check, tone: 'bg-success-50 text-success-700 ring-success-100' },
  action_required: { icon: CircleDashed, tone: 'bg-brand-50 text-brand-700 ring-brand-200/70' },
  off: { icon: Minus, tone: 'bg-surface-100 text-surface-500 ring-surface-200' },
  unavailable: { icon: Minus, tone: 'bg-surface-100 text-surface-400 ring-surface-200' },
};

/** The actionable rows first, so what needs the merchant is not buried under what already works. */
function sortedForAttention(capabilities: Capability[]): Capability[] {
  const weight: Record<CapabilityStatus, number> = { action_required: 0, off: 1, complete: 2, unavailable: 3 };
  return [...capabilities].sort((a, b) => weight[a.status] - weight[b.status]);
}

/** Dates in a detail line arrive as ISO strings; the merchant reads them in their own locale. */
function readableDetail(detail: string): string {
  return detail.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  });
}

export default function CapabilityList({
  capabilities,
  onlyAttention = false,
  compact = false,
}: {
  capabilities: Capability[];
  /** Show only the rows that need the merchant (and are not unavailable on this server). */
  onlyAttention?: boolean;
  compact?: boolean;
}) {
  const rows = (onlyAttention ? capabilities.filter((entry) => entry.status === 'action_required') : sortedForAttention(capabilities));
  if (rows.length === 0) return null;

  return (
    <ul className="divide-y divide-surface-100 overflow-hidden rounded-lg border border-surface-200 bg-surface-0">
      {rows.map((capability) => {
        const { icon: Icon, tone } = ROW_ICON[capability.status];
        return (
          <li key={capability.key} className={`flex items-start gap-2.5 ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}>
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${tone}`}
            >
              <Icon size={11} strokeWidth={3} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] font-semibold text-surface-900">
                {capability.label}
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-surface-500">
                  {CAPABILITY_STATUS_LABEL[capability.status]}
                </span>
              </p>
              <p className="mt-0.5 text-[11.5px] leading-[1.45] text-surface-500">{readableDetail(capability.detail)}</p>
            </div>
            {capability.action && capability.status !== 'unavailable' && (
              <Link
                to={capability.action.href}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold text-brand-700 transition-colors hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {capability.action.label}
                <ArrowRight size={11} aria-hidden="true" />
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
