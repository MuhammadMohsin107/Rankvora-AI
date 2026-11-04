import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Check, Gauge, Loader2, Search, ShoppingBag, type LucideIcon } from 'lucide-react';
import { ActionButton, LabelledSelect, QuietNote, ToastStack, UnavailableNote, type ToastMessage } from './OnboardingPrimitives';
import { ApiError } from '../../lib/api';
import {
  fetchGoogleSites,
  fetchGoogleStatus,
  selectGoogleSite,
  startGoogleConnect,
  type SearchConsoleSite,
  type SearchConsoleStatus,
} from '../../data/google.repository';
import {
  fetchAnalyticsProperties,
  fetchAnalyticsStatus,
  selectAnalyticsProperty,
  type AnalyticsProperty,
  type AnalyticsStatus,
} from '../../data/analytics.repository';
import { fetchPageSpeedStatus, type PageSpeedStatus } from '../../data/pagespeed.repository';

/**
 * ─── Step 4 · Measurement sources ────────────────────────────────────
 *
 * OPTIONAL, and built so that skipping is never the wrong answer. Every source says what it
 * unlocks and — just as plainly — what still works without it, because "connect Search Console or
 * your audit is incomplete" would be untrue: the technical audit runs without it, and the only
 * thing missing is the search-performance data nobody has read yet.
 *
 * A source that is not connected is shown as available to connect, never as a fault in the store.
 * Nothing on this screen is red for being unconnected.
 *
 * EVERY STATE IS READ FROM THE REAL CONNECTION, not from a note that the merchant said they would.
 * That is why the screen can be left, Google visited, and returned to — Google sends the merchant
 * back to this step, and it simply reads the connection that now exists.
 *
 * Connecting happens through the same server-side OAuth the Integrations page uses. No token ever
 * reaches this page.
 */

type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'unknown' };

function describeError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

const REASSURANCE =
  'None of this is needed for your first analysis. Connect what you have now, or skip it — a skipped source shows up as “not measured yet” on your dashboard, never as a problem with your store.';

/**
 * Pop-ups already shown during this page load. The step is mounted afresh every time the merchant
 * arrives on it, so without this, going Back and Continue would replay the same messages.
 */
const announced = new Set<string>();

