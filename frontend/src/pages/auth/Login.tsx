import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, ShoppingBag, Store } from 'lucide-react';
import AuthLayout from '../../layouts/AuthLayout';
import AuthField from '../../components/auth/AuthField';
import AuthAlert from '../../components/auth/AuthAlert';
import AuthSubmitButton from '../../components/auth/AuthSubmitButton';
import { useAuth } from '../../context/AuthContext';
import {
  describeShopifySignInFailure,
  readShopifyGrant,
  readShopifyLaunch,
  readSignInReference,
  startShopifyLaunch,
  startShopifySignIn,
} from '../../data/auth.repository';
import { normalizeShopDomain } from '../../data/shopify.repository';
import { ApiError } from '../../lib/api';

/**
 * ─── Sign in ─────────────────────────────────────────────────────────
 *
 * SHOPIFY ONLY. A merchant signs in — and a new merchant gets their account — by naming their
 * store and approving Rankvora AI on Shopify's own screen.
 *
 * This page is also where Shopify sign-in ARRIVES, in two ways that need no form at all:
 *   • Shopify opened Rankvora AI (App Store install, or Apps in the admin) with a signed query — the
 *     page sends the merchant straight on to Shopify's authorization, with nothing typed.
 *   • Shopify's authorization finished and the backend returned a grant in the URL fragment — the
 *     page redeems it and signs the merchant in.
 */
function describeShopifyError(error: unknown): string {
  if (error instanceof ApiError) {
    // The rate limiter's wording is already merchant-safe.
    if (error.status === 429) return error.message;
    // A server fault carries the id of its log entry; a refusal (expired, wrong store) does not need one.
    return describeShopifySignInFailure(error.code, error.status >= 500 ? error.requestId : undefined);
  }
  return 'We could not reach Rankvora AI. Check your connection and try again.';
}

export default function Login() {
  const { completeShopifySignIn, sessionEndedReason, clearSessionEndedReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [shopInput, setShopInput] = useState('');
  const [shopError, setShopError] = useState('');
  const [formError, setFormError] = useState('');
  /** Why the last session ended, when the server ended it. News, not an error, so it reads calmly. */
  const [sessionNotice, setSessionNotice] = useState('');
  const [pending, setPending] = useState(false);

  /**
   * What the page is doing because of HOW it was opened, before any form is shown. Derived from the
   * URL on first render so a merchant arriving from Shopify never sees a form flash before the
   * redirect or the sign-in completes.
   */
  const [arrival, setArrival] = useState<'none' | 'redirecting' | 'completing'>(() =>
    readShopifyGrant(location.hash) ? 'completing' : readShopifyLaunch(location.search) ? 'redirecting' : 'none',
  );
  // A grant's nonce is single-use, so the arrival must be handled exactly once — including under
  // StrictMode, which runs mount effects twice in development.
  const arrivalHandled = useRef(false);

  // ─── Arriving from Shopify ──────────────────────────────────────────
  // Reads the URL the page was OPENED with, once. What arrived is stripped from the address bar
  // straight away with replaceState rather than a router navigation, so a grant never lingers in
  // history and the page does not re-render into a state that has lost it.
  useEffect(() => {
    if (arrivalHandled.current) return;
    arrivalHandled.current = true;

    const grant = readShopifyGrant(location.hash);
    const launch = readShopifyLaunch(location.search);
    const params = new URLSearchParams(location.search);
    const outcome = params.get('shopify');

    if (grant || launch || outcome) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }

    if (grant) {
      void finishShopifySignIn(grant);
      return;
    }

    if (launch) {
      startShopifyLaunch(launch).catch((error: unknown) => {
        setArrival('none');
        setFormError(describeShopifyError(error));
      });
      return;
    }

    if (outcome === 'cancelled') setFormError(describeShopifySignInFailure('access_denied'));
    else if (outcome === 'failed') {
      setFormError(describeShopifySignInFailure(params.get('reason'), readSignInReference(params.get('ref'))));
    }
    else if (sessionEndedReason) {
      // The server ended the last session itself — say why, once.
      setSessionNotice(describeShopifySignInFailure(sessionEndedReason));
      clearSessionEndedReason();
    }
    // Deliberately no dependencies: this reads the URL the page was opened with, once.
  }, []);

  async function finishShopifySignIn(grant: string) {
    setArrival('completing');
    try {
      await completeShopifySignIn(grant);
      navigate('/', { replace: true });
    } catch (error) {
      setArrival('none');
      setFormError(describeShopifyError(error));
    }
  }

  async function handleShopifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError('');
    setSessionNotice('');

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
      // a second click cannot start a second sign-in over the first one's nonce.
    } catch (error) {
      setFormError(describeShopifyError(error));
      setPending(false);
    }
  }

  // ─── Arriving from Shopify: nothing to fill in ──────────────────────
  if (arrival !== 'none') {
    const completing = arrival === 'completing';
    return (
      <AuthLayout
        title={completing ? 'Signing you in' : 'Opening Shopify'}
        subtitle={
          completing
            ? 'Shopify confirmed your store. Finishing your sign-in…'
            : 'Taking you to Shopify to confirm your store…'
        }
      >
        <div role="status" aria-live="polite" className="flex justify-center py-6">
          <Loader2
            size={30}
            strokeWidth={2.25}
            className="animate-spin text-[color:var(--auth-accent)] motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only">{completing ? 'Signing you in' : 'Opening Shopify'}</span>
        </div>
      </AuthLayout>
    );
  }

  // ─── The sign-in form ───────────────────────────────────────────────
  return (
    <AuthLayout
      title="Sign in to Rankvora AI"
      subtitle="Use your Shopify store to sign in."
      footer={
        <>
          {/* Signing in with a shop Rankvora AI has never seen still creates an account on its own,
              so this is a signpost rather than the only door — but someone who has not signed up
              yet should not have to know that to find it. */}
          <p>
            Don’t have an account? <Link to="/signup">Create one</Link>
          </p>
          <p className="mt-2">
            Installed Rankvora AI from the Shopify App Store? Open it from{' '}
            <span className="font-semibold text-surface-900">Apps</span> in your Shopify admin to sign in without typing
            anything.
          </p>
        </>
      }
    >
      <form onSubmit={handleShopifySubmit} noValidate>
        {formError ? <AuthAlert message={formError} /> : sessionNotice && <AuthAlert tone="info" message={sessionNotice} />}

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
