import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

export type KpiAccent = 'brand' | 'success' | 'warning' | 'critical' | 'info' | 'neutral';

interface PillarKpiCardProps {
  label: string;
  value: string;
  trend?: string;
  /** true = trend is a good outcome (green), false = bad (red), undefined = neutral (gray). Arrow direction always reflects the trend's actual sign. */
  trendGood?: boolean;
  /** Optional icon shown in a tinted tile at the top-right of the card. */
  icon?: LucideIcon;
  /** Tint used for the icon tile. Defaults to brand. */
  accent?: KpiAccent;
  subtitle?: string;
  breakdown?: { label: string; value: string; color?: string }[];
  /** Present on a tile that leads somewhere — filters and scrolls to this pillar's issue list, or
   * (Areas Measured) to its area grid. Absent, the tile stays a plain figure, as before. */
  onClick?: () => void;
}

// Full class strings so Tailwind can see them at build time.
const accentTile: Record<KpiAccent, string> = {
  brand: 'bg-brand-50 text-brand-600 ring-brand-100',
  success: 'bg-success-50 text-success-600 ring-success-100',
  warning: 'bg-warning-50 text-warning-600 ring-warning-100',
  critical: 'bg-critical-50 text-critical-600 ring-critical-100',
  info: 'bg-info-50 text-info-600 ring-info-100',
  neutral: 'bg-surface-100 text-surface-600 ring-surface-200',
};

/**
 * Shared KPI summary tile used across every pillar dashboard's metrics row.
 *
 * This is the ONE KPI tile in the app. components/seo/SeoKpiCard.tsx used to be a byte-for-byte
 * copy of it serving /seo alone, so a density change had to be made twice to stay consistent —
 * and consistency is the entire reason a KPI row exists. /seo now renders this component.
 */
export default function PillarKpiCard({
  label,
  value,
  trend,
  trendGood,
  icon: Icon,
  accent = 'brand',
  subtitle,
  breakdown,
  onClick,
}: PillarKpiCardProps) {
  const cleanTrend = trend?.trim();
  const isDown = cleanTrend?.startsWith('-');
  const isFlat = cleanTrend === '0';

  const trendChip =
    trendGood === undefined
      ? 'bg-surface-100 text-surface-600'
      : trendGood
        ? 'bg-success-50 text-success-700'
        : 'bg-critical-50 text-critical-700';

  const Tile = onClick ? 'button' : 'div';

  return (
    <Tile
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={onClick ? `See ${label.toLowerCase()}` : undefined}
      className={`group relative w-full rounded-lg border border-surface-200 bg-surface-0 px-3 py-2.5 text-left shadow-sm transition-all duration-200 hover:border-surface-300 hover:shadow-md ${
        onClick ? 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11.5px] font-medium leading-tight text-surface-500">{label}</p>
        {Icon && (
          <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ring-1 ${accentTile[accent]}`}>
            <Icon size={13} strokeWidth={2} />
          </span>
        )}
      </div>

      <div className="mt-1.5 flex items-end justify-between gap-2">
        <span className="text-[20px] font-semibold leading-none tracking-tight text-surface-900 tabular-nums">
          {value}
        </span>
        {cleanTrend && (
          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-semibold ${trendChip}`}>
            {isFlat ? <Minus size={10} /> : isDown ? <TrendingDown size={10} /> : <TrendingUp size={10} />}
            {cleanTrend}
          </span>
        )}
      </div>

      {subtitle && <p className="mt-1 text-[10.5px] text-surface-500">{subtitle}</p>}

      {breakdown && (
        <div className="mt-2 flex gap-2 border-t border-surface-100 pt-2">
          {breakdown.map((item, idx) => (
            <div key={idx} className="flex-1">
              <p className="text-[10px] text-surface-500">{item.label}</p>
              <p className="text-[12.5px] font-semibold text-surface-900">{item.value}</p>
            </div>
          ))}
        </div>
      )}
    </Tile>
  );
}