/** One source: what it is, what it unlocks, what happens without it, and the state it is in. */
function SourceCard({
  icon: Icon,
  title,
  unlocks,
  ifSkipped,
  status,
  children,
}: {
  icon: LucideIcon;
  title: string;
  unlocks: string;
  ifSkipped: string;
  /** A short state chip: 'Connected', 'Not connected', 'No account needed'. Never alarming. */
  status: { label: string; tone: 'good' | 'neutral' };
  children?: ReactNode;
}) {
  return (
    <li className="rounded-xl border border-surface-200 bg-surface-0 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-200/70">
          <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="text-[13px] font-semibold text-surface-900">{title}</h3>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                status.tone === 'good'
                  ? 'bg-success-50 text-success-700 ring-1 ring-inset ring-success-100'
                  : 'bg-surface-100 text-surface-600 ring-1 ring-inset ring-surface-200'
              }`}
            >
              {status.tone === 'good' && <Check size={10} strokeWidth={3} aria-hidden="true" />}
              {status.label}
            </span>
          </div>
          <dl className="mt-1.5 space-y-0.5 text-[12px] leading-[1.5]">
            <div className="flex gap-1.5">
              <dt className="flex-shrink-0 font-semibold text-surface-700">Unlocks</dt>
              <dd className="text-surface-600">{unlocks}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="flex-shrink-0 font-semibold text-surface-700">If skipped</dt>
              <dd className="text-surface-600">{ifSkipped}</dd>
            </div>
          </dl>
          {children && <div className="mt-2.5">{children}</div>}
        </div>
      </div>
    </li>
  );
}

export interface MeasurementStepProps {
  /** The outcome of a Google connection the merchant just came back from, if any. */
  notice: { tone: 'success' | 'error' | 'info'; message: string } | null;
}

export default function MeasurementStep({ notice }: MeasurementStepProps) {
  const [google, setGoogle] = useState<Loaded<SearchConsoleStatus>>({ state: 'loading' });
  const [analytics, setAnalytics] = useState<Loaded<AnalyticsStatus>>({ state: 'loading' });
  const [pagespeed, setPagespeed] = useState<Loaded<PageSpeedStatus>>({ state: 'loading' });
  const [sites, setSites] = useState<SearchConsoleSite[] | null>(null);
  const [properties, setProperties] = useState<AnalyticsProperty[] | null>(null);
  const [busy, setBusy] = useState<'connect' | 'site' | 'property' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Sources the merchant chose "Set up later" for. A local, honest fold-away — nothing is stored. */
  const [later, setLater] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  // What is worth saying once — Google just connected, and that none of this is required — leaves
  // by itself instead of sitting in the step. A failed connection is not in this list: it is
  // something to act on, so it stays inline below.
  useEffect(() => {
    const next: ToastMessage[] = [];
    if (notice && notice.tone !== 'error' && !announced.has(notice.message)) {
      announced.add(notice.message);
      next.push({ id: 'google-outcome', tone: notice.tone, message: notice.message });
    }
    if (!announced.has(REASSURANCE)) {
      announced.add(REASSURANCE);
      next.push({ id: 'optional-step', tone: 'info', message: REASSURANCE });
    }
    if (next.length > 0) setToasts((current) => [...current, ...next]);
  }, [notice]);

  const load = useCallback(async () => {
    // Each read stands alone: one source being unreachable must not blank the other two.
    const [g, a, p] = await Promise.allSettled([fetchGoogleStatus(), fetchAnalyticsStatus(), fetchPageSpeedStatus()]);
    setGoogle(g.status === 'fulfilled' ? { state: 'ready', value: g.value } : { state: 'unknown' });
    setAnalytics(a.status === 'fulfilled' ? { state: 'ready', value: a.value } : { state: 'unknown' });
    setPagespeed(p.status === 'fulfilled' ? { state: 'ready', value: p.value } : { state: 'unknown' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Properties are listed only once there is a connection to list them from, and only while one
  // still has to be chosen — no request is made for a source that is already finished.
  const googleConnected = google.state === 'ready' && google.value.connected;
  const siteChosen = google.state === 'ready' && Boolean(google.value.siteUrl);
  const ga4Ready = analytics.state === 'ready' && analytics.value.connected && analytics.value.scopeGranted;
  const propertyChosen = analytics.state === 'ready' && Boolean(analytics.value.propertyId);

  useEffect(() => {
    if (!googleConnected || siteChosen) return;
    let cancelled = false;
    fetchGoogleSites()
      .then((list) => !cancelled && setSites(list))
      .catch((error) => !cancelled && setProblem(describeError(error)));
    return () => {
      cancelled = true;
    };
  }, [googleConnected, siteChosen]);

  useEffect(() => {
    if (!ga4Ready || propertyChosen) return;
    let cancelled = false;
    fetchAnalyticsProperties()
      .then((list) => !cancelled && setProperties(list))
      .catch((error) => !cancelled && setProblem(describeError(error)));
    return () => {
      cancelled = true;
    };
  }, [ga4Ready, propertyChosen]);

  const connect = async () => {
    setBusy('connect');
    setProblem(null);
    try {
      // Navigates away to Google; the signed state brings the merchant back to this step.
      await startGoogleConnect('onboarding');
    } catch (error) {
      setProblem(describeError(error));
      setBusy(null);
    }
  };

  const chooseSite = async (siteUrl: string) => {
    if (!siteUrl) return;
    setBusy('site');
    setProblem(null);
    try {
      await selectGoogleSite(siteUrl);
      await load();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const chooseProperty = async (propertyId: string) => {
    if (!propertyId) return;
    setBusy('property');
    setProblem(null);
    try {
      await selectAnalyticsProperty(propertyId);
      await load();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const loading = google.state === 'loading' || analytics.state === 'loading' || pagespeed.state === 'loading';

  /** A connect / set-up-later pair, or the quiet fold-away once "later" was chosen. */
  const connectActions = (key: string, label: string, note?: string) =>
    later[key] ? (
      <QuietNote>Skipped for now. Connect any time from Integrations — your analysis does not need it.</QuietNote>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton onClick={() => void connect()} loading={busy === 'connect'}>
          {label}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => setLater((previous) => ({ ...previous, [key]: true }))}>
          Set up later
        </ActionButton>
        {note && <span className="text-[11.5px] text-surface-500">{note}</span>}
      </div>
    );

  return (
    <div className="space-y-3">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {notice?.tone === 'error' && <UnavailableNote>{notice.message}</UnavailableNote>}
      {problem && <UnavailableNote>{problem}</UnavailableNote>}

      {loading ? (
        <QuietNote>
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Checking your connections…
        </QuietNote>
      ) : (
        <ul className="space-y-2.5">
          <SourceCard
            icon={Search}
            title="Google Search Console"
            unlocks="Search queries, clicks, impressions, average position and supported indexing checks."
            ifSkipped="Your technical SEO audit still runs. Search performance shows as not measured."
            status={
              google.state !== 'ready'
                ? { label: 'Status unavailable', tone: 'neutral' }
                : !google.value.configured
                  ? { label: 'Not available on this server', tone: 'neutral' }
                  : siteChosen
                    ? { label: 'Connected', tone: 'good' }
                    : googleConnected
                      ? { label: 'Choose a property', tone: 'neutral' }
                      : { label: 'Not connected', tone: 'neutral' }
            }
          >
            {google.state === 'ready' && google.value.configured && (
              <>
                {siteChosen && <QuietNote>Reporting on {google.value.siteUrl}</QuietNote>}
                {googleConnected && !siteChosen && (
                  <div className="max-w-md">
                    <LabelledSelect
                      id="onboarding-gsc-site"
                      value=""
                      disabled={busy === 'site' || sites === null}
                      placeholder={sites === null ? 'Reading your properties…' : sites.length === 0 ? 'No properties on this Google account' : 'Choose a property'}
                      options={(sites ?? []).map((site) => ({ value: site.siteUrl, label: site.siteUrl }))}
                      onChange={(value) => void chooseSite(value)}
                    />
                  </div>
                )}
                {!googleConnected && connectActions('gsc', 'Connect Google', 'One sign-in covers Search Console and Analytics.')}
              </>
            )}
          </SourceCard>

          <SourceCard
            icon={BarChart3}
            title="Google Analytics"
            unlocks="Sessions attributed to referrals, including ones identifiable as coming from AI assistants."
            ifSkipped="Everything else still runs. Referral measurement shows as not measured."
            status={
              analytics.state !== 'ready'
                ? { label: 'Status unavailable', tone: 'neutral' }
                : !analytics.value.configured
                  ? { label: 'Not available on this server', tone: 'neutral' }
                  : propertyChosen
                    ? { label: 'Connected', tone: 'good' }
                    : ga4Ready
                      ? { label: 'Choose a property', tone: 'neutral' }
                      : analytics.value.connected
                        ? { label: 'Needs permission', tone: 'neutral' }
                        : { label: 'Not connected', tone: 'neutral' }
            }
          >
            {analytics.state === 'ready' && analytics.value.configured && (
              <>
                {propertyChosen && <QuietNote>Reporting on property {analytics.value.propertyId}</QuietNote>}
                {ga4Ready && !propertyChosen && (
                  <div className="max-w-md">
                    <LabelledSelect
                      id="onboarding-ga4-property"
                      value=""
                      disabled={busy === 'property' || properties === null}
                      placeholder={properties === null ? 'Reading your properties…' : properties.length === 0 ? 'No Analytics properties on this Google account' : 'Choose a property'}
                      options={(properties ?? []).map((property) => ({
                        value: property.propertyId,
                        label: `${property.displayName} · ${property.account}`,
                      }))}
                      onChange={(value) => void chooseProperty(value)}
                    />
                  </div>
                )}
                {/* Connected before Analytics support existed: the Google grant lacks the GA4 scope. */}
                {analytics.value.connected && !analytics.value.scopeGranted &&
                  connectActions('ga4', 'Allow Analytics', 'Reconnect Google once to include Analytics.')}
                {!analytics.value.connected && connectActions('ga4', 'Connect Google', 'Uses the same Google sign-in as Search Console.')}
              </>
            )}
          </SourceCard>

          <SourceCard
            icon={Gauge}
            title="Performance measurement"
            unlocks="Lab diagnostics for your storefront and field measurements where Google has them."
            ifSkipped="Not applicable — there is nothing to connect. It runs on your public storefront."
            status={{ label: 'No account needed', tone: 'neutral' }}
          >
            <QuietNote>
              {pagespeed.state !== 'ready'
                ? 'Performance status could not be read right now.'
                : pagespeed.value.storefrontUrl
                  ? `Measures ${pagespeed.value.storefrontUrl}${pagespeed.value.keyed ? '.' : ', using Google’s shared quota — a measurement can occasionally be rate-limited and is then reported as not measured.'}`
                  : 'Measures your public storefront once your store is connected.'}
            </QuietNote>
          </SourceCard>

          <SourceCard
            icon={ShoppingBag}
            title="Google Merchant Center"
            unlocks="Product feed status, availability and identifier coverage."
            ifSkipped="Nothing changes."
            status={{ label: 'Coming later', tone: 'neutral' }}
          >
            <QuietNote>Not available yet. It will be offered here and on Integrations when it is.</QuietNote>
          </SourceCard>
        </ul>
      )}
    </div>
  );
}
