import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
 *
 * Drawn with Polaris web components (<s-banner>, <s-progress>, <s-button>), so it looks like the rest of
 * the Shopify admin around it and follows the admin's theme.
 */

/**
 * A Polaris banner the merchant can close.
 *
 * The banner announces its close button with a `dismiss` event. It is listened for by hand rather than
 * through a React `onDismiss` prop: React 19 hands custom elements any `on…` prop as the event of the
 * same name, capital letter and all, so `onDismiss` would wait for an event called "Dismiss" that never
 * comes. The callback is read through a ref so a new function each render never re-attaches the listener.
 */
function DismissibleBanner({ onDismiss, children, ...props }: ComponentProps<'s-banner'> & { onDismiss: () => void }) {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const handle = () => latest.current();
    element.addEventListener('dismiss', handle);
    return () => element.removeEventListener('dismiss', handle);
  }, []);
  return <s-banner ref={ref} dismissible {...props}>{children}</s-banner>;
}

export default function AnalysisBanner() {
  const { running, progress, stage, error, run } = useAuditRun();
  const navigate = useNavigate();
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

  // Each state is its own banner (`key`), never the same element re-labelled: a banner the merchant
  // closed hides itself, and a reused element would stay hidden when the next analysis began.
  if (running) {
    return (
      <div role="status" aria-live="polite" aria-label="Analysis in progress" className="px-4 pt-3 md:px-6">
        <s-banner key="running" tone="info" heading="Analysis in progress">
          <s-stack gap="small-300">
            {/* The job's own account of what it is reading, with real counts. Before the first step
                reports there is nothing more to say than that it is starting. */}
            <s-text>
              {stage ?? 'Starting the analysis'}
              {progress > 0 ? ` (${progress}%)` : ''}
            </s-text>
            {/* The bar is the job's progress and nothing else: it appears once the job has reported some. */}
            {progress > 0 && <s-progress value={progress} max={100} accessibilityLabel="Analysis progress" />}
          </s-stack>
        </s-banner>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="px-4 pt-3 md:px-6">
        <DismissibleBanner key="error" tone="critical" heading="The analysis did not finish" onDismiss={dismissAuditRunError}>
          {/* The server's message is a sentence with or without its full stop; this one line holds both. */}
          <s-text>{/[.!?…]$/.test(error.message.trim()) ? error.message.trim() : `${error.message.trim()}.`} Your previous results are unchanged.</s-text>
          {error.needsConnection ? (
            <s-button slot="secondary-actions" onClick={() => navigate('/integrations')}>Connect your store</s-button>
          ) : (
            // The same real analysis the Re-analyze buttons start; nothing is retried on its own.
            <s-button slot="secondary-actions" onClick={() => void run()}>Try again</s-button>
          )}
        </DismissibleBanner>
      </div>
    );
  }

  if (showComplete) {
    return (
      <div role="status" aria-live="polite" className="px-4 pt-3 md:px-6">
        <DismissibleBanner key="complete" tone="success" heading="Analysis complete" onDismiss={() => setShowComplete(false)} />
      </div>
    );
  }

  return null;
}
