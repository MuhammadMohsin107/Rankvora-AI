import { Check, Circle, Globe, Loader2, Radar } from 'lucide-react';
import { useAuditRun } from '../../data/useAuditRun';
import { stageStates } from '../../data/analysisStages';
import Button from '../../components/polaris/Button';

interface Props {
  /** The server's explanation when audits exist but describe a previously connected shop. */
  notice?: string | null;
}

/**
 * Shown when the store has no audits yet — a first-run state, not a failure. The backend is
 * the only authority on whether a run is possible, so this offers the run and leaves a refusal
 * (`STORE_NOT_CONNECTED`) to be explained, with its connect prompt, by the banner above every page
 * (components/audit/AnalysisBanner.tsx) rather than pre-guessing the answer.
 *
 * It runs through the same shared state as every Re-analyze button (data/useAuditRun.ts), so it
 * cannot start a second analysis beside one that is already running, and the dashboard loads the
 * first audit itself when it finishes.
 *
 * WHILE IT RUNS, IT SHOWS WHAT IS HAPPENING — the five stages a merchant can follow, lit by the
 * job's own progress, and the job's own sentence with the counts read so far. There is no score and
 * no placeholder figure: until the first analysis finishes there is genuinely nothing to score, and
 * "still collecting data" is the true thing to say.
 *
 * Nothing needs the merchant to wait here. The analysis runs in the background of the app; they may
 * leave this page and the banner above every page keeps showing it.
 */
export default function DashboardEmpty({ notice = null }: Props) {
  const { running, progress, stage, run } = useAuditRun();
  const stages = stageStates(progress);

  return (
    <div className="page-shell">
      <div className="card flex min-h-[280px] flex-col items-center justify-center border border-surface-200 p-6 text-center">
        <div className="mb-2.5 flex h-12 w-12 items-center justify-center rounded-lg bg-brand-50">
          {running ? (
            <Loader2 size={28} className="animate-spin text-brand-600 motion-reduce:animate-none" />
          ) : (
            <Radar size={28} className="text-brand-600" />
          )}
        </div>

        <h2 className="mb-2 text-[15px] font-semibold text-surface-900">
          {running ? 'Analyzing your store' : notice ? 'No analysis of this store yet' : 'Start your first analysis'}
        </h2>
        <p className="mb-2 max-w-md text-[12.5px] text-surface-500">
          {running
            ? 'Your scores are still being collected, so none are shown yet. You can leave this page — the analysis carries on.'
            : notice ?? 'Rankvora AI will read your store, check it across every area and show what to fix first. Nothing is changed in your store.'}
        </p>

        {running && (
          <div className="mb-2 w-full max-w-md text-left">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-100">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </div>

            <ol className="mt-3 space-y-1.5" aria-label="Analysis progress">
              {stages.map((entry) => (
                <li
                  key={entry.key}
                  aria-current={entry.state === 'active' ? 'step' : undefined}
                  className={`flex items-center gap-2 text-[12.5px] ${
                    entry.state === 'done' ? 'text-success-700' : entry.state === 'active' ? 'font-semibold text-surface-900' : 'text-surface-400'
                  }`}
                >
                  <span aria-hidden="true" className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    {entry.state === 'done' ? (
                      <Check size={14} strokeWidth={3} />
                    ) : entry.state === 'active' ? (
                      <Loader2 size={13} className="animate-spin text-brand-600 motion-reduce:animate-none" />
                    ) : (
                      <Circle size={10} />
                    )}
                  </span>
                  {entry.label}
                </li>
              ))}
            </ol>

            {/* The job's own sentence, with the real counts read so far. */}
            {stage && <p className="mt-2.5 text-[11.5px] text-surface-500">{stage}</p>}
            <p className="mt-1 text-[11.5px] tabular-nums text-surface-400">{progress}% complete</p>
          </div>
        )}

        {!running && (
          <Button variant="primary" onClick={() => void run()}>
            
            {notice ? 'Analyze this store' : 'Start first analysis'}
          </Button>
        )}

        <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-surface-400">
          <Globe size={12} />
          {/* Only a genuine first run has a baseline to speak of. With a notice, audits of a
              PREVIOUSLY connected shop exist, and calling this one "the first" would be untrue. */}
          {notice
            ? 'An analysis reads your store through its connected data source — nothing is changed.'
            : 'This first analysis becomes your baseline, so later changes can be measured against it.'}
        </p>
      </div>
    </div>
  );
}
