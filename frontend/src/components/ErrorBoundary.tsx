import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { reportClientError } from '../lib/reportClientError';
import Button from '../components/polaris/Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * ─── Last line of defence ────────────────────────────────────────────
 *
 * WHY THIS EXISTS. A single component throwing during render unmounts the ENTIRE React tree —
 * React's documented behaviour since 16, and it produces a completely blank page with nothing on
 * screen to explain it or click. That is what a customer signing in on a new laptop saw: one
 * `.filter` call against a value that was not an array, and the whole application vanished.
 *
 * A crash is a bug either way. The difference an error boundary makes is between "the product is
 * broken" and "this screen is broken, here is a way out" — and between a support ticket that says
 * "white page" and one that carries the actual error text.
 *
 * Deliberately NOT a route-level boundary: it wraps the whole app because the failures worth
 * catching here are the ones that take everything down. A reload is offered because most render
 * crashes come from state that a fresh load will not reproduce.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console rather than shown: a component stack is for whoever is debugging, and
    // the customer already has the message plus something to do about it.
    console.error('Unhandled render error', error, info.componentStack);
    // And sent to the server's log, where an operator can see it without the customer's laptop.
    reportClientError(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-50 px-4">
        <div className="w-full max-w-md rounded-lg border border-surface-200 bg-surface-0 p-5 text-center shadow-sm">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-critical-50 text-critical-600">
            <AlertTriangle size={20} aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-[15px] font-semibold text-surface-950">Something went wrong on this screen</h1>
          <p className="mt-1.5 text-[12.5px] leading-[1.5] text-surface-500">
            Rankvora AI hit an error it could not recover from. Your data is unaffected — nothing was
            being saved when this happened.
          </p>

          {/* The real message, not a generic one. Someone reporting this can paste something
              actionable instead of "the page went white". */}
          <p className="mt-2.5 break-words rounded-md bg-surface-50 px-2.5 py-2 text-left font-mono text-[11px] leading-[1.5] text-surface-600">
            {error.message || 'Unknown error'}
          </p>

          <div className="mt-3 flex justify-center gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
            <Button variant="secondary" href="/">Back to dashboard</Button>
          </div>
        </div>
      </div>
    );
  }
}
