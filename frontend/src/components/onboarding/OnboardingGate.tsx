import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { fetchOnboarding } from '../../data/onboarding.repository';

/**
 * Routes a merchant into guided setup whenever they land in the app with a connected store whose
 * setup is not finished — a new store, or one that stopped partway. Setup opens at the first step
 * still unanswered (see openingStep in pages/onboarding/Onboarding.tsx), so a returning merchant
 * resumes rather than starts over.
 *
 * Runs once per app mount, not per navigation — redirecting again on every route change is a nag
 * rather than a flow. A `deferred_at` mark from before setup became mandatory does NOT exempt a
 * store: setup has no "finish later" now, and a store that exists with unfinished setup resumes it
 * instead of going straight to the dashboard.
 *
 * FAILS OPEN. If the check errors, times out, or the store is not connected, the app renders
 * normally. Setup is worth interrupting someone for; it is not worth locking them out of their
 * own dashboard when an endpoint is down.
 */
export default function OnboardingGate({ children }: { children: ReactNode }) {
  const [decision, setDecision] = useState<'checking' | 'allow' | 'redirect'>('checking');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const state = await fetchOnboarding();
        if (cancelled) return;
        // Redirect for a connected store whose setup is not finished.
        const needsSetup = state.connected && !state.completedAt;
        setDecision(needsSetup ? 'redirect' : 'allow');
      } catch {
        if (!cancelled) setDecision('allow');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Held for one same-origin request rather than flashing the dashboard and yanking it away.
  if (decision === 'checking') return null;
  if (decision === 'redirect') return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
