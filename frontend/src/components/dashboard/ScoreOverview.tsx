import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { KeyMetric, OverallScore, PillarScore, ScoreTrendPoint } from '../../data/dashboard/dashboard.types';
import { pillarMeta } from '../../data/pillarMeta';
import MetricSummary from './MetricSummary';
import { SCORE_TARGET, cardClass, statusTone } from './scoreTone';
import Banner from '../polaris/Banner';

interface Props {
  data: OverallScore;
  metrics: KeyMetric[];
  trend: ScoreTrendPoint[];
  pillars: PillarScore[];
  /** Forwarded to MetricSummary — see its own doc. */
  onSelectMetric?: (id: string) => void;
}

/** The gauge is a 270° arc open at the bottom: it starts at 135° (bottom-left, measured clockwise
 * from 3 o'clock, as SVG does) and ends at 45° (bottom-right). */
const GAUGE_START = 135;
const GAUGE_SWEEP = 270;

function polar(center: number, radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: center + radius * Math.cos(radians), y: center + radius * Math.sin(radians) };
}

/**
 * Overall score as an arc gauge with the "Excellent" target marked on it — the same dark tick the
 * pillar bars below use, so the page has one way of saying "this is the goal".
 *
 * `measured: false` renders an empty dashed arc and the words "Not measured" instead of a number.
 * The placeholder zero the backend stores is never shown — a store we could not measure must not
 * look like a store that scored 0.
 */
