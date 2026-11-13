import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Check, Gauge, Loader2, Search, ShoppingBag, type LucideIcon } from 'lucide-react';
import { ActionButton, Combobox, QuietNote, ToastStack, UnavailableNote, type ToastMessage } from './OnboardingPrimitives';
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
 * OPTIONAL, and built so that skipping is never the wrong answer: the technical audit runs without
 * any of these sources. The step's header says so, in one line.
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

/**
 * Pop-ups already shown during this page load. The step is mounted afresh every time the merchant
 * arrives on it, so without this, going Back and Continue would replay the same messages.
 */
const announced = new Set<string>();

/** One source: what it is and the state it is in. */
function SourceCard({
  icon: Icon,
  title,
  status,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** A short state chip: 'Connected', 'Not connected', 'No account needed'. Never alarming. */
  status: { label: string; tone: 'good' | 'neutral' };
  children?: ReactNode;
}) {
  return (
    <li className="rounded-2xl bg-surface-0 px-4 py-4 ring-1 ring-inset ring-surface-200 transition-shadow duration-200 hover:shadow-[0_12px_28px_-22px_var(--c-shadow-lg)]">
      <div className="flex items-start gap-3.5">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
          <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-surface-950">{title}</h3>
            <span
              className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${
                status.tone === 'good' ? 'text-success-700' : 'text-surface-500'
              }`}
            >
              {status.tone === 'good' ? (
                <Check size={13} strokeWidth={3} aria-hidden="true" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-surface-300" aria-hidden="true" />
              )}
              {status.label}
            </span>
          </div>
          {children && <div className="mt-3">{children}</div>}
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

  // What is worth saying once — Google just connected — leaves by itself instead of sitting in the
  // step. A failed connection is not in this list: it is
  // something to act on, so it stays inline below.
  useEffect(() => {
    const next: ToastMessage[] = [];
    if (notice && notice.tone !== 'error' && !announced.has(notice.message)) {
      announced.add(notice.message);
      next.push({ id: 'google-outcome', tone: notice.tone, message: notice.message });
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
  const connectActions = (key: string, label: string) =>
    later[key] ? (
      <QuietNote>Skipped for now.</QuietNote>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton onClick={() => void connect()} loading={busy === 'connect'} className="h-10 px-4 text-[13px]">
          {label}
        </ActionButton>
        <ActionButton variant="ghost" onClick={() => setLater((previous) => ({ ...previous, [key]: true }))} className="h-10 px-4 text-[13px]">
          Set up later
        </ActionButton>
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
        <ul className="space-y-3">
          <SourceCard
            icon={Search}
            title="Google Search Console"
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
                    <Combobox
                      id="onboarding-gsc-site"
                      value=""
                      disabled={busy === 'site' || sites === null}
                      placeholder={sites === null ? 'Reading your properties…' : sites.length === 0 ? 'No properties on this Google account' : 'Choose a property'}
                      options={(sites ?? []).map((site) => ({ value: site.siteUrl, label: site.siteUrl }))}
                      onChange={(value) => void chooseSite(value)}
                    />
                  </div>
                )}
                {!googleConnected && connectActions('gsc', 'Connect Google')}
              </>
            )}
          </SourceCard>

          <SourceCard
            icon={BarChart3}
            title="Google Analytics"
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
                    <Combobox
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
                  connectActions('ga4', 'Allow Analytics')}
                {!analytics.value.connected && connectActions('ga4', 'Connect Google')}
              </>
            )}
          </SourceCard>

          <SourceCard
            icon={Gauge}
            title="Performance measurement"
            status={{ label: 'No account needed', tone: 'neutral' }}
          >
            {pagespeed.state !== 'ready' ? (
              <QuietNote>Status unavailable.</QuietNote>
            ) : pagespeed.value.storefrontUrl ? (
              <QuietNote>{pagespeed.value.storefrontUrl}</QuietNote>
            ) : null}
          </SourceCard>

          <SourceCard
            icon={ShoppingBag}
            title="Google Merchant Center"
            status={{ label: 'Coming later', tone: 'neutral' }}
          >
          </SourceCard>
        </ul>
      )}
    </div>
  );
}
