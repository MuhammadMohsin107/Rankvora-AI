import { AlertOctagon, CheckCircle2, FileSearch, ListChecks, type LucideIcon } from 'lucide-react';
import type { SubPillarTotals } from '../../../data/seo/subpillar.model';
import { card, eyebrow, scoreHex, statusFromScore, toneStyles } from './tone';

interface Props {
  totals: SubPillarTotals;
  summary: string;
  healthChip: string;
}

function ScoreDial({ score }: { score: number }) {
  // 84px, down from 148. The dial is the page's primary metric and stays the largest thing in the
  // card, but its diameter sets the height of the entire hero row — so every pixel of it costs a
  // pixel of the evidence table below, which is what the page is actually for.
  const size = 84;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Score ${score} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-surface-100" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={scoreHex(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="score-ring"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[26px] font-semibold leading-none tracking-[-0.04em] text-surface-950 tabular-nums">{score}</span>
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-surface-400">/ 100</span>
      </div>
    </div>
  );
}

// Hairline placement per cell: on mobile the grid is 2x2 (so cells 2 and
// 3 need a top rule), from sm up it is a single row of 4.
const cellBorder = ['', 'border-l', 'border-t sm:border-t-0 sm:border-l', 'border-l border-t sm:border-t-0'];

/**
 * The chip's colour follows the score it sits beside.
 *
 * It was always the healthy style — green, with a check mark — so "12% healthy" and "Unavailable"
 * rendered exactly like good news. The chip's words come from the check; its colour must not
 * contradict them.
 */
function chipTone(status: ReturnType<typeof statusFromScore>): 'healthy' | 'high' | 'critical' {
  if (status === 'Excellent' || status === 'Good') return 'healthy';
  if (status === 'Needs Work') return 'high';
  return 'critical';
}

/** Hero: the score, what it means, and the four numbers behind it. */
export default function ScoreCard({ totals, summary, healthChip }: Props) {
  const status = statusFromScore(totals.score);
  const tone = chipTone(status);

  const metrics: { label: string; value: number; icon: LucideIcon; tile: string }[] = [
    { label: totals.analyzedLabel, value: totals.analyzed, icon: FileSearch, tile: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-900/10' },
    { label: totals.healthyLabel, value: totals.healthy, icon: CheckCircle2, tile: toneStyles.healthy.tile },
    { label: totals.issuesLabel, value: totals.issues, icon: ListChecks, tile: 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-900/10' },
    { label: totals.criticalLabel, value: totals.critical, icon: AlertOctagon, tile: toneStyles.critical.tile },
  ];

  return (
    <section className={`${card} overflow-hidden`} aria-labelledby="sp-score-title">
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:gap-3.5">
        <ScoreDial score={totals.score} />

        <div className="min-w-0">
          {/* "HEALTH" sits beside the verdict rather than above it — the label and the word it
              labels belong on one line, and stacking them cost a row for four characters. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className={eyebrow}>Health</p>
            <h2 id="sp-score-title" className="text-[16px] font-semibold leading-none tracking-[-0.02em] text-surface-950">
              {status}
            </h2>
            {healthChip && (
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${toneStyles[tone].badge}`}>
                {tone === 'healthy' && <CheckCircle2 size={10} strokeWidth={2.4} aria-hidden="true" />}
                {healthChip}
              </span>
            )}
          </div>
          <p className="mt-1 max-w-lg text-[12px] leading-[1.45] text-surface-600">{summary}</p>
          {/* Only when the check reported something for it. An empty label drew a bordered box
              with nothing inside. */}
          {(totals.contextLabel || totals.contextValue) && (
            <p className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-surface-200 px-1.5 py-0.5 text-[10.5px] text-surface-500">
              {totals.contextLabel}
              <span className="font-semibold tabular-nums text-surface-800">{totals.contextValue}</span>
            </p>
          )}
        </div>
      </div>

      {/* Hairline metric strip — 2 columns on mobile, 4 from sm up. */}
      <div className="grid grid-cols-2 border-t border-surface-200 sm:grid-cols-4">
        {metrics.map((metric, index) => (
          <div key={metric.label} className={`border-surface-200 px-3 py-2 ${cellBorder[index]}`}>
            <div className="flex items-center gap-1.5">
              <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded ${metric.tile}`}>
                <metric.icon size={10} strokeWidth={2.4} aria-hidden="true" />
              </span>
              <p className="truncate text-[10px] font-medium uppercase tracking-[0.06em] text-surface-500">{metric.label}</p>
            </div>
            <p className="mt-1 text-[17px] font-semibold leading-none tracking-[-0.03em] text-surface-950 tabular-nums">
              {metric.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
