import { useEffect, useMemo, useRef, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, ArrowUpRight, CheckCircle2, RefreshCw } from 'lucide-react';
import type { OverallScore, PriorityIssue, Severity } from '../../data/dashboard/dashboard.types';
import { catalogKindOfMove } from '../../data/catalog.repository';
import { CATALOG_KINDS, type CatalogKind } from '../../data/catalogKinds';
import { SCORE_TARGET, countBySeverity, severityOrder, severityTone, statusTone } from '../dashboard/scoreTone';

interface Props {
  /** The list this panel sits beside: a move about this kind filters that list; any other opens its page. */
  kind: CatalogKind;
  state: 'loading' | 'ready' | 'error';
  issues: PriorityIssue[];
  score: OverallScore | null;
  /** The move the list is filtered to, if any. */
  active: { route: string; title: string } | null;
  onSelect: (move: PriorityIssue) => void;
  onRetry: () => void;
}

type Filter = 'all' | Severity;

/** "All 12 products" · "11 of 12 products" · "39 pages" — what the finding counted, as it counted it. */
function countLine(issue: PriorityIssue): string | null {
  if (issue.affectedCount <= 0) return null;
  const label = issue.affectedLabel || 'items';
  if (issue.population && issue.population > 0) {
    return issue.affectedCount >= issue.population
      ? `All ${issue.population.toLocaleString()} ${label}`
      : `${issue.affectedCount.toLocaleString()} of ${issue.population.toLocaleString()} ${label}`;
  }
  return `${issue.affectedCount.toLocaleString()} ${label}`;
}

/**
 * Winning moves beside a catalog list (products, collections or blog articles), as a store-health
 * app keeps them: how many moves there are, the score they work towards, a severity filter, and the
 * moves themselves.
 *
 * A move about this list's kind filters the list beside it to the items it names; any other move
 * opens the page where it is fixed. No "+N pts" — no finding stores a number of overall points.
 */