function ScoreGauge({ score, color, measured }: { score: number; color: string; measured: boolean }) {
  // 132px: the score leads the card by weight and colour, not by diameter — the smaller dial is
  // what lets the whole card sit in one row beside its figures.
  const size = 132;
  const stroke = 10;
  const center = size / 2;
  // 4px held back from the edge so the target tick, which overhangs the arc, is not clipped.
  const radius = (size - stroke) / 2 - 4;
  const start = polar(center, radius, GAUGE_START);
  const end = polar(center, radius, GAUGE_START + GAUGE_SWEEP);
  // 270° is more than half a turn, so large-arc is 1; sweep 1 draws clockwise on screen.
  const arc = `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${end.x} ${end.y}`;
  const clamped = Math.max(0, Math.min(100, score));

  const tickAngle = GAUGE_START + (GAUGE_SWEEP * SCORE_TARGET) / 100;
  const tickInner = polar(center, radius - stroke / 2 - 3, tickAngle);
  const tickOuter = polar(center, radius + stroke / 2 + 3, tickAngle);

  return (
    <div
      className="relative h-[132px] w-[132px] flex-shrink-0"
      role="img"
      aria-label={measured ? `Overall score ${score} out of 100, target ${SCORE_TARGET}` : 'Overall score not measured yet'}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          {/* Left-to-right, which is the direction the arc travels over its top half. */}
          <linearGradient id="dashboard-gauge-fill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={size} y2="0">
            <stop offset="0" style={{ stopColor: color, stopOpacity: 0.55 }} />
            <stop offset="1" style={{ stopColor: color, stopOpacity: 1 }} />
          </linearGradient>
        </defs>
        <path
          d={arc}
          fill="none"
          className="stroke-surface-200/70"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={measured ? undefined : '3 7'}
        />
        {/* pathLength=100 makes the dash maths the score itself: offset 100 - score leaves exactly
            `score` percent of the arc drawn. Nothing is drawn for a zero, not even a cap. */}
        {measured && clamped > 0 && (
          <path
            d={arc}
            fill="none"
            stroke="url(#dashboard-gauge-fill)"
            strokeWidth={stroke}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100 100"
            strokeDashoffset={100 - clamped}
            className="score-ring"
          />
        )}
        {measured && (
          <line
            x1={tickInner.x}
            y1={tickInner.y}
            x2={tickOuter.x}
            y2={tickOuter.y}
            strokeWidth={2.5}
            strokeLinecap="round"
            className="stroke-surface-900"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {measured ? (
          <>
            <span className="text-[36px] font-semibold leading-none tracking-[-0.04em] text-surface-950 tabular-nums">{score}</span>
            <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-surface-400">out of 100</span>
          </>
        ) : (
          <span className="px-5 text-center text-[12px] font-semibold leading-snug text-surface-400">Not measured</span>
        )}
      </div>
      {measured && (
        // The arc's open end is the natural place for its legend.
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 text-[9.5px] font-medium text-surface-500">
          <span className="inline-block h-2 w-0.5 rounded-full bg-surface-900" aria-hidden="true" />
          Target {SCORE_TARGET}
        </span>
      )}
    </div>
  );
}

/**
 * Hero card: the one number that matters, its status, a plain-language summary and the supporting
 * figures. A faint wash of the status colour in the corner sets the tone before anything is read;
 * it is a plain gradient on the card, not a blurred layer, so it costs nothing to paint.
 */
export default function ScoreOverview({ data, metrics, trend, pillars, onSelectMetric }: Props) {
  const tone = statusTone[data.status];
  const TrendIcon = data.trend === 'up' ? ArrowUpRight : data.trend === 'down' ? ArrowDownRight : Minus;
  const trendChip =
    data.trend === 'up'
      ? 'bg-success-50 text-success-700 ring-success-100'
      : data.trend === 'down'
        ? 'bg-critical-50 text-critical-700 ring-critical-100'
        : 'bg-surface-100 text-surface-600 ring-surface-200';
  // The change is measured against the PREVIOUS ANALYSIS, which may be an hour or a month ago — the
  // chip used to say "this week", which was only ever true by coincidence. With a single analysis
  // on record there is nothing to compare, so no chip at all rather than a "no change" nobody
  // measured.
  const hasPrevious = trend.length >= 2;
  const measuredPillars = pillars.filter((pillar) => pillar.score !== null).length;

  return (
    // `h-full` fills the grid row shared with the trend chart, so the page ground never shows
    // through beside the shorter card.
    <section className={`${cardClass} relative flex h-full flex-col overflow-hidden`} aria-labelledby="overall-health-title">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tone.hex} 10%, transparent) 0%, transparent 60%)` }}
        aria-hidden="true"
      />

      {/* One row from lg up — dial, narrative, figures — so the card is only as tall as the dial.
          Below lg the figures drop under the narrative as a three-up row. */}
      <div className="relative flex flex-1 flex-col justify-center gap-3 p-3.5 lg:flex-row lg:items-center lg:gap-4">
        <div className="flex min-w-0 flex-1 flex-col items-center gap-3 sm:flex-row sm:gap-4">
          <ScoreGauge score={data.score} color={tone.hex} measured={data.measured} />

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-surface-500">Overall health</p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <h2 id="overall-health-title" className={`text-[22px] font-semibold leading-none tracking-[-0.02em] ${data.measured ? tone.text : 'text-surface-950'}`}>
                {data.statusLabel}
              </h2>
              {data.measured && hasPrevious && (
                <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums ring-1 ring-inset ${trendChip}`}>
                  <TrendIcon size={11} strokeWidth={2.5} aria-hidden="true" />
                  {data.trend === 'stable'
                    ? 'No change since last analysis'
                    : `${data.trend === 'up' ? '+' : '-'}${data.trendValue} pts since last analysis`}
                </span>
              )}
            </div>
            <p className="mx-auto mt-2 max-w-xl text-[12.5px] leading-[1.45] text-surface-600 sm:mx-0">{data.description}</p>

            {/* A score computed from part of the catalogue must say so next to the number,
                not only inside a sub-pillar summary the merchant may never open. */}
            {data.coverageNote && (
              <div className="mt-2 text-left">
                <Banner tone="warning" heading="Partial scan"><s-text>{data.coverageNote}</s-text></Banner>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-surface-500 sm:justify-start">
              {/* One dot per pillar in its own colour; a hollow ring for a pillar with no result. */}
              <span className="flex items-center gap-1" aria-hidden="true">
                {pillars.map((pillar) => {
                  const meta = pillarMeta[pillar.key];
                  const measured = pillar.score !== null;
                  return (
                    <span
                      key={pillar.key}
                      title={`${pillar.label}: ${measured ? `${pillar.score}/100` : 'not analyzed yet'}`}
                      className={`h-2 w-2 rounded-full ${measured ? '' : 'ring-1 ring-inset ring-surface-300'}`}
                      style={measured ? { backgroundColor: meta?.color } : undefined}
                    />
                  );
                })}
              </span>
              <span>
                {data.measured
                  ? `Scored across ${measuredPillars} of ${pillars.length} pillars`
                  : 'No audit yet'}
              </span>
            </div>
          </div>
        </div>

        <div className="lg:w-[228px] lg:flex-shrink-0">
          <MetricSummary metrics={metrics} onSelect={onSelectMetric} />
        </div>
      </div>
    </section>
  );
}
