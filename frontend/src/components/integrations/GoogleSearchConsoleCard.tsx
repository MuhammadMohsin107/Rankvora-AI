import { useCallback, useEffect, useRef, useState } from 'react';
import { scrollChaining } from '../../lib/scrollChaining';
import { AlertCircle, Check, ChevronRight, ExternalLink, Loader2, Search } from 'lucide-react';
import {
  disconnectGoogle,
  fetchGooglePerformance,
  fetchGoogleSites,
  fetchGoogleStatus,
  selectGoogleSite,
  startGoogleConnect,
  type SearchConsolePerformance,
  type SearchConsoleSite,
  type SearchConsoleStatus,
} from '../../data/google.repository';
import { searchConsoleHealth } from '../../data/googleHealth';
import { useReportDays } from '../../data/reportWindow';
import { ApiError } from '../../lib/api';
import { ReportWindowPicker } from '../workflows/ReportWindowPicker';
import { Button, StatusBadge } from '../workflows/WorkflowPrimitives';

/**
 * ─── Google Search Console connector ─────────────────────────────────
 *
 * Every value shown here is read from the real Search Console API in the request that renders it.
 * There is no sample property, no placeholder metric, and nothing is displayed for a store that
 * has not connected — the card says so instead.
 *
 * THREE STATES, because each needs something different from the merchant and collapsing them would
 * leave someone stuck:
 *
 *   not configured          The SERVER has no Google OAuth credentials. Nothing the merchant can
 *                           do, so no Connect button is offered — an operator has to add them.
 *   connected, no property  Authorised, but the account has several verified sites and none is
 *                           chosen. Picking one automatically would silently report another
 *                           domain's traffic as this store's.
 *   connected + property    Real numbers.
 */

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function formatPosition(position: number): string {
  return position > 0 ? position.toFixed(1) : '—';
}

/**
 * Why the status read failed, in words that point at the fix.
 *
 * The card used to answer every failure with one line — "Could not read the connection state" —
 * and that line covered a stopped API, an unmigrated database, an expired session and an account
 * with no store. None of those has the same remedy, and the card also renders NOTHING else in the
 * error state, so the Connect button disappears too: the merchant is left with a dead card and a
 * Retry that will fail identically until someone reads a server log.
 *
 * The server already sends a message and a status. Showing them is strictly more useful than
 * hiding them, and none of these paths carries a credential — the Google service deliberately
 * returns codes rather than Google's own error text for exactly that reason.
 */
function describeLoadFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    // fetch() itself rejected: wrong origin, API process down, or no network at all.
    return 'Could not reach the Rankvora AI API. Check that the backend is running and that the app is pointed at it.';
  }

  // Two different 404s reach here and they have opposite fixes, so the CODE decides rather than
  // the status: getCurrentStoreId() throws STORE_NOT_FOUND for an account that owns no store,
  // while a bare 404 means the route itself is absent — an API still serving a build from before
  // /api/google existed. The second is an operator's deploy step, not anything a merchant can do.
  if (error.status === 404) {
    return error.code === 'STORE_NOT_FOUND'
      ? 'This account has no store yet. Create or connect a store first — Search Console is read per store.'
      : 'This server has no Google Search Console endpoint. The API is running an older build — redeploy and restart it.';
  }

  switch (error.status) {
    case 401:
      return 'Your session has expired. Open Rankvora AI again from your Shopify admin.';
    case 503:
      return 'Google Search Console is not configured on this server yet.';
    default:
      return error.status >= 500
        ? `The server could not read the connection state (HTTP ${error.status}). ${error.message}`
        : error.message;
  }
}

/**
 * Why the PROPERTY LIST could not be read.
 *
 * Kept apart from the status failure above because the card must not answer it with "this Google
 * account has no verified Search Console properties" — a claim about the merchant's Google account
 * that Rankvora AI has no basis for when the call never returned a list. An empty list and an
 * unanswered one look identical in state and mean opposite things.
 */
function describeSiteListFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the Rankvora AI API to list this account’s properties.';
  }
  switch (error.status) {
    case 401:
      return 'Google would not accept this connection when listing properties. Reconnect Google, then choose a property.';
    case 403:
      // Account-level, so it is not "no access to that property" — the usual cause is the Search
      // Console API being off for the server's Google Cloud project.
      return 'Google refused to list this account’s Search Console properties. Check that the Search Console API is enabled for this server’s Google Cloud project.';
    case 409:
      return 'The Google connection ended before the properties could be listed. Connect Google again.';
    default:
      return error.message;
  }
}

interface GoogleSearchConsoleCardProps {
  /**
   * Called whenever this card has just changed what is known about the connection — a read, a
   * refusal, a property chosen, a disconnect. The Integrations page re-reads its catalogue on it, so
   * this card and the catalogue card below it never describe the same connector differently.
   */
  onHealthChange?: () => void;
  /** Called after a disconnect. Search Console and Analytics ride on one Google grant, so ending it
   * here ends Analytics too — and the page has to tell that card. */
  onDisconnected?: () => void;
}

export default function GoogleSearchConsoleCard({ onHealthChange, onDisconnected }: GoogleSearchConsoleCardProps = {}) {
  const [status, setStatus] = useState<SearchConsoleStatus | null>(null);
  const [sites, setSites] = useState<SearchConsoleSite[]>([]);
  /** Whether Google actually answered with a list. False = not asked yet, or the ask failed. */
  const [sitesLoaded, setSitesLoaded] = useState(false);
  /** Why the property list could not be read. Empty = it was read, however many it held. */
  const [sitesError, setSitesError] = useState('');
  /** The property currently being submitted, so its own row says so rather than the whole list. */
  const [selecting, setSelecting] = useState<string | null>(null);
  const [performance, setPerformance] = useState<SearchConsolePerformance | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Why the status read failed. Separate from `error`, which is about an action the merchant took. */
  const [loadError, setLoadError] = useState('');
  /** Shared with Analytics beside it and with the AI referrals card — see data/reportWindow.ts. */
  const days = useReportDays();

  // Held in refs so `load` keeps a stable identity. Depending on the callbacks directly would re-run
  // the mount effect — and so re-read Google — every time a parent passed a new function.
  const onHealthChangeRef = useRef(onHealthChange);
  const onDisconnectedRef = useRef(onDisconnected);
  useEffect(() => {
    onHealthChangeRef.current = onHealthChange;
    onDisconnectedRef.current = onDisconnected;
  });

  /**
   * Reads the properties this Google account can offer.
   *
   * NEVER THROWS. A listing that failed is a state the picker renders — with the reason and a
   * retry — not a reason to blank the card down to one error line, which is what hid the Connect
   * and Disconnect actions and left "no verified properties" on screen as if it were Google's answer.
   */
  const loadSites = useCallback(async () => {
    setSitesError('');
    try {
      setSites(await fetchGoogleSites());
      setSitesLoaded(true);
    } catch (err) {
      // Not an empty list: nothing was learned about this account, so nothing is claimed about it.
      setSites([]);
      setSitesLoaded(false);
      setSitesError(describeSiteListFailure(err));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setState('loading');
      setLoadError('');
      const next = await fetchGoogleStatus();
      setStatus(next);

      // Only asked for once there is a connection to ask with. Both calls reach Google, so a store
      // that has not connected must not trigger them at all.
      if (next.connected) {
        try {
          if (next.siteUrl) setPerformance(await fetchGooglePerformance(days));
          else await loadSites();
        } finally {
          // Either call just changed this provider's health: a read stamps its read time, a refusal
          // records why, and listing properties clears an old refusal. The status above was read
          // BEFORE that, so it is read again — otherwise a successful Refresh left the badge on
          // "Not verified" until the page was reloaded.
          setStatus(await fetchGoogleStatus());
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
  }, [loadSites, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConnect() {
    setBusy(true);
    setError('');
    try {
      // Navigates away to Google's consent screen. Nothing is connected until Google redirects back
      // and the SERVER has exchanged the code — this client never sees a token.
      await startGoogleConnect();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? 'Google Search Console is not configured on this server yet.'
          : 'We could not start the Google connection. Please try again.',
      );
      setBusy(false);
    }
  }

  async function handleSelectSite(siteUrl: string) {
    setBusy(true);
    setSelecting(siteUrl);
    setError('');
    try {
      setStatus(await selectGoogleSite(siteUrl));
      setPerformance(await fetchGooglePerformance(days));
    } catch (err) {
      setError(
        err instanceof ApiError && [400, 401, 403, 409].includes(err.status)
          ? err.message
          : 'We could not read that property. Please try again.',
      );
    } finally {
      // The status the selection returned predates the read that followed it: a success stamped a
      // read time, a refusal recorded why. Read again so the badge describes what just happened.
      try {
        setStatus(await fetchGoogleStatus());
      } catch {
        // The selection's own status is already on screen, and the next load will correct it.
      }
      setSelecting(null);
      setBusy(false);
      onHealthChangeRef.current?.();
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError('');
    let disconnected = false;
    try {
      setStatus(await disconnectGoogle());
      setSites([]);
      setPerformance(null);
      disconnected = true;
    } catch {
      setError('We could not disconnect right now. Please try again.');
    } finally {
      setBusy(false);
      onHealthChangeRef.current?.();
      if (disconnected) onDisconnectedRef.current?.();
    }
  }

  // The same verdict the Integrations catalogue and Settings show for this connector, so this badge
  // cannot disagree with them. Pure — derived from the status already on screen.
  const health = status ? searchConsoleHealth(status) : null;

  if (state === 'loading' && !status) {
    return (
      <article className="rounded-lg border border-surface-200 bg-surface-0 p-3">
        <div className="flex items-center gap-2 text-[12px] text-surface-500">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          Checking Google Search Console…
        </div>
      </article>
    );
  }

  return (
    <article className="flex h-full flex-col rounded-lg border border-surface-200 bg-surface-0 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 gap-2.5">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-100 text-surface-700">
            <Search size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[12.5px] font-bold text-surface-950">Google Search Console</h3>
            <p className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">
              The only source for what actually happened in search — which queries brought people in,
              how often pages were shown, and where they ranked.
            </p>
          </div>
        </div>

        {/* Was a green "Connected" the moment Google consent completed — before a property was chosen
            or a single number read. The verdict says "Working" only once Google has answered a read. */}
        {health && <StatusBadge label={health.badge.label} tone={health.badge.tone} />}
      </div>

      {state === 'error' && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-critical-200 bg-critical-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-critical-800">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            {loadError}{' '}
            <button type="button" onClick={() => void load()} className="cursor-pointer font-semibold underline underline-offset-2">Retry</button>
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-critical-200 bg-critical-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-critical-800">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* Google refused the last read — revoked access, or the property is gone. Surfaced because
          the alternative is a card that says "Connected" beside no data and explains nothing. */}
      {status?.lastError && (
        <p className="mt-2 rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-warning-800">
          {status.lastError}
        </p>
      )}

      {/* ── Not configured: an operator problem, not a merchant one ─── */}
      {status && !status.configured && (
        <p className="mt-2 rounded-md bg-surface-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-surface-600">
          Not available on this server yet — Google OAuth credentials have not been configured. No
          Connect button is shown because there is nothing behind it.
        </p>
      )}

      {/* ── Configured, not connected ─────────────────────────────── */}
      {status?.configured && !status.connected && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          <p className="text-[11.5px] leading-[1.4] text-surface-500">
            Rankvora AI requests read-only access. It can read your search performance and cannot change
            anything in Search Console.
          </p>
          <div className="mt-2">
            <Button onClick={() => void handleConnect()} disabled={busy}>
              {busy ? 'Opening Google…' : 'Connect Google Search Console'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Connected, no property chosen ─────────────────────────── */}
      {status?.connected && !status.siteUrl && (
        <div className="mt-2.5 border-t border-surface-100 pt-2.5">
          {/* Named as the outstanding STEP, not as a heading over a list. The previous wording sat
              above rows that looked exactly like the read-only fields elsewhere on this page, so
              the badge said "Setup incomplete" while the screen appeared to be reporting a property
              that was already in use — and the one action left was invisible. */}
          <p className="text-[12px] font-semibold text-surface-800">One step left — choose the property for this store</p>
          <p className="mt-0.5 text-[11.5px] leading-[1.4] text-surface-500">
            {/* Never chosen automatically: an account with several verified sites would otherwise
                have another domain's traffic reported as this store's. */}
            Connected as {status.googleEmail ?? 'your Google account'}. Rankvora AI will not pick for
            you — on an account with several verified sites that would report another domain's
            traffic as this store's. Select one below to finish setup.
          </p>

          {sitesError ? (
            // The listing failed. Saying "no verified properties" here would invent Google's
            // answer out of a call that never returned one.
            <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-critical-200 bg-critical-50 px-2.5 py-2 text-[11.5px] leading-[1.4] text-critical-800">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>
                {sitesError}{' '}
                <button type="button" onClick={() => void loadSites()} className="cursor-pointer font-semibold underline underline-offset-2">Retry</button>
              </span>
            </p>
          ) : !sitesLoaded ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-surface-500">
              <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Reading the properties on this Google account…
            </p>
          ) : sites.length === 0 ? (
            // Google answered, and the answer was none. Only reachable once a list came back.
            <p className="mt-2 text-[11.5px] leading-[1.4] text-surface-500">
              This Google account has no verified Search Console properties. Verify your domain in
              Search Console first, then{' '}
              <button type="button" onClick={() => void loadSites()} className="cursor-pointer font-semibold text-brand-600 underline underline-offset-2">check again</button>.
            </p>
          ) : (
            // Scrolls for the same reason the results below do: an agency account can have
            // dozens of verified properties, and an un-capped list pushes the card past the fold
            // before the merchant reaches the one they want.
            <ul ref={scrollChaining} className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {sites.map((site) => (
                <li key={site.siteUrl}>
                  <button
                    type="button"
                    onClick={() => void handleSelectSite(site.siteUrl)}
                    disabled={busy}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-surface-200 bg-surface-0 px-2.5 py-2 text-left transition-colors hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {/* A radio, so the row reads as one of several choices rather than as a field
                        stating a value. */}
                    <span aria-hidden="true" className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-surface-300 transition-colors group-hover:border-brand-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-transparent transition-colors group-hover:bg-brand-600" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] text-surface-800">{site.siteUrl}</span>
                      <span className="block text-[10.5px] text-surface-500">Your access: {site.permissionLevel}</span>
                    </span>
                    {/* The action, spelled out. This is what was missing: the row was already a
                        button, and nothing on screen said so. */}
                    <span className="flex flex-shrink-0 items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[10.5px] font-semibold text-surface-0">
                      {selecting === site.siteUrl ? (
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
      {/* `flex-1 flex-col` so the action row below can take `mt-auto` and sit on the card's floor.
          The two Google cards are equal height now, and without this the shorter one's buttons
          floated mid-card while its neighbour's sat at the bottom. */}
      {status?.connected && status.siteUrl && (
        <div className="mt-2.5 flex flex-1 flex-col border-t border-surface-100 pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-surface-700">{status.siteUrl}</p>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {/* Changes the period for Analytics beside it and for the AI referrals card too: one
                  value, so the page can never put a 90-day figure next to a 28-day one. The DATES
                  differ between the two cards even so — Search Console finalises a day later than
                  GA4 — which is why each card prints the range it was actually answered for. */}
              <ReportWindowPicker value={days} disabled={busy || state === 'loading'} label="Search Console reporting period" />
              {performance && (
                // The dates Google actually answered for. Search Console lags about three days, so a
                // range ending today would show an empty tail that reads as a collapse in traffic.
                <p className="text-[10.5px] text-surface-500">{performance.startDate} to {performance.endDate}</p>
              )}
            </div>
          </div>

          {performance ? (
            <>
              {/* All four on ONE row from `sm`, which is every width the two-column layout uses —
                  the headline figures are read across, and stacking them 2x2 cost a whole row of
                  card height to no benefit. Two-up below `sm`, where four tiles on a phone would
                  leave ~65px per label and clip every one of them.

                  The labels truncate with a title rather than wrapping: a wrapped label pushes its
                  own tile taller than its neighbours and breaks the row's baseline. */}
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { label: 'Clicks', value: performance.totals.clicks.toLocaleString() },
                  { label: 'Impressions', value: performance.totals.impressions.toLocaleString() },
                  { label: 'CTR', value: formatPercent(performance.totals.ctr) },
                  { label: 'Avg position', value: formatPosition(performance.totals.position) },
                ].map((tile) => (
                  <div key={tile.label} className="min-w-0 rounded-md bg-surface-50 px-2.5 py-1.5">
                    <p className="truncate text-[10px] font-bold uppercase tracking-[0.1em] text-surface-500" title={tile.label}>{tile.label}</p>
                    <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-surface-900">{tile.value}</p>
                  </div>
                ))}
              </div>

              {performance.totals.impressions === 0 && (
                // A real zero, said plainly. Not an error, and not dressed up as one.
                <p className="mt-2 text-[11.5px] leading-[1.4] text-surface-500">
                  Google recorded no impressions for this property in this period. That is the real
                  figure, not a connection problem.
                </p>
              )}

              {performance.topQueries.length > 0 && (
                <div className="mt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Top queries</p>
                    {/* The real count Google returned, so the list never looks like the whole story
                        when it is not. It is also what tells a merchant the box scrolls. */}
                    <p className="text-[10.5px] tabular-nums text-surface-400">{performance.topQueries.length} returned</p>
                  </div>
                  {/*
                    SCROLLS, and shows every row Google sent rather than the first five.

                    A store that ranks for five terms today ranks for hundreds later, and the old
                    `.slice(0, 5)` silently discarded the rest of a response the API had already
                    paid for — the backend asks for up to 100 rows. Capping the BOX instead of the
                    DATA means the card keeps its height on this page whatever the catalogue grows
                    to, and the queries below the fifth are a scroll away instead of invisible.
                  */}
                  <ul ref={scrollChaining} className="mt-1 max-h-44 overflow-y-auto divide-y divide-surface-100 pr-0.5">
                    {performance.topQueries.map((row) => (
                      <li key={row.key} className="flex items-center justify-between gap-2 py-1">
                        <span className="min-w-0 truncate text-[12px] text-surface-800" title={row.key}>{row.key}</span>
                        <span className="flex-shrink-0 text-[11px] tabular-nums text-surface-500">
                          {row.clicks.toLocaleString()} clicks · pos {formatPosition(row.position)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="mt-2 text-[11.5px] text-surface-500">Loading search performance…</p>
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
            <Button variant="danger" onClick={() => void handleDisconnect()} disabled={busy}>
              {busy ? 'Working…' : 'Disconnect'}
            </Button>
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-600 underline-offset-2 hover:underline"
            >
              {/* Disconnecting destroys Rankvora AI's copy of the tokens. Revoking the grant itself is
                  something only the merchant can do, and only at Google — so the link is here. */}
              Revoke at Google <ExternalLink size={11} aria-hidden="true" />
            </a>
          </div>
        </div>
      )}

      {status?.connected && status.lastSyncedAt && (
        <p className="mt-2 flex items-center gap-1 text-[10.5px] text-surface-400">
          <Check size={11} aria-hidden="true" />
          Last read {new Date(status.lastSyncedAt).toLocaleString()}
        </p>
      )}
    </article>
  );
}
