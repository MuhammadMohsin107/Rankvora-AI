import { useEffect, useState, type KeyboardEvent } from 'react';
import AuthLayout from '../../layouts/AuthLayout';
import Banner from '../../components/polaris/Banner';
import Button from '../../components/polaris/Button';
import { TextField } from '../../components/polaris/fields';
import { ApiError } from '../../lib/api';
import { openStoreOnShopify } from '../../data/shopify.repository';

/**
 * ─── What a visitor sees on the bare site ────────────────────────────
 *
 * Rankvora AI runs inside the Shopify admin, where Shopify itself says which store is opening it. This
 * page is the way in for someone who is not there yet: they name their store, and Shopify does the rest
 * — signs them in, asks them to install Rankvora AI if it is not installed on that store, and opens the
 * app inside their admin, where guided setup begins (or the dashboard, for a store that has been set up).
 *
 * Nothing is signed in or remembered here. The form only asks the server which Shopify address to go to
 * (data/shopify.repository.ts, openStoreOnShopify); the visitor proves who they are to Shopify.
 *
 * ONE THING TO KNOW BEFORE SUBMITTING TO THE SHOPIFY APP STORE: its review (requirement 2.3.1) refuses
 * an app that asks a merchant to type their store address to install or configure it. Remove this form
 * for that submission — the page reverts to pointing at the Shopify admin and App Store — and let
 * merchants install from the listing.
 */

/** Answers worth showing as the server wrote them: they are plain-language and about what was typed. */
const SHOWN_AS_SENT = new Set(['SHOPIFY_SHOP_INVALID', 'RATE_LIMITED']);

function describeFailure(error: unknown): string {
  if (error instanceof ApiError && error.code && SHOWN_AS_SENT.has(error.code)) return error.message;
  return 'Could not reach Shopify. Please try again.';
}

export default function OpenFromShopify() {
  // A link or bookmark can carry the store: /login?shop=my-store.myshopify.com.
  const [shop, setShop] = useState(() => new URLSearchParams(window.location.search).get('shop') ?? '');
  const [error, setError] = useState<string | undefined>();
  const [going, setGoing] = useState(false);

  // Coming back to this page with the browser's Back button restores it as it was left — mid-submit.
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setGoing(false);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  async function submit() {
    if (going) return;
    if (!shop.trim()) {
      setError('Enter your store’s Shopify address, for example my-store.myshopify.com.');
      return;
    }
    setError(undefined);
    setGoing(true);
    try {
      await openStoreOnShopify(shop);
      // The browser is on its way to Shopify; the button stays busy until the page goes.
    } catch (failure) {
      setError(describeFailure(failure));
      setGoing(false);
    }
  }

  // Enter in the field. Polaris draws the input inside its own shadow root, so there is no form to submit;
  // the keystroke is caught as it passes the wrapper.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <AuthLayout
      title="Open Rankvora AI"
      subtitle="Enter your Shopify store address to continue."
    >
      <div onKeyDown={onKeyDown}>
        <TextField
          id="shop-domain"
          label="Store address"
          value={shop}
          onChange={(next) => {
            setShop(next);
            setError(undefined);
          }}
          placeholder="my-store.myshopify.com"
          error={error}
          disabled={going}
        />

        {going && (
          <div className="mt-4">
            <Banner tone="info">Taking you to Shopify…</Banner>
          </div>
        )}

        {/* A wrapper of our own, because a margin on a Polaris element itself does not take effect. */}
        <div className="mt-5">
          <Button variant="primary" fullWidth loading={going} onClick={() => void submit()}>
            Continue
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
