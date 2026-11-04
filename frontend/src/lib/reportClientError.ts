import { api } from './api';

/**
 * Sends a render crash to the API's log (POST /client-errors).
 *
 * Until this existed, the ErrorBoundary wrote the crash only to the merchant's own browser
 * console — so the one failure that blanks the whole app was the one operators could never see.
 *
 * Fire-and-forget: a crash report that itself fails must not throw inside the error boundary, and
 * there is nothing for the merchant to do about it. Signed-out pages get a 401 and are dropped.
 *
 * The pathname only. The query string can carry a search a merchant typed, and the one Shopify opens
 * the app with carries an ID token — neither belongs in a log.
 */
export function reportClientError(error: Error, componentStack?: string | null): void {
  const text = (value: string | undefined | null, max: number) => (value ? value.slice(0, max) : undefined);
  void api
    .post('/client-errors', {
      message: text(`${error.name}: ${error.message || 'Unknown error'}`, 500),
      stack: text(error.stack, 4000),
      componentStack: text(componentStack, 4000),
      path: window.location.pathname.slice(0, 300) || '/',
    })
    .catch(() => undefined);
}
