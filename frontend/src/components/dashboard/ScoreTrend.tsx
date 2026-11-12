import { useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, LineChart, Minus } from 'lucide-react';
import type { ScoreTrendPoint } from '../../data/dashboard/dashboard.types';
import { SCORE_TARGET, cardClass, hairline } from './scoreTone';

interface Props {
  data: ScoreTrendPoint[];
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

interface Point {
  x: number;
  y: number;
}

/**
 * Monotone cubic path (Fritsch–Carlson) through the points.
 *
 * Monotone rather than a plain spline because a spline overshoots: between two analyses that
 * scored 49 and 46 it can dip to 44, drawing a score the store never had. A monotone curve never
 * leaves the range of the two points it joins, so it smooths the line without inventing values.
 */
function monotonePath(points: Point[]): string {
  const n = points.length;
  if (n < 2) return '';
  if (n === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = (points[i + 1].y - points[i].y) / dx[i];
  }

  // oxlint-disable-next-line unicorn/no-new-array -- n is a length here
  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3;
    d += ` C ${points[i].x + third} ${points[i].y + tangent[i] * third} ${points[i + 1].x - third} ${points[i + 1].y - tangent[i + 1] * third} ${points[i + 1].x} ${points[i + 1].y}`;
  }
  return d;
}

const signed = (value: number) => `${value > 0 ? '+' : ''}${value}`;

/**
 * Overall score over the recent analyses: a smoothed line over a soft fill, the "Excellent" zone
 * shaded above the target, a hover/focus tooltip and a keyboard-focusable point per analysis.
 */
