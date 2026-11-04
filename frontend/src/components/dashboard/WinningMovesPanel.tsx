import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Trophy, X } from 'lucide-react';
import type { DashboardData } from '../../data/dashboard/dashboard.types';
import { fetchDashboardData } from '../../data/dashboard/dashboard.repository';
import PriorityIssues from './PriorityIssues';
import { SCORE_TARGET, statusTone } from './scoreTone';
import Button from '../../components/polaris/Button';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * "Winning moves" as a side panel, opened from the Products page — the way a store-health app keeps
 * its ranked fixes one click away while the merchant works through the product list.
 *
 * It is the dashboard's own list: the same request (GET only), the same issues, the same order and
 * the same severity filter. It loads the first time the panel opens, not with the product list.
 */
export default function WinningMovesPanel({ open, onClose }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setData(await fetchDashboardData());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (open && state === 'idle') void load();
  }, [open, state, load]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const score = data?.overallScore;
  const tone = score ? statusTone[score.status] : null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="winning-moves-panel-title">
      <button type="button" className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px] motion-safe:animate-fade-in" onClick={onClose} aria-label="Close winning moves" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col border-l border-surface-200 bg-surface-50 shadow-2xl">
        <div className="flex items-start justify-between gap-2 border-b border-surface-200 bg-surface-0 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-success-50 text-success-700 ring-1 ring-inset ring-success-100" aria-hidden="true">
              <Trophy size={15} />
            </span>
            <div className="min-w-0">
              <h2 id="winning-moves-panel-title" className="text-[15px] font-semibold leading-tight tracking-tight text-surface-950">Winning moves</h2>
              <p className="text-[11.5px] text-surface-500">
                {state === 'ready' && data
                  ? `${data.priorityIssues.length.toLocaleString()} ${data.priorityIssues.length === 1 ? 'move' : 'moves'} to make, most severe first`
                  : 'Every open fix from your latest analysis'}
              </p>
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="flex-shrink-0 rounded-md p-1.5 text-surface-400 transition hover:bg-surface-100 hover:text-surface-900" aria-label="Close winning moves">
            <X size={16} />
          </button>
        </div>

        {/* The score the moves are working towards, as a bar against the target. */}
        {state === 'ready' && score && tone && (
          <div className="border-b border-surface-200 bg-surface-0 px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-medium text-surface-600">Store health score</span>
              {score.measured ? (
                <span className="text-[13px] font-semibold tabular-nums text-surface-950">
                  {score.score}<span className="text-[11px] font-medium text-surface-400">/100</span>
                  <span className={`ml-1.5 text-[11px] font-semibold ${tone.text}`}>{score.statusLabel}</span>
                </span>
              ) : (
                <span className="text-[12px] font-semibold text-surface-500">Not measured</span>
              )}
            </div>
            <div className="relative mt-2 h-2 w-full rounded-full bg-surface-200/70" aria-hidden="true">
              {score.measured && <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, score.score))}%` }} />}
              <span className="absolute -top-[3px] h-3.5 w-0.5 rounded-full bg-surface-900" style={{ left: `calc(${SCORE_TARGET}% - 1px)` }} />
            </div>
            {score.measured && (
              <p className="mt-1.5 text-[11px] tabular-nums text-surface-500">
                {score.score >= SCORE_TARGET ? 'On target — keep it there as the catalog changes.' : `${SCORE_TARGET - score.score} pts to the Excellent target of ${SCORE_TARGET}.`}
              </p>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col p-3">
          {state === 'loading' || state === 'idle' ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading winning moves">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}
            </div>
          ) : state === 'error' || !data ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-critical-50 text-critical-600"><AlertCircle size={18} /></span>
              <p className="text-[12.5px] font-semibold text-surface-900">Winning moves could not be loaded</p>
              <p className="text-[11.5px] text-surface-500">Your results are unaffected.</p>
              <Button variant="primary" onClick={() => void load()} className="mt-1">Retry</Button>
            </div>
          ) : (
            <PriorityIssues issues={data.priorityIssues} heading="Most severe first" height="panel" />
          )}
        </div>
      </aside>
    </div>
  );
}
