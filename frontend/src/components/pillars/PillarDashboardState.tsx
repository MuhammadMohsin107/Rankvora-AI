// Loading / empty / error states shared by the five pillar dashboards.
//
// The empty state is the important one. These pages used to fill their layout with hard-coded
// scores when no audit existed, which read as a real measurement of the merchant's store. An
// unaudited store now says so.

import { AlertCircle, Radar } from 'lucide-react';
import Button from '../../components/polaris/Button';

export function PillarDashboardSkeleton({ title }: { title: string }) {
  return (
    <div>
      <div className="page-shell section-stack">
        {/* Sized to the compact live layout — a ~96px header band, 68px KPI tiles and the area
            grid — so the page does not visibly shrink the instant real data arrives. */}
        <div className="h-24 animate-pulse rounded-lg border border-surface-200 bg-surface-0" />
        <div className="grid-cards grid-cols-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[68px] animate-pulse rounded-lg border border-surface-200 bg-surface-0" />
          ))}
        </div>
        <div className="grid-cards grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[132px] animate-pulse rounded-lg border border-surface-200 bg-surface-0" />
          ))}
        </div>
        <span className="sr-only">Loading {title} analysis…</span>
      </div>
    </div>
  );
}

/**
 * Shown when the store has no audit for this pillar. Deliberately carries no score, no chart
 * and no placeholder digits — there is nothing measured to show, and saying so is the point.
 */
export function PillarDashboardEmpty({ title }: { title: string }) {
  return (
    <div>
      <div className="page-shell">
        <div className="card flex min-h-[260px] flex-col items-center justify-center border border-surface-200 p-6 text-center">
          <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
            <Radar size={20} className="text-brand-600" />
          </div>
          <h2 className="mb-3 text-[15px] font-semibold text-surface-900">No {title} audit yet</h2>
          <Button variant="primary" to="/">
            
            Run an audit
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PillarDashboardError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div>
      <div className="page-shell">
        <div className="card flex min-h-[240px] flex-col items-center justify-center border border-surface-200 p-6 text-center">
          <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-lg bg-critical-50">
            <AlertCircle size={20} className="text-critical-500" />
          </div>
          <h2 className="mb-3 text-[15px] font-semibold text-surface-900">Unable to load {title}</h2>
          <Button variant="primary" onClick={onRetry}>
            
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Marks seeded demo fixtures so they can never be mistaken for a measurement of a real store. */
export function SeedDataNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2">
      <AlertCircle size={14} className="mt-px shrink-0 text-warning-600" />
      <p className="text-[12px] leading-[1.45] text-warning-800">
        <span className="font-semibold">Demo data.</span> Not a measurement of your store.
      </p>
    </div>
  );
}
