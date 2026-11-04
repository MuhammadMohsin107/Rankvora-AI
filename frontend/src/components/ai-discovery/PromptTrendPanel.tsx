import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, MessageSquare } from 'lucide-react';
import { fetchPromptHistory, type PromptHistory } from '../../data/aiDiscovery.repository';
import { ApiError } from '../../lib/api';
import { cardClass } from '../dashboard/scoreTone';
import { Button, MetricTile, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── Prompt tracking over time ───────────────────────────────────────
 *
 * The prompt-tracking sub-pillar answers "how visible is this store in assistant answers now".
 * This answers "is it getting better", which is what a merchant asks the moment after.
 *
 * ─── THREE RULES INHERITED FROM THE CHECK, AND VISIBLE ON SCREEN ─────
 *   1. A RATE, NEVER A RANK. Every point is mentions ÷ samples. No position appears anywhere,
 *      because no position was ever observed.
 *   2. A BUCKET BELOW THE SAMPLE FLOOR IS DRAWN UNSETTLED — hollow, not filled. An LLM is
 *      non-deterministic; two samples swinging between 0% and 50% is noise, and drawing it like a
 *      settled measurement manufactures a trend out of a coin flip.
 *   3. A DAY WITH NO SWEEP IS A GAP, NOT A ZERO. The API omits those buckets entirely and this
 *      chart plots only what came back, so the line never dives to the floor on a day nobody asked
 *      anything.
 *
 * Follows the inline-SVG idiom of dashboard/ScoreTrend so the pillar charts read as one system.
 */

const DEFAULT_DAYS = 90;

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the Rankvora AI API. Check that the backend is running.';
  if (error.status === 404 && error.code !== 'STORE_NOT_FOUND') {
    return 'This server has no prompt-history endpoint. The API is running an older build — redeploy and restart it.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again, then reopen this page.';
  return error.message;
}

/** The series as a line. Rendered only with two or more buckets — one point is not a trend. */
function TrendChart({ history }: { history: PromptHistory }) {
  const { series } = history;
  const width = 560;
  const height = 150;
  const pad = { top: 12, right: 14, bottom: 22, left: 34 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;

  // Y is always 0–100%: a rate has fixed bounds, and auto-scaling it would make a move from 2% to
  // 4% look like a doubling of the whole chart.
  const xFor = (index: number) => pad.left + (series.length === 1 ? cw / 2 : (index / (series.length - 1)) * cw);
  const yFor = (rate: number) => pad.top + ch - rate * ch;

  const points = series.map((bucket, index) => ({ ...bucket, x: xFor(index), y: yFor(bucket.rate) }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const gridValues = [0, 0.5, 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Mention rate across ${history.totalSamples} recorded assistant answers, from ${formatDate(series[0]!.date)} to ${formatDate(series[series.length - 1]!.date)}`}
    >
      {gridValues.map((value) => (
        <g key={value}>
          <line x1={pad.left} x2={width - pad.right} y1={yFor(value)} y2={yFor(value)} className="stroke-chart-grid" />
          <text x={pad.left - 7} y={yFor(value) + 3.5} textAnchor="end" fontSize="10" className="fill-chart-axis tabular-nums">
            {Math.round(value * 100)}%
          </text>
        </g>
      ))}

      {series.length > 1 && (
        <path d={line} fill="none" strokeWidth="2" className="stroke-chart-line" strokeLinecap="round" strokeLinejoin="round" />
      )}

      {points.map((point) => (
        <circle
          key={point.date}
          cx={point.x}
          cy={point.y}
          r={3.5}
          strokeWidth="2"
          // Hollow = provisional. Rule 2 in the header: too few samples to be a settled value.
          className={`stroke-chart-line ${point.provisional ? 'fill-surface-0' : 'fill-chart-line'}`}
        >
          <title>
            {`${formatDate(point.date)}: mentioned in ${point.mentions} of ${point.samples} answers${point.provisional ? ` — under ${history.minSamples} samples, not yet settled` : ''}`}
          </title>
        </circle>
      ))}

      <text x={pad.left} y={height - 6} fontSize="10" className="fill-chart-axis">{formatDate(series[0]!.date)}</text>
      {series.length > 1 && (
        <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="10" className="fill-chart-axis">
          {formatDate(series[series.length - 1]!.date)}
        </text>
      )}
    </svg>
  );
}

/**
 * WHY the trend is empty, rather than one sentence covering three different situations.
 *
 * `totalSamples === 0` is reached by at least three routes and they have nothing in common:
 *
 *   · the deployment has no AI provider, so no question CAN be asked — an operator's problem,
 *     and the Check all now button is disabled, so the old advice pointed at a dead control
 *   · the merchant has tracked no questions — the only case the old sentence actually described
 *   · questions exist and no sweep has run yet, where "add the questions" reads as an instruction
 *     to repeat work already done
 *
 * A fourth, easy to hit and invisible before: every tracked question is paused.
 *
 * Nothing here is inferred. Each branch reads a fact the API returned — see PromptHistory's
 * `aiConfigured` and `queries` — and when none of them explains it, the last branch says so
 * instead of guessing at a fifth reason.
 */
function EmptyReason({ history }: { history: PromptHistory }) {
  const line = 'text-[12.5px] leading-[1.5] text-surface-600';
  // A path segment, not a query string: Settings reads `section` with useParams.
  const settings = <a href="/settings/ai-discovery" className="font-medium text-brand-600 hover:text-brand-700">Settings → AI Discovery</a>;

  if (!history.aiConfigured) {
    return (
      <p className={line}>
        No AI provider is configured on this Rankvora AI deployment, so no question can be asked and no answer
        can be recorded. This is a server setting, not something you can change here — an operator needs to
        set <code className="font-mono text-[11.5px] text-surface-800">AI_PROVIDER</code> and the matching API key.
        Until then the audit reports prompt tracking as not measured rather than showing a zero.
      </p>
    );
  }

  if (history.queries.length === 0) {
    return (
      <p className={line}>
        No questions are being tracked yet, so there is nothing to ask. Add the questions your shoppers
        actually type under {settings}, then run a sweep — the first real answers appear here.
      </p>
    );
  }

  if (history.queries.every((query) => !query.active)) {
    return (
      <p className={line}>
        All {history.queries.length} tracked {history.queries.length === 1 ? 'question is' : 'questions are'} paused,
        so no sweep asks anything. Re-activate at least one under {settings}.
      </p>
    );
  }

  return (
    <p className={line}>
      {history.queries.length} {history.queries.length === 1 ? 'question is' : 'questions are'} tracked and ready,
      but no sweep has recorded an answer in the last {history.days} days. Press Check all now under {settings} — or
      run an audit, which takes one sample per question automatically.
    </p>
  );
}

export default function PromptTrendPanel() {
  const [history, setHistory] = useState<PromptHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await fetchPromptHistory(DEFAULT_DAYS));
    } catch (caught) {
      setHistory(null);
      setError(describeFailure(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className={cardClass} aria-labelledby="prompt-trend-title">
      <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-surface-100 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-surface-500">Trend</p>
          <h2 id="prompt-trend-title" className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-surface-950">
            <MessageSquare size={15} className="text-brand-500" />
            Assistant mentions over time
          </h2>
          <p className="mt-1 text-[12px] leading-[1.45] text-surface-500">
            How often assistants named this store, across every answer really recorded.
          </p>
        </div>
        {history && history.totalSamples > 0 && (
          <StatusBadge label={`Last ${history.days} days`} tone="neutral" />
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-surface-500">
          <Loader2 size={14} className="animate-spin" />
          Reading recorded answers…
        </div>
      )}

      {!loading && error && (
        <div className="px-3 py-3.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-warning-600" />
            <div>
              <p className="text-[12.5px] leading-[1.5] text-surface-700">{error}</p>
              <div className="mt-2.5"><Button variant="secondary" onClick={() => void load()}>Retry</Button></div>
            </div>
          </div>
        </div>
      )}

      {/* Never checked is not zero. A store that has run no sweep gets this, not a flat line. */}
      {!loading && !error && history && history.totalSamples === 0 && (
        <div className="px-3 py-3.5">
          <EmptyReason history={history} />
        </div>
      )}

      {!loading && !error && history && history.totalSamples > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2.5 px-3 py-2.5 lg:grid-cols-3">
            <MetricTile
              label="Mention rate"
              value={history.overallRate === null ? '—' : formatPercent(history.overallRate)}
              detail={`${history.totalMentions} of ${history.totalSamples} answers`}
              // The check's own bands, sent by the API — at or below the critical rate is critical,
              // exactly as the audit grades it. These were retyped here as 0.4 and 0.1, and graded
              // a rate of exactly 10% differently from the check.
              tone={
                history.overallRate === null
                  ? 'neutral'
                  : history.overallRate >= history.healthyRate
                    ? 'success'
                    : history.overallRate > history.criticalRate
                      ? 'warning'
                      : 'critical'
              }
            />
            <MetricTile label="Answers recorded" value={history.totalSamples.toLocaleString()} detail={`over ${history.days} days`} />
            <MetricTile label="Questions tracked" value={String(history.queries.length)} detail={`${history.queries.filter((query) => query.active).length} active`} />
          </div>

          {history.series.length > 0 && (
            <div className="border-t border-surface-100 px-3 py-2.5">
              <TrendChart history={history} />
            </div>
          )}

          <div className="border-t border-surface-100 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-surface-100 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                  <th className="px-3 py-1.5">Question</th>
                  <th className="px-3 py-1.5 text-right">Mentioned</th>
                  <th className="px-3 py-1.5 text-right">Rate</th>
                  <th className="px-3 py-1.5 text-right">Last checked</th>
                </tr>
              </thead>
              <tbody>
                {history.queries.map((query) => (
                  <tr key={query.queryId} className="border-b border-surface-50 last:border-0">
                    <td className="px-3 py-1.5">
                      <span className="text-[12.5px] text-surface-900">{query.query}</span>
                      {!query.active && <span className="ml-1.5 text-[11px] text-surface-400">paused</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-600">
                      {query.mentions} / {query.samples}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums">
                      {/* Never checked → em dash. Too few samples → the rate with a caveat, never a
                          bare number that would be read as settled. */}
                      {query.rate === null ? (
                        <span className="text-surface-400">not checked yet</span>
                      ) : query.provisional ? (
                        <span className="text-surface-500">{formatPercent(query.rate)} <span className="text-[10.5px]">(gathering)</span></span>
                      ) : (
                        <span className="text-surface-800">{formatPercent(query.rate)}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[11.5px] tabular-nums text-surface-500">
                      {query.lastCheckedAt ? new Date(query.lastCheckedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Standing against the merchant's own competitor list ──
              Rendered only when answers actually carried a comparison set. Without one there is no
              standing: "first of one" is the absence of a comparison, not a win. */}
          {history.ranking.configured ? (
            <div className="border-t border-surface-100">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pt-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                  Standing against your competitors
                </p>
                <p className="text-[11px] tabular-nums text-surface-500">
                  across {history.ranking.rankedAnswers.toLocaleString()} answers
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5 px-3 py-2 lg:grid-cols-4">
                <MetricTile
                  label="Average placement"
                  value={
                    // Both figures come from the same answers — the ones that named the store — so
                    // the rank can never exceed its denominator. No `?? 0`: a missing denominator
                    // is not zero brands.
                    history.ranking.averageRank === null || history.ranking.averageBrandsNamed === null
                      ? 'Never named'
                      : `${history.ranking.averageRank.toFixed(1)} of ${history.ranking.averageBrandsNamed.toFixed(1)}`
                  }
                  detail="in answers that named you"
                  // No good/bad colour for the number itself: "2nd" was graded green by a cut-off
                  // nobody measured. Never being named is the one state that is plainly bad.
                  tone={history.ranking.averageRank === null ? 'critical' : 'neutral'}
                />
                <MetricTile label="Named first" value={history.ranking.timesFirst.toLocaleString()} detail="answers led with you" tone={history.ranking.timesFirst > 0 ? 'success' : 'neutral'} />
                <MetricTile
                  label="How early you appear"
                  value={history.ranking.averagePosition === null ? '—' : `${Math.round(history.ranking.averagePosition * 100)}% in`}
                  detail="assistants lead with their pick"
                />
                <MetricTile
                  label="Answers you lost"
                  value={history.ranking.answersLostEntirely.toLocaleString()}
                  detail="a rival named, you weren’t"
                  tone={history.ranking.answersLostEntirely > 0 ? 'critical' : 'neutral'}
                />
              </div>

              {history.ranking.competitors.length > 0 ? (
                <div className="overflow-x-auto border-t border-surface-100">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-surface-100 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-surface-500">
                        <th className="px-3 py-1.5">Competitor</th>
                        <th className="px-3 py-1.5 text-right">Named in</th>
                        <th className="px-3 py-1.5 text-right">Ahead of you</th>
                        <th className="px-3 py-1.5 text-right">Named, you weren’t</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.ranking.competitors.map((competitor) => (
                        <tr key={competitor.term} className="border-b border-surface-50 last:border-0">
                          <td className="px-3 py-1.5 text-[12.5px] text-surface-900">{competitor.term}</td>
                          <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-800">
                            {competitor.named} of {history.ranking.rankedAnswers}
                          </td>
                          <td className="px-3 py-1.5 text-right text-[12.5px] tabular-nums text-surface-600">{competitor.aheadOfUs}</td>
                          <td className={`px-3 py-1.5 text-right text-[12.5px] tabular-nums ${competitor.namedWithoutUs > 0 ? 'text-critical-700' : 'text-surface-600'}`}>
                            {competitor.namedWithoutUs}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                // A real result: the comparison set existed and none of them were named.
                <p className="border-t border-surface-100 px-3 py-2.5 text-[12px] leading-[1.5] text-surface-600">
                  None of your listed competitors were named in any recorded answer either. The assistants
                  recommended other things entirely — or nothing specific.
                </p>
              )}
            </div>
          ) : (
            <p className="border-t border-surface-100 px-3 py-2.5 text-[12px] leading-[1.5] text-surface-600">
              No competitors are set up, so there is nothing to rank against — being the only brand Rankvora AI
              looks for is not a placement. Add competitor domains in onboarding, then run a sweep, and this
              will show where you appear among them.
            </p>
          )}

          <p className="border-t border-surface-100 px-3 py-1.5 text-[11px] leading-[1.5] text-surface-500">
            A rate and a placement, never a ranking in ChatGPT — an assistant’s answer is non-deterministic, so only
            the distribution across several real samples means anything. Points below {history.minSamples} samples are
            drawn hollow and marked “gathering”. Days with no sweep are gaps, not zeroes. Competitors are matched only
            against the domains you entered; Rankvora AI never infers a brand from an answer.
          </p>
        </>
      )}
    </section>
  );
}
