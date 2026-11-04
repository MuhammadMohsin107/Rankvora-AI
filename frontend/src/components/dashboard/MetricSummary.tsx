import { ArrowDownRight, ArrowUpRight, CircleAlert, FileCheck2, ListChecks, type LucideIcon } from 'lucide-react';
import type { KeyMetric } from '../../data/dashboard/dashboard.types';

interface Props {
  metrics: KeyMetric[];
  /** Jumps to where that figure is explained in full — the open issues list, filtered to this
   * metric's severity, or (for "Passed") the per-pillar breakdown. Omitted, the tiles are inert. */
  onSelect?: (id: string) => void;
}

const metricIcon: Record<string, LucideIcon> = {
  issues: ListChecks,
  critical: CircleAlert,
  passed: FileCheck2,
};

const metricTile: Record<string, string> = {
  issues: 'bg-brand-50 text-brand-700 ring-brand-100',
  critical: 'bg-critical-50 text-critical-700 ring-critical-100',
  passed: 'bg-success-50 text-success-700 ring-success-100',
};

/**
 * The supporting figures beside the Overall Health score: a column of three beside the dial from
 * lg up, a row of three below it on narrower screens.
 *
 * Each tile is two lines — the label, then the value with its context on the same baseline — so
 * the column is no taller than the dial it sits beside. Tiles sit on the page ground
 * (`surface-50`) rather than the card, so they read as inset panels of the hero in both themes.
 */
export default function MetricSummary({ metrics, onSelect }: Props) {
  const tiles = metrics.filter((metric) => metric.id !== 'overall-health');

  return (
    <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 lg:grid-cols-1" aria-label="Key figures from the latest analysis">
      {tiles.map((metric) => {
        const Icon = metricIcon[metric.id] ?? ListChecks;
        const isPositive = metric.id === 'issues' ? metric.trend === 'down' : metric.trend === 'up';
        const TrendIcon = metric.trend === 'down' ? ArrowDownRight : ArrowUpRight;

        const Tile = onSelect ? 'button' : 'div';
        return (
          <Tile
            key={metric.id}
            type={onSelect ? 'button' : undefined}
            onClick={onSelect ? () => onSelect(metric.id) : undefined}
            aria-label={onSelect ? `See ${metric.label.toLowerCase()}` : undefined}
            className={`flex w-full items-center gap-2.5 rounded-lg border border-surface-200/70 bg-surface-50/80 px-2.5 py-1.5 text-left transition-colors ${
              onSelect ? 'cursor-pointer hover:border-surface-300 hover:bg-surface-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500' : ''
            }`}
          >
            <span
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${metricTile[metric.id] ?? 'bg-surface-100 text-surface-600 ring-surface-200'}`}
              aria-hidden="true"
            >
              <Icon size={14} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <dt className="truncate text-[10.5px] font-medium leading-tight text-surface-500">{metric.label}</dt>
              <dd className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                <span className="text-[17px] font-semibold leading-none tracking-tight text-surface-950 tabular-nums">
                  {metric.value.toLocaleString()}
                </span>
                {metric.suffix && <span className="text-[11.5px] font-medium text-surface-400">{metric.suffix}</span>}
                {metric.trend && metric.trend !== 'stable' && metric.trendValue !== undefined && (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ${
                      isPositive ? 'bg-success-50 text-success-700' : 'bg-critical-50 text-critical-700'
                    }`}
                  >
                    <TrendIcon size={11} aria-hidden="true" />
                    {metric.trend === 'up' ? '+' : '-'}
                    {metric.trendValue}
                  </span>
                )}
                {metric.context && <span className="truncate text-[10.5px] text-surface-500">{metric.context}</span>}
              </dd>
            </div>
          </Tile>
        );
      })}
    </dl>
  );
}
