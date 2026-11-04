import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingBag, Store } from 'lucide-react';
import AuthLayout from '../../layouts/AuthLayout';
import AuthField from '../../components/auth/AuthField';
import AuthAlert from '../../components/auth/AuthAlert';
import AuthSubmitButton from '../../components/auth/AuthSubmitButton';
import { describeShopifySignInFailure, startShopifySignIn } from '../../data/auth.repository';
import { normalizeShopDomain } from '../../data/shopify.repository';
import { ApiError } from '../../lib/api';

/**
 * ─── Create an account ───────────────────────────────────────────────
 *
 * SHOPIFY ONLY. Rankvora AI audits a Shopify store, so an account starts by naming one. Approving
 * Rankvora AI on Shopify's own screen creates the account from the shop's records — no form, no
 * password, and the store is already connected when the merchant lands.
 */
function describeShopifyError(error: unknown): string {
  if (error instanceof ApiError) {
    // The rate limiter's wording is already merchant-safe.
    if (error.status === 429) return error.message;
    return describeShopifySignInFailure(error.code);
  }
  return 'We could not reach Rankvora AI. Check your connection and try again.';
}

export default function Signup() {
  const [shopInput, setShopInput] = useState('');
  const [shopError, setShopError] = useState('');
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  async function handleShopifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError('');

    const shop = normalizeShopDomain(shopInput);
    if (!shop) {
      setShopError('Enter your store’s .myshopify.com address.');
      return;
    }
    setShopError('');

    setPending(true);
    try {
      await startShopifySignIn(shop);
      // The browser is on its way to Shopify. The button stays pending until the page unloads, so
      // a second click cannot start a second authorization over the first one's nonce.
    } catch (error) {
      setFormError(describeShopifyError(error));
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Launch Your Store's Growth Journey"
      subtitle="Create your premium Rankvora AI account with your Shopify store — no password to choose."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={handleShopifySubmit} noValidate>
        {formError && <AuthAlert message={formError} />}

        <AuthField
          label="Shopify store address"
          type="text"
          name="shop"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          placeholder="your-store.myshopify.com"
          icon={Store}
          value={shopInput}
          onChange={(event) => {
            setShopInput(event.target.value);
            setShopError('');
          }}
          error={shopError || undefined}
          hint="Find it in your Shopify admin under Settings → Domains."
          disabled={pending}
          required
        />

        <div className="mt-5">
          <AuthSubmitButton pending={pending} pendingLabel="Opening Shopify…" icon={ShoppingBag}>
            Continue with Shopify
          </AuthSubmitButton>
        </div>

        <p className="mt-3 text-center text-[12px] leading-5 text-surface-500">
          You approve access on Shopify’s own screen. Rankvora AI never asks for your Shopify password.
        </p>
      </form>
    </AuthLayout>
  );
}
