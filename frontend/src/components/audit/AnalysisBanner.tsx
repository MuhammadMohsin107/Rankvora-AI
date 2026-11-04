import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Loader2, PlugZap, X } from 'lucide-react';
import { dismissAuditRunError, useAuditCompletion, useAuditRun } from '../../data/useAuditRun';

/** How long the "analysis complete" confirmation stays up. Only the confirmation is timed. */
const COMPLETE_NOTICE_MS = 5000;

/**
 * The analysis banner: what Rankvora AI is doing right now, wherever the customer is in the app.
 *
 * It is driven by the audit job itself (data/useAuditRun.ts) and by nothing else. While a run is
 * going it shows the job's own progress and the step it is on, with the counts read so far; the
 * moment the run ends it is replaced by what happened — a confirmation that the results are up to
 * date, or the reason the run failed. Nothing here is a timer standing in for progress: the only
 * timer is the one that takes the confirmation away again.
 *
 * It sits in the app shell, above the page, so it is the same on every page and survives moving
 * between them — the run goes on server-side whichever page is open.
 */
export default function AnalysisBanner() {
  const { running, progress, stage, error, run } = useAuditRun();
  const [showComplete, setShowComplete] = useState(false);
  const { pathname } = useLocation();

  // A run that finished: confirm it, briefly. Cleared at once when the next run begins.
  useAuditCompletion(() => setShowComplete(true));
  useEffect(() => {
    if (!showComplete) return undefined;
    const timer = window.setTimeout(() => setShowComplete(false), COMPLETE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [showComplete]);
  useEffect(() => { if (running) setShowComplete(false); }, [running]);

  // A failure belongs to the page it happened on; moving to another page puts it away.
  useEffect(() => { dismissAuditRunError(); }, [pathname]);

  if (running) {
    return (
      <div role="status" aria-live="polite" aria-label="Analysis in progress" className="flex-shrink-0 border-b border-brand-100 bg-brand-50">
        <div className="flex items-center gap-2.5 px-4 py-2 md:px-6">
          <Loader2 size={16} className="flex-shrink-0 animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-semibold text-brand-800">Analysis in progress — Rankvora AI is analyzing your store</p>
            {/* The job's own account of what it is reading, with real counts. Before the first step
                reports there is nothing more to say than that it is starting. */}
            <p className="truncate text-[11.5px] text-brand-700">
              {stage ?? 'Starting the analysis'}
              <span className="hidden text-surface-500 sm:inline"> · You can keep using Rankvora AI. Results update when it finishes.</span>
            </p>
          </div>
          <span className="flex-shrink-0 text-[13px] font-semibold tabular-nums text-brand-700">{progress}%</span>
        </div>
        <div className="h-[3px] bg-brand-100" aria-hidden="true">
          {/* The bar is the job's progress and nothing else; before it has reported any, it is a
              pulse saying "working", not a length claiming how far along it is. */}
          {progress > 0
            ? <div className="h-full bg-brand-500 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
            : <div className="h-full w-full animate-pulse bg-brand-300/60 motion-reduce:animate-none" />}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex-shrink-0 border-b border-critical-100 bg-critical-50">
        <div className="flex items-center gap-2.5 px-4 py-2 md:px-6">
          <AlertCircle size={16} className="flex-shrink-0 text-critical-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-critical-700">The analysis did not finish</p>
            <p className="text-[11.5px] leading-[1.45] text-critical-700">{error.message} Your previous results are unchanged.</p>
          </div>
          {error.needsConnection ? (
            <Link to="/integrations" className="btn-primary btn-xs flex-shrink-0"><PlugZap size={12} aria-hidden="true" />Connect your store</Link>
          ) : (
            // The same real analysis the Re-analyze buttons start; nothing is retried on its own.
            <button type="button" onClick={() => void run()} className="btn-primary btn-xs flex-shrink-0">Try again</button>
          )}
          <button type="button" onClick={dismissAuditRunError} aria-label="Dismiss" className="flex-shrink-0 rounded p-1 text-critical-600 transition-colors hover:bg-critical-100">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (showComplete) {
    return (
      <div role="status" aria-live="polite" className="flex-shrink-0 border-b border-success-100 bg-success-50">
        <div className="flex items-center gap-2.5 px-4 py-2 md:px-6">
          <CheckCircle2 size={16} className="flex-shrink-0 text-success-600" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-[12.5px] font-semibold text-success-700">Analysis complete — your results are up to date.</p>
          <button type="button" onClick={() => setShowComplete(false)} aria-label="Dismiss" className="flex-shrink-0 rounded p-1 text-success-600 transition-colors hover:bg-success-100">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
