import type { ReactNode } from 'react';

/**
 * ─── Donut ───────────────────────────────────────────────────────────
 *
 * A share-of-total ring with its legend beside it. Segment colours are CSS values — a theme token such
 * as `var(--c-success-600)`, never a literal — so the ring follows light and dark. The ring is
 * `role="img"` with the figures spelled out, and each arc carries a <title> for a hover.
 *
 * With nothing to show (every value zero) only the empty track is drawn; it never implies a split.
 *
 * Ported from the Replica mockup's `Donut`.
 */

export interface DonutSegment {
  label: string;
  value: number;
  /** A CSS colour: `var(--c-success-600)`. */
  color: string;
}

interface DonutProps {
  segments: readonly DonutSegment[];
  /** Names the chart for a screen reader: "Products by readiness". */
  label: string;
  size?: number;
  stroke?: number;
  /** The figure in the middle. */
  center?: ReactNode;
  /** A line under it. */
  sub?: ReactNode;
}

export default function Donut({ segments, label, size = 112, stroke = 14, center, sub }: DonutProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  // Where each arc starts, worked out up front: the offset of an arc is the length of those before it.
  const arcs = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => ({ segment, length: total > 0 ? (segment.value / total) * circumference : 0 }))
    .map((arc, index, all) => ({ ...arc, start: all.slice(0, index).reduce((sum, previous) => sum + previous.length, 0) }));

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${segments.map((segment) => `${segment.label} ${segment.value.toLocaleString()}`).join(', ')}`}
        >
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} style={{ stroke: 'var(--c-surface-100)' }} />
          {arcs.map(({ segment, length, start }) => {
            // A small gap between arcs, unless a single segment owns the whole ring.
            const gap = arcs.length > 1 ? Math.min(1.5, length) : 0;
            return (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
                strokeDashoffset={-start}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                style={{ stroke: segment.color }}
              >
                <title>{`${segment.label}: ${segment.value.toLocaleString()}`}</title>
              </circle>
            );
          })}
        </svg>
        {(center !== undefined || sub !== undefined) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {center !== undefined && <span className="text-[20px] font-semibold leading-none tracking-tight text-surface-950 tabular-nums">{center}</span>}
            {sub !== undefined && <span className="mt-0.5 text-[10px] font-medium text-surface-500">{sub}</span>}
          </div>
        )}
      </div>
      <ul className="space-y-1 text-[12px] text-surface-700">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center gap-2">
            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: segment.color }} aria-hidden="true" />
            <span>{segment.label}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums text-surface-900">{segment.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