export default function ScoreTrend({ data }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) {
    return (
      <section className={`${cardClass} flex h-full flex-col p-3.5`} aria-labelledby="score-trend-title">
        <h2 id="score-trend-title" className="text-[13px] font-semibold tracking-tight text-surface-950">Score over time</h2>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-5 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100">
            <LineChart size={18} aria-hidden="true" />
          </span>
          <p className="max-w-[240px] text-[12.5px] text-surface-500">
            No score history yet.
          </p>
        </div>
      </section>
    );
  }

  const scores = data.map((p) => p.score);
  const minScore = Math.min(...scores, SCORE_TARGET);
  const maxScore = Math.max(...scores, SCORE_TARGET);
  const yMin = Math.max(0, Math.floor((minScore - 6) / 5) * 5);
  const yMax = Math.min(100, Math.ceil((maxScore + 4) / 5) * 5);
  const yRange = Math.max(yMax - yMin, 1);

  const current = scores[scores.length - 1];
  const delta = current - scores[scores.length - 2];
  const periodDelta = current - scores[0];
  const DeltaIcon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  const deltaChip =
    delta > 0
      ? 'bg-success-50 text-success-700 ring-success-100'
      : delta < 0
        ? 'bg-critical-50 text-critical-700 ring-critical-100'
        : 'bg-surface-100 text-surface-600 ring-surface-200';

  const width = 520;
  // 520×170: short enough for the card to match the score card beside it, tall enough that a
  // three-point move is still visible against the axis.
  const height = 170;
  const pad = { top: 12, right: 14, bottom: 24, left: 30 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;
  const baseline = pad.top + ch;
  const xFor = (i: number) => pad.left + (i / (data.length - 1)) * cw;
  const yFor = (s: number) => pad.top + ch - ((s - yMin) / yRange) * ch;

  const points = data.map((p, i) => ({ ...p, x: xFor(i), y: yFor(p.score) }));
  const line = monotonePath(points);
  const area = `${line} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;
  const gridValues = [yMin, yMin + yRange / 2, yMax];
  const targetY = yFor(SCORE_TARGET);

  // Several analyses can share a day. Labelling each one repeated the same date under every
  // point ("Sep 24, Sep 24, Sep 24"), so a date is printed only where the day changes.
  const showDate = points.map((p, i) => i === 0 || p.date !== points[i - 1].date);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setActive(nearest);
  };

  const activePoint = active !== null ? points[active] : null;
  const activeShare = activePoint ? activePoint.x / width : 0;
  // Keep the tooltip inside the card at either end of the chart.
  const tooltipShift = activeShare < 0.18 ? '-12%' : activeShare > 0.82 ? '-88%' : '-50%';

  return (
    <section className={`${cardClass} flex h-full flex-col`} aria-labelledby="score-trend-title">
      {/* One line: title, current score, change. The "Trend" eyebrow above the title said the
          same thing twice and cost a line. */}
      <div className={`flex items-center justify-between gap-2 border-b ${hairline} px-3.5 py-2`}>
        <h2 id="score-trend-title" className="text-[13px] font-semibold tracking-tight text-surface-950">Score over time</h2>
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ring-1 ring-inset ${deltaChip}`}>
            <DeltaIcon size={11} strokeWidth={2.5} aria-hidden="true" />
            {delta === 0 ? 'No change' : signed(delta)} vs last
          </span>
          <span className="text-[18px] font-semibold leading-none tracking-tight text-surface-950 tabular-nums">{current}</span>
        </div>
      </div>

      <div className="flex flex-1 items-center px-2.5 pb-1 pt-2">
        {/* The tooltip is positioned against this wrapper, which is exactly the chart's box — so a
            percentage of the viewBox is a percentage of the wrapper, however tall the card grows. */}
        <div className="relative w-full">
          {activePoint && active !== null && (
            <div
              className="pointer-events-none absolute z-10 min-w-[112px] whitespace-nowrap rounded-lg border border-surface-200 bg-surface-0 px-2.5 py-2 shadow-[0_8px_24px_-6px_var(--c-shadow-lg)]"
              style={{
                left: `${activeShare * 100}%`,
                top: `max(0px, calc(${(activePoint.y / height) * 100}% - 64px))`,
                transform: `translateX(${tooltipShift})`,
              }}
              role="status"
            >
              <p className="text-[10px] font-medium text-surface-500">
                {formatDate(activePoint.date)} · Analysis {active + 1} of {points.length}
              </p>
              <p className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[15px] font-semibold tabular-nums text-surface-950">{activePoint.score}</span>
                {active > 0 && (
                  <span className="text-[10.5px] font-medium tabular-nums text-surface-500">
                    {signed(activePoint.score - points[active - 1].score)} vs previous
                  </span>
                )}
              </p>
            </div>
          )}

          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover tooltip on a chart; the same numbers are in the table beside it */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full cursor-crosshair"
            role="img"
            aria-label={`Overall score over the last ${data.length} analyses, from ${scores[0]} to ${current}`}
            onMouseMove={handleMove}
            onMouseLeave={() => setActive(null)}
          >
            <defs>
              <linearGradient id="dashboard-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopOpacity="0.28" className="[stop-color:var(--color-chart-line)]" />
                <stop offset="1" stopOpacity="0" className="[stop-color:var(--color-chart-line)]" />
              </linearGradient>
            </defs>

            {/* The "Excellent" zone: everything above the target, shaded faintly. */}
            {targetY > pad.top && (
              <rect x={pad.left} y={pad.top} width={cw} height={targetY - pad.top} className="fill-success-500" fillOpacity="0.06" />
            )}

            {gridValues.map((v) => (
              <g key={v}>
                <line x1={pad.left} x2={width - pad.right} y1={yFor(v)} y2={yFor(v)} className="stroke-chart-grid" strokeDasharray="2 4" />
                <text x={pad.left - 8} y={yFor(v) + 3.5} textAnchor="end" fontSize="10" className="fill-chart-axis tabular-nums">
                  {Math.round(v)}
                </text>
              </g>
            ))}

            <line x1={pad.left} x2={width - pad.right} y1={targetY} y2={targetY} strokeDasharray="4 4" strokeOpacity="0.7" className="stroke-success-600" />
            <text x={width - pad.right} y={targetY - 5} textAnchor="end" fontSize="10" fontWeight="600" className="fill-success-700">
              Excellent {SCORE_TARGET}+
            </text>

            <path d={area} fill="url(#dashboard-trend-fill)" />
            <path d={line} fill="none" strokeWidth="2.5" className="stroke-chart-line" strokeLinecap="round" strokeLinejoin="round" />

            {activePoint && (
              <line x1={activePoint.x} x2={activePoint.x} y1={pad.top} y2={baseline} strokeDasharray="2 3" className="stroke-surface-400" />
            )}

            {/* Keyed by position: two analyses on the same day share a date, and a duplicate key
                left a stale point drawn on the chart after hovering. */}
            {points.map((p, i) => {
              const isActive = i === active;
              const isLast = i === points.length - 1;
              return (
                <g key={i}>
                  {isLast && <circle cx={p.x} cy={p.y} r={9} className="fill-chart-line" fillOpacity="0.15" />}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isActive ? 5.5 : isLast ? 4.5 : 3.25}
                    className={`outline-none transition-[r] duration-150 stroke-chart-line focus-visible:stroke-brand-300 focus-visible:stroke-[4px] ${isActive || isLast ? 'fill-chart-line' : 'fill-surface-0'}`}
                    strokeWidth="2"
                    tabIndex={0}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  >
                    <title>{`${formatDate(p.date)}: ${p.score}`}</title>
                  </circle>
                  {showDate[i] && (
                    <text
                      x={p.x}
                      y={height - 6}
                      textAnchor={i === 0 ? 'start' : isLast ? 'end' : 'middle'}
                      fontSize="10"
                      className="fill-chart-axis"
                    >
                      {formatDate(p.date)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className={`flex items-center justify-between gap-3 border-t ${hairline} px-3.5 py-1.5 text-[11px] text-surface-500`}>
        <span>
          Last {data.length} analyses · {formatDate(data[0].date)} – {formatDate(data[data.length - 1].date)}
        </span>
        <span className="font-medium tabular-nums text-surface-700">
          {periodDelta === 0 ? 'No change' : `${signed(periodDelta)} pts`} over period
        </span>
      </div>
    </section>
  );
}
