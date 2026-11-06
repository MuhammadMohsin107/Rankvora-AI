import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { beginShopifyInstall, fetchShopifyStatus } from '../../data/shopify.repository';
import { ApiError } from '../../lib/api';
import Button from '../../components/polaris/Button';

/**
 * Sends the merchant through Shopify's own approval screen for the store already connected, so
 * a permission added after they connected can be granted.
 *
 * This is the existing Connect flow, pointed at the connected shop: Shopify shows the permissions
 * Rankvora AI requests, and on approval the callback stores the new grant on the same connection. The
 * shop comes from the server's record of the connection, never from anything typed here.
 *
 * Shared by both sub-pillar templates. It used to live inside the SEO page alone, so a Content,
 * Speed, CRO or AI Discovery check waiting on a permission had no way to ask for it.
 */
export default function GrantShopifyAccess({ scope }: { scope: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await fetchShopifyStatus();
      if (!status.shopDomain || status.status === 'not_connected') {
        setError('No Shopify store is connected. Connect it on Integrations first.');
        setBusy(false);
        return;
      }
      // Navigates away to Shopify; nothing changes here until Shopify redirects back.
      await beginShopifyInstall(status.shopDomain);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open Shopify. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <p className="text-[11.5px] text-surface-500">
        Needs the Shopify permission <span className="font-mono text-surface-700">{scope}</span>.
      </p>
      <Button loading={busy} variant="secondary" onClick={() => void grant()} disabled={busy}>
        {busy ? 'Opening Shopify…' : 'Grant access in Shopify'}
      </Button>
      {error && (
        <p className="flex items-center gap-1.5 text-[12px] text-critical-700" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {error}
          {error.includes('Integrations') && <Link to="/integrations" className="font-semibold underline underline-offset-2">Go to Integrations</Link>}
        </p>
      )}
    </div>
  );
}
