import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { polarisAvailable } from '../lib/polaris';

/** How long Polaris gets to register its elements before the notice appears. */
const WAIT_MS = 8000;

/**
 * Tells the merchant when Shopify's UI kit did not arrive.
 *
 * index.html loads polaris-2.js from Shopify's CDN, and every `<s-button>`, `<s-page>` and `<s-banner>`
 * depends on it. When an extension, a network rule or an outage blocks that one script the elements
 * stay unknown tags: buttons turn into plain text and the page looks broken with nothing to say why.
 * watchPolaris() already writes that to the API log for whoever runs the app; this is the part the
 * merchant can see.
 *
 * Built from plain HTML on purpose — the Polaris components (and our `Button` wrapper around them) are
 * exactly what is missing, so a notice made of them would not show either. It renders nothing at all
 * while Polaris is present, which is the normal case.
 */
export default function PolarisNotice() {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (polarisAvailable()) return;
    let registered = false;
    // Waits for the element itself rather than guessing: if the script turns up late (a slow
    // connection) the notice never appears, or comes back down.
    void customElements.whenDefined('s-button').then(() => { registered = true; setMissing(false); });
    const timer = window.setTimeout(() => { if (!registered) setMissing(true); }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!missing) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-start justify-center gap-2.5 border-b border-critical-100 bg-critical-50 px-4 py-2.5 text-critical-700"
    >
      <AlertTriangle size={15} className="mt-px flex-shrink-0" aria-hidden="true" />
      <p className="text-[12.5px] leading-[1.5]">
        Part of this page could not load, so buttons and layout may look wrong. Check your connection or any
        ad blocker, then{' '}
        <button type="button" onClick={() => window.location.reload()} className="font-semibold underline underline-offset-2">
          reload the page
        </button>
        .
      </p>
    </div>
  );
}
