import { useCallback, useEffect, useRef, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { BarChart3, ChevronRight, Loader2 } from 'lucide-react';
import {
  fetchAnalyticsPerformance,
  fetchAnalyticsProperties,
  fetchAnalyticsStatus,
  selectAnalyticsProperty,
  type AnalyticsPerformance,
  type AnalyticsProperty,
  type AnalyticsStatus,
} from '../../data/analytics.repository';
import { startGoogleConnect } from '../../data/google.repository';
import { analyticsHealth } from '../../data/googleHealth';
import { useReportDays } from '../../data/reportWindow';
import { ApiError } from '../../lib/api';
import { ReportWindowPicker } from '../workflows/ReportWindowPicker';
import { Button, StatusBadge } from '../workflows/WorkflowPrimitives';
import Banner from '../polaris/Banner';

/**
 * ─── Google Analytics 4 connector ────────────────────────────────────
 *
 * Every value shown here is read from the real GA4 API in the request that renders it. There is no
 * sample property, no placeholder metric, and nothing is displayed for a store that has not
 * connected — the card says so instead.
 *
 * FIVE STATES, one more than the Search Console card, because GA4 rides on a connection that may
 * predate it and each state needs something different from the merchant:
 *
 *   not configured          The SERVER has no Google OAuth credentials. An operator's problem.
 *   not connected           No Google connection at all. Offer the same Connect as Search Console.
 *   scope missing           Connected, but the grant was made before Analytics was requested.
 *                           A working connection that cannot read GA4 — asks for a reconnect
 *                           rather than a button that would 403 at Google.
 *   connected, no property  Authorised, but which property? Choosing automatically would report
 *                           another company's traffic as this store's.
 *   connected + property    Real numbers.
 */

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Why the status read failed, in words that point at the fix. Same reasoning as the Search Console
 * card: one generic line cannot cover a stopped API, an old build and an expired session.
 */
function describeLoadFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the Rankvora AI API.';
  }
  if (error.status === 404) {
    return error.code === 'STORE_NOT_FOUND'
      ? 'This account has no store yet. Connect a store first.'
      : 'This server has no Google Analytics endpoint. Redeploy the API.';
  }
  if (error.status === 401) return 'Session expired. Reopen Rankvora AI from your Shopify admin.';
  return error.status >= 500
    ? `Server error (HTTP ${error.status}). ${error.message}`
    : error.message;
}

/**
 * Why the PROPERTY LIST could not be read.
 *
 * Kept apart from the status failure above because the card must not answer it with "this Google
 * account can read no GA4 properties" — a claim about the merchant's Google account that Rankvora AI
 * has no basis for when the call never returned a list. An empty list and an unanswered one look
 * identical in state and mean opposite things.
 */
function describePropertyListFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the Rankvora AI API.';
  }
  switch (error.status) {
    case 401:
      return 'Google rejected this connection. Reconnect Google.';
    case 403:
      // Account-level, so it is not "no access to that property" — the usual cause is the
      // Analytics Admin API being off for the server's Google Cloud project.
      return 'Google refused to list properties. Check the Analytics Admin API is enabled for this server.';
    case 409:
      return 'The Google connection ended. Connect again.';
    default:
      return error.message;
  }
}

interface GoogleAnalyticsCardProps {
  /**
   * Called whenever this card has just changed what is known about the connection — a read, a
   * refusal, a property chosen. The Integrations page re-reads its catalogue on it, so this card and
   * the catalogue card below it never describe the same connector differently.
   */
  onHealthChange?: () => void;
}

