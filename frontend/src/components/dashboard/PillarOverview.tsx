import { ArrowUpRight, FileText, Search, Sparkles, Target, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { PillarScore } from '../../data/dashboard/dashboard.types';
import { pillarMeta } from '../../data/pillarMeta';
import Badge from '../polaris/Badge';
import { SCORE_TARGET, cardClass, pillarColumns, pillarRoutes, statusBadgeTone, statusTone } from './scoreTone';

interface Props {
  pillars: PillarScore[];
}

const iconMap: Record<string, React.ReactNode> = {
  search: <Search size={13} strokeWidth={2} />,
  'file-text': <FileText size={13} strokeWidth={2} />,
  zap: <Zap size={13} strokeWidth={2} />,
  target: <Target size={13} strokeWidth={2} />,
  sparkles: <Sparkles size={13} strokeWidth={2} />,
};

/**
 * Side-by-side pillar comparison. Each card is a compact bullet chart — score, status, a filled bar
 * against the "Excellent" target marker, and the items healthy — and clicks through to the pillar.
 *
 * The pillar's identity colour marks the card (top edge, icon tile) so it is recognisable at a
 * glance, the same colour it carries in the sidebar and on issue tags. The BAR stays in the status
 * colour: it answers "how is this pillar doing", which is a different question from "which one".
 *
 * No description line. It restated the counts directly above it ("only 291 of 546 analyzed items
 * are healthy" under "291/546 items healthy"), so it doubled every card's height for nothing new.
 */
export default function PillarOverview({ pillars }: Props) {
  const navigate = useNavigate();

  return (
    <section aria-labelledby="pillar-performance-title">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 id="pillar-performance-title" className="text-[13px] font-semibold tracking-[-0.01em] text-surface-900">Pillars</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-surface-500">
          <span className="inline-block h-3 w-0.5 rounded-full bg-surface-900" aria-hidden="true" />
          Target {SCORE_TARGET} · Excellent
        </span>
      </div>

      <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${pillarColumns(pillars.length)}`}>
        {pillars.map((pillar) => {
          const tone = statusTone[pillar.status];
          const meta = pillarMeta[pillar.key];
          // null score = this pillar produced no measurable result. The card still renders, and
          // still navigates, so the merchant can reach the pillar and see why.
          const measured = pillar.score !== null;
          const gap = measured ? SCORE_TARGET - pillar.score! : null;
          return (
            <button
              key={pillar.key}
              type="button"
              onClick={() => navigate(pillarRoutes[pillar.key] ?? '/')}
              className={`${cardClass} group relative flex cursor-pointer flex-col overflow-hidden px-3 pb-2.5 pt-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-surface-300 hover:shadow-[0_12px_28px_-12px_var(--c-shadow-lg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
              aria-label={
                measured
                  ? `Open ${pillar.label}, score ${pillar.score} out of 100, ${pillar.statusLabel}, ${pillar.checksPassed} of ${pillar.checksTotal} items healthy`
                  : `Open ${pillar.label}, not analyzed yet`
              }
            >
              <span className="absolute inset-x-0 top-0 h-[2px]" style={{ backgroundColor: meta?.color }} aria-hidden="true" />

              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                    style={{ backgroundColor: meta?.tint, color: meta?.color }}
                    aria-hidden="true"
                  >
                    {iconMap[pillar.icon] ?? <Target size={13} />}
                  </span>
                  <span className="truncate text-[12px] font-semibold text-surface-900">{pillar.label}</span>
                </span>
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-surface-300 transition-colors group-hover:bg-surface-100 group-hover:text-surface-700" aria-hidden="true">
                  <ArrowUpRight size={13} />
                </span>
              </div>

              <div className="mt-2 flex items-end gap-1">
                {measured ? (
                  <>
                    <span className="text-[24px] font-semibold leading-none tracking-[-0.03em] text-surface-950 tabular-nums">{pillar.score}</span>
                    <span className="pb-px text-[10.5px] font-medium text-surface-400">/100</span>
                  </>
                ) : (
                  // An em dash, not a 0 — a pillar we could not measure must never read as a
                  // pillar that scored zero.
                  <span className="text-[24px] font-semibold leading-none tracking-tight text-surface-300 tabular-nums">—</span>
                )}
                <span className="ml-auto"><Badge tone={statusBadgeTone[pillar.status]}>{pillar.statusLabel}</Badge></span>
              </div>

              {/* Bullet bar with target marker. Unmeasured pillars show an empty track: there is
                  no value to plot, and a zero-width bar would still imply a measured zero. */}
              <div className="relative mt-2 h-1.5 w-full rounded-full bg-surface-200/70" aria-hidden="true">
                {measured && (
                  <div
                    className={`h-full rounded-full ${tone.bar} transition-[width] duration-700 ease-out motion-reduce:transition-none`}
                    style={{ width: `${pillar.score}%` }}
                  />
                )}
                <span className="absolute -top-[3px] h-3 w-0.5 rounded-full bg-surface-900" style={{ left: `calc(${SCORE_TARGET}% - 1px)` }} />
              </div>

              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] text-surface-500">
                {measured ? (
                  <>
                    <span className="tabular-nums">
                      <span className="font-semibold text-surface-800">{pillar.checksPassed.toLocaleString()}</span>
                      /{pillar.checksTotal.toLocaleString()} healthy
                    </span>
                    <span className={gap !== null && gap > 0 ? 'tabular-nums' : 'font-medium text-success-700'}>
                      {gap !== null && gap > 0 ? `${gap} to target` : 'On target'}
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-surface-400">Not analyzed yet</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
