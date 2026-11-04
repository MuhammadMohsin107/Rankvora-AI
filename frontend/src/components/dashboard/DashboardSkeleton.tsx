import { pillarOrder } from '../../data/pillarMeta';
import { cardClass, hairline, pillarColumns } from './scoreTone';

/**
 * Skeleton loading state for the dashboard.
 * Mirrors the live layout (header → hero + trend → pillar cards → issues + actions) using the same
 * card shell, gaps and heights, so nothing jumps when data arrives.
 */
export default function DashboardSkeleton() {
  return (
    <div className="page-shell space-y-3 pt-3" aria-busy="true" aria-label="Loading dashboard">
      {/* Header */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2.5">
          <div className="skeleton h-5 w-28" />
          <div className="skeleton hidden h-3 w-64 md:block" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <div className="skeleton h-8 w-60 rounded-lg" />
          <div className="skeleton h-8 w-32 rounded-lg" />
          <div className="skeleton h-8 w-20 rounded-lg" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {/* Hero */}
        <div className={`${cardClass} col-span-12 flex flex-col gap-3 p-3.5 lg:flex-row lg:items-center lg:gap-4 xl:col-span-8`}>
          <div className="flex flex-1 flex-col items-center gap-3 sm:flex-row sm:gap-4">
            <div className="skeleton h-[132px] w-[132px] flex-shrink-0 rounded-full" />
            <div className="w-full flex-1 space-y-2">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-6 w-40" />
              <div className="skeleton h-3.5 w-full max-w-md" />
              <div className="skeleton h-3 w-48" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 lg:w-[228px] lg:grid-cols-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg border border-surface-200/70 px-2.5 py-1.5">
                <div className="skeleton h-7 w-7 flex-shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-2.5 w-16" />
                  <div className="skeleton h-4 w-20" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Trend */}
        <div className={`${cardClass} col-span-12 flex flex-col xl:col-span-4`}>
          <div className={`flex items-center justify-between border-b ${hairline} px-3.5 py-2`}>
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-5 w-20" />
          </div>
          <div className="flex-1 p-2.5">
            <div className="skeleton h-[140px] w-full rounded-lg" />
          </div>
          <div className={`border-t ${hairline} px-3.5 py-1.5`}>
            <div className="skeleton h-3 w-48" />
          </div>
        </div>

        {/* Pillars */}
        <div className="col-span-12">
          <div className="mb-2 flex items-center gap-2">
            <div className="skeleton h-3 w-12" />
            <div className="skeleton h-3.5 w-36" />
          </div>
          <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${pillarColumns(pillarOrder.length)}`}>
            {/* One placeholder per pillar the customer can see, so the loading state shows the same
                number of cards the page will. */}
            {pillarOrder.map((key) => (
              <div key={key} className={`${cardClass} space-y-2 px-3 pb-2.5 pt-3`}>
                <div className="flex items-center gap-2">
                  <div className="skeleton h-6 w-6 rounded-md" />
                  <div className="skeleton h-3.5 w-16" />
                </div>
                <div className="skeleton h-6 w-14" />
                <div className="skeleton h-1.5 w-full rounded-full" />
                <div className="skeleton h-2.5 w-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Issues */}
        <div className={`${cardClass} col-span-12 xl:col-span-7`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 border-b ${hairline} px-3.5 py-2`}>
            <div className="skeleton h-4 w-36" />
            <div className="flex gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="skeleton h-5 w-14 rounded-md" />
              ))}
            </div>
          </div>
          <div className="divide-y divide-surface-200/60">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3.5 py-2">
                <div className="skeleton h-7 w-7 flex-shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 w-64 max-w-full" />
                  <div className="skeleton h-3 w-48" />
                </div>
                <div className="skeleton h-3.5 w-14" />
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className={`${cardClass} col-span-12 xl:col-span-5`}>
          <div className={`flex items-center justify-between border-b ${hairline} px-3.5 py-2`}>
            <div className="skeleton h-4 w-40" />
            <div className="skeleton h-4 w-24 rounded-full" />
          </div>
          <div className="px-3.5 py-0.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2">
                <div className="skeleton h-6 w-6 flex-shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 w-52 max-w-full" />
                  <div className="skeleton h-3 w-full" />
                  <div className="skeleton h-3 w-32" />
                </div>
                <div className="skeleton h-6 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
