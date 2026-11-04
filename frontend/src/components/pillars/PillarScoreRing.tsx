/**
 * Compact circular score gauge shared by every pillar dashboard header.
 *
 * 72px by default, down from 96. The pillar score is one number among the header's facts, not the
 * page's subject — the sub-pillar cards below it are what the customer came to read — so it keeps
 * its prominence through weight and position rather than through diameter.
 */
export default function PillarScoreRing({
  score,
  size = 72,
  stroke = 6,
  gradientId,
}: {
  score: number;
  size?: number;
  stroke?: number;
  /** Must be unique per rendered instance so multiple rings on one page don't share a gradient def. */
  gradientId: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" className="[stop-color:var(--c-brand-500)]" />
            <stop offset="100%" className="[stop-color:var(--c-success-500)]" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-surface-100" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[20px] font-semibold leading-none tracking-tight text-surface-900 tabular-nums">{score}</span>
        <span className="text-[9px] font-medium text-surface-400">/ 100</span>
      </div>
    </div>
  );
}
