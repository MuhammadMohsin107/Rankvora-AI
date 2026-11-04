import { card } from './tone';

/**
 * Loading state — mirrors the live layout so nothing shifts on arrival.
 *
 * Every block below is sized to the COMPACT layout the page now renders: a 100px dial, 28px
 * controls, ~34px table rows. A skeleton that keeps the old generous proportions is worse than no
 * skeleton, because the page visibly collapses upward the moment real data lands.
 */
export default function SubPillarSkeleton() {
  return (
    <div className="page-shell" aria-busy="true" aria-label="Loading analysis">
      <div className="skeleton h-2.5 w-36" />

      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="skeleton h-6 w-48" />
          <div className="skeleton h-3 w-80 max-w-full" />
        </div>
        <div className="flex gap-1.5">
          <div className="skeleton h-8 w-32 rounded-md" />
          <div className="skeleton h-8 w-24 rounded-md" />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-12 gap-3">
        <div className={`${card} col-span-12 p-3 xl:col-span-7`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3.5">
            <div className="skeleton h-[84px] w-[84px] flex-shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-3 w-full max-w-sm" />
              <div className="skeleton h-2.5 w-36" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-1.5">
                <div className="skeleton h-2.5 w-16" />
                <div className="skeleton h-4 w-12" />
              </div>
            ))}
          </div>
        </div>

        <div className={`${card} col-span-12 space-y-2.5 p-3.5 xl:col-span-5`}>
          <div className="skeleton h-2.5 w-16" />
          <div className="skeleton h-4 w-36" />
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-1.5">
              <div className="skeleton h-2.5 w-24" />
              <div className="skeleton h-1 w-full rounded-full" />
            </div>
          ))}
        </div>

        <div className={`${card} col-span-12 overflow-hidden`}>
          <div className="space-y-1.5 border-b border-surface-200 px-3.5 py-2.5">
            <div className="skeleton h-2.5 w-16" />
            <div className="skeleton h-4 w-40" />
          </div>
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-start gap-2.5 border-b border-surface-200 px-3.5 py-2.5 last:border-0">
              <div className="skeleton h-7 w-[3px] rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3.5 w-48 max-w-full" />
                <div className="skeleton h-2.5 w-full max-w-md" />
                <div className="skeleton h-2.5 w-32" />
              </div>
            </div>
          ))}
        </div>

        <div className={`${card} col-span-12 overflow-hidden`}>
          <div className="space-y-2 border-b border-surface-200 px-3.5 py-2.5">
            <div className="skeleton h-4 w-36" />
            <div className="flex gap-1.5">
              <div className="skeleton h-7 w-56 rounded-md" />
              <div className="skeleton h-7 w-32 rounded-md" />
            </div>
          </div>
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 border-b border-surface-200 px-3 py-1.5 last:border-0">
              <div className="skeleton h-3.5 w-40" />
              <div className="skeleton h-3.5 flex-1" />
              <div className="skeleton h-3.5 w-8" />
              <div className="skeleton h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
