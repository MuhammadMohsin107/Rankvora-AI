import { Loader2, Radar } from 'lucide-react';
import { useAuditCompletion, useAuditRun } from '../../data/useAuditRun';

interface Props {
  /**
   * Called when an analysis finishes successfully, for a host page that has no loader of its own
   * listening (data/useAuditRun.ts, useAuditCompletion). A page that already reloads itself when
   * an analysis ends needs none.
   */
  onComplete?: () => void;
  label?: string;
}

/**
 * Starts a REAL audit run, through the same shared state every Re-analyze button uses
 * (data/useAuditRun.ts). It exists so a sub-pillar page can offer "Run an audit" that actually
 * runs one.
 *
 * Previously these pages rendered `<Link to="/">Run an audit</Link>` — a button that only
 * navigated to the dashboard while claiming to run an audit. Replacing the link with a button
 * alone would have been worse (a dead control), which is why this is wired to the job API.
 *
 * Whether an analysis is running, how far it is and why one failed are shown by the banner above
 * every page (components/audit/AnalysisBanner.tsx), so this is only the button: it is disabled
 * while any analysis is running, and after a failure it is the way to try again. Duplicate runs are
 * refused before they reach the server, and by the server if one slips past (another tab).
 */
export default function RunAuditButton({ onComplete, label = 'Run an audit' }: Props) {
  const { running, progress, run } = useAuditRun();
  // Whichever page or control started the analysis, the host page loads its results when it ends.
  useAuditCompletion(() => onComplete?.());

  return (
    <div className="mt-6 flex flex-col items-center gap-1.5">
      <button onClick={() => void run()} disabled={running} className="btn-primary disabled:opacity-70">
        {running ? (
          <>
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
            Analyzing your store… {progress}%
          </>
        ) : (
          <>
            <Radar size={15} />
            {label}
          </>
        )}
      </button>
    </div>
  );
}