export default function GoogleAnalyticsCard({ onHealthChange }: GoogleAnalyticsCardProps = {}) {
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [properties, setProperties] = useState<AnalyticsProperty[]>([]);
  /** Whether Google actually answered with a list. False = not asked yet, or the ask failed. */
  const [propertiesLoaded, setPropertiesLoaded] = useState(false);
  /** Why the property list could not be read. Empty = it was read, however many it held. */
  const [propertiesError, setPropertiesError] = useState('');
  /** The property currently being submitted, so its own row says so rather than the whole list. */
  const [selecting, setSelecting] = useState<string | null>(null);
  const [performance, setPerformance] = useState<AnalyticsPerformance | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  /** Shared with Search Console beside it and with the AI referrals card — see data/reportWindow.ts. */
  const days = useReportDays();

  // A ref, so `load` keeps a stable identity and a parent passing a new function never re-reads Google.
  const onHealthChangeRef = useRef(onHealthChange);
  useEffect(() => {
    onHealthChangeRef.current = onHealthChange;
  });

  /**
   * Reads the properties this Google account can offer.
   *
   * NEVER THROWS. A listing that failed is a state the picker renders — with the reason and a
   * retry — not a reason to blank the card down to one error line, which is what hid the Connect
   * action and left "can read no GA4 properties" on screen as if it were Google's answer.
   */
  const loadProperties = useCallback(async () => {
    setPropertiesError('');
    try {
      setProperties(await fetchAnalyticsProperties());
      setPropertiesLoaded(true);
    } catch (err) {
      // Not an empty list: nothing was learned about this account, so nothing is claimed about it.
      setProperties([]);
      setPropertiesLoaded(false);
      setPropertiesError(describePropertyListFailure(err));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setState('loading');
      setLoadError('');
      const next = await fetchAnalyticsStatus();
      setStatus(next);

      // Only asked for once there is a usable grant to ask with. Both calls reach Google, so a
      // store that has not connected — or whose grant lacks the scope — must not trigger them.
      if (next.connected && next.scopeGranted) {
        try {
          if (next.propertyId) setPerformance(await fetchAnalyticsPerformance(days));
          else await loadProperties();
        } finally {
          // Either call just changed this provider's health — a read stamps its read time, a refusal
          // records why, listing properties clears an old refusal — and the status above predates
          // it. Read again, or a successful Refresh leaves the badge on "Not verified".
          setStatus(await fetchAnalyticsStatus());
        }
      }

      setState('ready');
    } catch (err) {
      setLoadError(describeLoadFailure(err));
      setState('error');
    } finally {
      onHealthChangeRef.current?.();
    }
    // `days` is a dependency, so changing the reporting period re-runs exactly what Refresh runs.
    // It costs two extra status reads against our own API rather than Google, and in exchange the
    // period never has a second code path that could drift from the one every other read uses.
  }, [loadProperties, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConnect() {
    setBusy(true);
    setError('');
    try {
      // The SAME flow Search Console uses. Reconnecting an existing grant is how the Analytics
      // scope gets added to it — Google issues scopes only on fresh consent.
      await startGoogleConnect();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? 'Google is not configured on this server.'
          : 'Could not start the Google connection.',
      );
      setBusy(false);
    }
  }

  async function handleSelectProperty(propertyId: string) {
    setBusy(true);
    setSelecting(propertyId);
    setError('');
    try {
      setStatus(await selectAnalyticsProperty(propertyId));
      setPerformance(await fetchAnalyticsPerformance(days));
    } catch (err) {
      setError(
        err instanceof ApiError && [400, 401, 403, 409].includes(err.status)
          ? err.message
          : 'Could not read that property.',
      );
    } finally {
      // The status the selection returned predates the read that followed it: a success stamped a
      // read time, a refusal recorded why. Read again so the badge describes what just happened.
      try {
        setStatus(await fetchAnalyticsStatus());
      } catch {
        // The selection's own status is already on screen, and the next load will correct it.
      }
      setSelecting(null);
      setBusy(false);
      onHealthChangeRef.current?.();
    }
  }

  // The same verdict the Integrations catalogue and Settings show for this connector, so this badge
  // cannot disagree with them. Pure — derived from the status already on screen.
  const health = status ? analyticsHealth(status) : null;

  if (state === 'loading' && !status) {
    return (
      <article className="rounded-lg border border-surface-200 bg-surface-0 p-3">
        <div className="flex items-center gap-2 text-[12px] text-surface-500">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          Checking Google Analytics…
        </div>
      </article>
    );
  }

  const usable = Boolean(status?.connected && status.scopeGranted);

  return (
    <article className="flex h-full flex-col rounded-lg border border-surface-200 bg-surface-0 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 gap-2.5">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-100 text-surface-700">
            <BarChart3 size={17} aria-hidden="true" />
          </span>
          <h3 className="min-w-0 self-center text-[12.5px] font-bold text-surface-950">Google Analytics</h3>
        </div>

        {/* Was a green "Connected" for any grant carrying the Analytics scope — before a property was
            chosen or a single number read. The verdict says "Working" only once Google answered a read. */}
        {health && <StatusBadge label={health.badge.label} tone={health.badge.tone} />}
      </div>

      {state === 'error' && (
        <div className="mt-2">
          <Banner tone="critical">
            <s-text>{loadError}</s-text>
            <Button slot="secondary-actions" variant="secondary" onClick={() => void load()}>Retry</Button>
          </Banner>
        </div>
      )}

      {error && (
        <div className="mt-2">
          <Banner tone="critical"><s-text>{error}</s-text></Banner>
        </div>
      )}

      {/* ── Not configured: an operator problem, not a merchant one ─── */}
      {status && !status.configured && (
        <p className="mt-2 rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-surface-600">
          Google sign-in is not configured on this server.
        </p>
      )}

      {/* ── Configured, no Google connection at all ───────────────── */}
      {status?.configured && !status.connected && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          <p className="text-[11.5px] leading-[1.4] text-surface-500">
            Read-only access. Rankvora AI cannot change anything in Google Analytics.
          </p>
          <div className="mt-2">
            <Button onClick={() => void handleConnect()} disabled={busy}>
              {busy ? 'Opening Google…' : 'Connect Google'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Connected, but the grant predates Analytics support ───── */}
      {status?.connected && !status.scopeGranted && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          <p className="rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-warning-800">
            {/* Not an error. The connection works — it just was not granted Analytics access, and
                Google only issues scopes on fresh consent, so the fix is a reconnect. */}
            This connection lacks Analytics access. Reconnect to grant it.
          </p>
          <div className="mt-2">
            <Button onClick={() => void handleConnect()} disabled={busy}>
              {busy ? 'Opening Google…' : 'Reconnect Google'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Connected, no property chosen ─────────────────────────── */}
      {usable && !status?.propertyId && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          {/* Named as the outstanding STEP, not as a heading over a list. The previous wording sat
              above rows that looked exactly like the read-only fields elsewhere on this page, so
              the badge said "Setup incomplete" while the screen appeared to be reporting a property
              that was already in use — and the one action left was invisible. */}
          {/* Never chosen automatically: an agency account routinely has dozens, and a guess
              would report another client's traffic as this store's. */}
          <p className="text-[12px] font-semibold text-surface-800">Choose a property</p>
          <p className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">Connected as {status?.googleEmail ?? 'your Google account'}.</p>

          {propertiesError ? (
            // The listing failed. Saying "can read no GA4 properties" here would invent Google's
            // answer out of a call that never returned one.
            <div className="mt-2">
              <Banner tone="critical">
                <s-text>{propertiesError}</s-text>
                <Button slot="secondary-actions" variant="secondary" onClick={() => void loadProperties()}>Retry</Button>
              </Banner>
            </div>
          ) : !propertiesLoaded ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-surface-500">
              <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Loading properties…
            </p>
          ) : properties.length === 0 ? (
            // Google answered, and the answer was none. Only reachable once a list came back.
            <p className="mt-2 text-[11.5px] leading-[1.4] text-surface-500">
              No GA4 properties. Create one or get Viewer access, then{' '}
              <Button variant="ghost" onClick={() => void loadProperties()}>check again</Button>.
            </p>
          ) : (
            // Scrolls: an agency account routinely has dozens of properties, and
            // an un-capped list pushes the card past the fold before they reach the right one.
            <ul ref={scrollChaining} className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {properties.map((property) => (
                <li key={property.propertyId}>
                  <button
                    type="button"
                    onClick={() => void handleSelectProperty(property.propertyId)}
                    disabled={busy}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-surface-200 bg-surface-0 px-2.5 py-2 text-left transition-colors hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {/* A radio, so the row reads as one of several choices rather than as a field
                        stating a value. */}
                    <span aria-hidden="true" className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-surface-300 transition-colors group-hover:border-brand-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-transparent transition-colors group-hover:bg-brand-600" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] text-surface-800">
                        {property.displayName}
                        <span className="ml-1.5 text-surface-500">· {property.account}</span>
                      </span>
                      <span className="block font-mono text-[10.5px] text-surface-500">properties/{property.propertyId}</span>
                    </span>
                    {/* The action, spelled out. This is what was missing: the row was already a
                        button, and nothing on screen said so. */}
                    <span className="flex flex-shrink-0 items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[10.5px] font-semibold text-surface-0">
                      {selecting === property.propertyId ? (
                        <><Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Selecting…</>
                      ) : (
                        <>Use this property<ChevronRight size={11} aria-hidden="true" /></>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Connected with real data ──────────────────────────────── */}
      {/* `flex-1 flex-col`, matching Search Console: the pair is equal height now, so this card's
          Refresh has to sit on the same floor as its neighbour's rather than floating mid-card. */}
      {usable && status?.propertyId && (
        <div className="mt-2.5 flex flex-1 flex-col border-t border-surface-100 pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-surface-700">properties/{status.propertyId}</p>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {/* Changes the period for Search Console beside it and for the AI referrals card too:
                  one value, so the page can never put a 90-day figure next to a 28-day one. */}
              <ReportWindowPicker value={days} disabled={busy || state === 'loading'} label="Analytics reporting period" />
              {performance && (
                // The dates Google actually answered for. GA4 lags a day or two, so a range ending
                // today would show a partial tail that reads as a collapse in traffic.
                <p className="text-[10.5px] text-surface-500">{performance.startDate} to {performance.endDate}</p>
              )}
            </div>
          </div>

          {performance ? (
            <>
              {/* One row from `sm`, matching Search Console beside it — the two cards sit side by
                  side and their headline rows have to line up. Same truncation rule: a wrapped
                  label would push its tile taller than its neighbours. */}
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { label: 'Sessions', value: performance.totals.sessions.toLocaleString() },
                  { label: 'Engaged', value: performance.totals.engagedSessions.toLocaleString() },
                  { label: 'Engagement', value: formatPercent(performance.totals.engagementRate) },
                  { label: 'Conversions', value: performance.totals.conversions.toLocaleString() },
                ].map((tile) => (
                  <div key={tile.label} className="min-w-0 rounded-md bg-surface-50 px-2.5 py-1.5">
                    <p className="truncate text-[10px] font-bold uppercase tracking-[0.1em] text-surface-500" title={tile.label}>{tile.label}</p>
                    <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-surface-900">{tile.value}</p>
                  </div>
                ))}
              </div>

              {performance.totals.sessions === 0 && (
                // A real zero, said plainly — and for GA4 the likeliest cause is worth naming,
                // because a property with no tag on the storefront stays empty forever and looks
                // exactly like a broken connection.
                <p className="mt-2 rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-surface-600">
                  No sessions in this period. Check the GA4 tag is installed on your storefront.
                </p>
              )}

              {/* Both lists scroll and show every row Google returned, for the same reason the
                  Search Console queries do: a store with five landing pages today has hundreds
                  later, and slicing to five threw away rows the request had already paid for.
                  Capping the box rather than the data keeps the card's height stable. */}
              {performance.topLandingPages.length > 0 && (
                <div className="mt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Top landing pages</p>
                    <p className="text-[10.5px] tabular-nums text-surface-400">{performance.topLandingPages.length} returned</p>
                  </div>
                  <ul ref={scrollChaining} className="mt-1 max-h-44 overflow-y-auto divide-y divide-surface-100 pr-0.5">
                    {performance.topLandingPages.map((row) => (
                      <li key={row.key} className="flex items-center justify-between gap-2 py-1">
                        {/* '(not set)' is GA4's own label for a row it could not attribute — shown
                            as it came back, never blanked or dropped. */}
                        <span className="min-w-0 truncate text-[12px] text-surface-800" title={row.key || '(not set)'}>{row.key || '(not set)'}</span>
                        <span className="flex-shrink-0 text-[11px] tabular-nums text-surface-500">
                          {row.sessions.toLocaleString()} sessions
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {performance.topChannels.length > 0 && (
                <div className="mt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Channels</p>
                    <p className="text-[10.5px] tabular-nums text-surface-400">{performance.topChannels.length} returned</p>
                  </div>
                  <ul ref={scrollChaining} className="mt-1 max-h-36 overflow-y-auto divide-y divide-surface-100 pr-0.5">
                    {performance.topChannels.map((row) => (
                      <li key={row.key} className="flex items-center justify-between gap-2 py-1">
                        <span className="min-w-0 truncate text-[12px] text-surface-800" title={row.key || '(not set)'}>{row.key || '(not set)'}</span>
                        <span className="flex-shrink-0 text-[11px] tabular-nums text-surface-500">
                          {row.sessions.toLocaleString()} sessions · {row.conversions.toLocaleString()} conv
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="mt-2 text-[11.5px] text-surface-500">Loading Analytics performance…</p>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-surface-100 pt-2">
            {/* The same action either way — it re-reads live data from Google. Named for what it is
                worth doing right now, so the test read the verdict asks for is a button that exists
                rather than an instruction pointing at nothing.

                Primary, like every other re-read across the app: this is the one thing worth doing
                on this card, and it was the only such button still wearing the outline style. */}
            <Button onClick={() => void load()} disabled={busy}>
              {health?.state === 'unverified' ? 'Run test read' : 'Refresh'}
            </Button>
          </div>
        </div>
      )}

      {/* Google refused the last read — revoked access, or the property is gone. Surfaced because
          the alternative is a card that says "Connected" beside no data and explains nothing. */}
      {status?.lastError && (
        <p className="mt-2 rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-warning-800">
          {status.lastError}
        </p>
      )}
    </article>
  );
}
