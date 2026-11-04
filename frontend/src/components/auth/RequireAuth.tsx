import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { isEmbedded } from '../../lib/embedded';
import EmbeddedUnavailable from './EmbeddedUnavailable';

/**
 * Gate for every in-app route. While the session is resolving it renders a neutral
 * placeholder rather than the login screen, so an already-signed-in customer never sees
 * a flash of "signed out" on reload.
 *
 * This is a UX guard only — it is NOT the security boundary. Authorization is enforced
 * server-side on every endpoint; bypassing this component reveals no data.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-50" role="status" aria-live="polite">
        <span className="sr-only">Loading your session…</span>
        <span aria-hidden="true" className="h-6 w-6 animate-spin rounded-full border-2 border-surface-200 border-t-brand-600 motion-reduce:animate-none" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    // Inside the Shopify admin there is no sign-in page to send anyone to: say what went wrong.
    if (isEmbedded()) return <EmbeddedUnavailable />;
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