export default function MovesPanel({ kind, state, issues, score, active, onSelect, onRetry }: Props) {
  const nouns = CATALOG_KINDS[kind].nouns;
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Once per chosen move (and once the moves have loaded), not on every render — typing in the
  // search must not pull the panel back.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active?.route, active?.title, state]);

  const counts = useMemo(() => countBySeverity(issues), [issues]);
  const visible = useMemo(() => {
    const sorted = [...issues].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));
    return filter === 'all' ? sorted : sorted.filter((issue) => issue.severity === filter);
  }, [issues, filter]);

  const tone = score ? statusTone[score.status] : null;
  const chips: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: issues.length },
    ...severityOrder.filter((severity) => counts[severity] > 0).map((severity) => ({ key: severity as Filter, label: severityTone[severity].label, count: counts[severity] })),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tab row, like the side panel of a store-health app. */}
      <div className="flex items-center gap-2 border-b border-surface-200/70 px-3.5">
        <span className="-mb-px inline-flex items-center gap-1.5 border-b-2 border-surface-900 py-2.5 text-[13px] font-semibold text-surface-950">
          Winning moves
          <span className="rounded-full bg-surface-900 px-1.5 text-[10.5px] font-semibold tabular-nums text-surface-0">{issues.length}</span>
        </span>
      </div>

      {state === 'loading' ? (
        <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading winning moves">
          <div className="skeleton h-4 w-32" />
          <div className="skeleton h-2 w-full rounded-full" />
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-16 w-full rounded-lg" />)}
        </div>
      ) : state === 'error' ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-critical-50 text-critical-600"><AlertCircle size={16} /></span>
          <p className="text-[12.5px] font-semibold text-surface-900">Winning moves could not be loaded</p>
          <button type="button" onClick={onRetry} className="btn-primary btn-xs"><RefreshCw size={12} />Retry</button>
        </div>
      ) : (
        <>
          <div className="border-b border-surface-200/70 px-3.5 py-3">
            <p className="text-[14px] font-semibold text-surface-950">
              {issues.length.toLocaleString()} {issues.length === 1 ? 'move' : 'moves'} to make
            </p>
            {score && tone && (
              <>
                <p className="mt-1.5 flex items-baseline justify-between text-[12px] text-surface-600">
                  <span>Store health score</span>
                  <span className="font-semibold tabular-nums text-surface-950">{score.measured ? `${score.score}/100` : 'Not measured'}</span>
                </p>
                <div className="relative mt-1.5 h-2 w-full rounded-full bg-surface-200/70" aria-hidden="true">
                  {score.measured && <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, score.score))}%` }} />}
                  <span className="absolute -top-[3px] h-3.5 w-0.5 rounded-full bg-surface-900" style={{ left: `calc(${SCORE_TARGET}% - 1px)` }} />
                </div>
                {score.measured && (
                  <p className="mt-1.5 text-[11.5px] font-medium tabular-nums text-success-700">
                    {score.score >= SCORE_TARGET ? 'On target — keep it there' : `${SCORE_TARGET - score.score} pts to the ${SCORE_TARGET} target`}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="border-b border-surface-200/70 px-3 py-2">
            <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-surface-200/70 bg-surface-50 p-0.5" role="tablist" aria-label="Filter moves by severity">
              {chips.map((chip) => {
                const selected = filter === chip.key;
                return (
                  <button
                    key={chip.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setFilter(chip.key)}
                    className={`rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-all ${
                      selected ? 'bg-surface-0 font-semibold text-surface-950 shadow-[0_1px_2px_var(--c-shadow-md)] ring-1 ring-surface-200' : 'text-surface-600 hover:text-surface-900'
                    }`}
                  >
                    {chip.label}{chip.key !== 'all' && <span className="ml-1 tabular-nums text-surface-400">({chip.count})</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div ref={scrollChaining} className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--c-surface-300)_transparent] [scrollbar-width:thin]">
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <CheckCircle2 size={20} className="text-success-600" aria-hidden="true" />
                <p className="text-[12.5px] font-semibold text-surface-900">No open moves</p>
                <p className="text-[11.5px] text-surface-500">The latest analysis left nothing outstanding here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-surface-200/60">
                {visible.map((issue) => {
                  const listMove = catalogKindOfMove(issue) === kind;
                  const selected = Boolean(active && active.route === issue.route && active.title === issue.title);
                  const sev = severityTone[issue.severity];
                  const line = countLine(issue);
                  return (
                    <li key={issue.id}>
                      <button
                        type="button"
                        // The move the list was opened for ("View 12 products" on the dashboard) is
                        // scrolled into view, so the panel shows which one is applied.
                        ref={selected ? activeRef : undefined}
                        onClick={() => (listMove ? onSelect(issue) : navigate(issue.route))}
                        aria-pressed={listMove ? selected : undefined}
                        className={`block w-full px-3.5 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                          selected ? 'bg-brand-50/60 ring-2 ring-inset ring-brand-500' : 'hover:bg-surface-50'
                        }`}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="text-[13px] font-semibold leading-snug text-surface-950">{issue.title}</span>
                          <span className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-px text-[10.5px] font-semibold ${sev.chip}`}>{sev.label}</span>
                        </span>
                        {line && <span className="mt-0.5 block text-[11.5px] tabular-nums text-surface-600">{line}</span>}
                        {issue.description && (
                          <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-[1.45] text-surface-500">{issue.description}</span>
                        )}
                        <span className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-brand-700">
                          {listMove ? (selected ? `Showing these ${nouns}` : `Show these ${nouns}`) : `Open ${issue.areaLabel ?? issue.pillarLabel}`}
                          {listMove ? <ArrowRight size={11} aria-hidden="true" /> : <ArrowUpRight size={11} aria-hidden="true" />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

        </>
      )}
    </div>
  );
}
