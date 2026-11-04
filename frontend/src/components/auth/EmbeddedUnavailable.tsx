import { AlertCircle, RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { describeOpenFailure } from '../../data/auth.repository';

/**
 * What the merchant sees when the app could not open inside their Shopify admin.
 *
 * It stands where the sign-in page would, and deliberately offers none: there is no form to fill in
 * and nothing to approve — the shop is identified by Shopify itself — so the useful things are the
 * reason, in words the merchant can act on, and a way to try again. The reason is the server's code
 * (kept by AuthContext as `openFailure`), never raw text.
 */
export default function EmbeddedUnavailable() {
  const { openFailure } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-50 px-4" role="alert">
      <div className="w-full max-w-md rounded-lg border border-surface-200 bg-surface-0 p-5 text-center">
        <AlertCircle size={22} className="mx-auto text-critical-600" aria-hidden="true" />
        <h1 className="mt-2 text-[15px] font-semibold text-surface-900">Rankvora AI could not open</h1>
        <p className="mt-1.5 text-[12.5px] leading-[1.5] text-surface-600">{describeOpenFailure(openFailure)}</p>
        <button type="button" onClick={() => window.location.reload()} className="btn-secondary btn-xs mt-3">
          <RefreshCw size={12} aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  );
}
