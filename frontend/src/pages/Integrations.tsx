import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, CheckCircle2, Cloud, Database, Info, Link2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import {
  fetchConnectorHealth,
  fetchIntegrations,
  overlayConnectorHealth,
  type ConnectorHealthMap,
  type HealthCheckedProvider,
  type IntegrationRecord,
} from '../data/integrations.repository';
import { isPillarVisible } from '../config/modules';
import { isEmbedded } from '../lib/embedded';
import { isGoogleProvider } from '../data/googleHealth';
import { PAGESPEED_PROVIDER } from '../data/pagespeedHealth';
import {
  beginShopifyInstall,
  describeConnectOutcome,
  describeShopifyError,
  disconnectShopify,
  fetchShopifyStatus,
  normalizeShopDomain,
  syncShopifyStore,
  type ShopifyStatus,
} from '../data/shopify.repository';
import { Button, Drawer, MetricTile, ModuleHeader, SectionHeading, StatusBadge } from '../components/workflows/WorkflowPrimitives';
import GoogleSearchConsoleCard from '../components/integrations/GoogleSearchConsoleCard';
import GoogleAnalyticsCard from '../components/integrations/GoogleAnalyticsCard';
import PageSpeedCard from '../components/integrations/PageSpeedCard';
import { describeGoogleOutcome } from '../data/google.repository';

type IntegrationStatus = IntegrationRecord['status'];

const statusTone: Record<IntegrationStatus, 'success' | 'warning' | 'neutral'> = { Connected: 'success', 'Needs Attention': 'warning', 'Not Connected': 'neutral' };
const iconMap: Record<string, typeof Cloud> = { Store: Database, Analytics: Cloud, Performance: ShieldCheck, 'AI / Discovery': Link2 };

interface Banner {
  tone: 'success' | 'error' | 'info';
  message: string;
}

const bannerStyles: Record<Banner['tone'], { wrap: string; icon: typeof Info }> = {
  success: { wrap: 'border-success-100 bg-success-50 text-success-800', icon: CheckCircle2 },
  error: { wrap: 'border-critical-100 bg-critical-50 text-critical-800', icon: AlertCircle },
  info: { wrap: 'border-info-100 bg-info-50 text-info-800', icon: Info },
};

export default function Integrations() {
  // The catalogue as the API returned it. What renders is `records`, below, with each connector's
  // verdict applied — held apart so a health refresh never needs the catalogue re-read.
  const [baseRecords, setBaseRecords] = useState<IntegrationRecord[]>([]);
  const [connectorHealth, setConnectorHealth] = useState<ConnectorHealthMap>({});
  const [shopify, setShopify] = useState<ShopifyStatus | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>('loading');
  const [selected, setSelected] = useState<IntegrationRecord | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<'connecting' | 'syncing' | 'disconnecting' | null>(null);
  const [shopInput, setShopInput] = useState('');
  const [shopInputError, setShopInputError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  /**
   * Bumped when the Google grant is ended from the Search Console card. Analytics rides on the same
   * grant, so its card is remounted on it — otherwise it keeps showing a connection that is gone.
   */
  const [googleGrantEpoch, setGoogleGrantEpoch] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();

  const records = useMemo(() => overlayConnectorHealth(baseRecords, connectorHealth), [baseRecords, connectorHealth]);

  const load = useCallback(async () => {
    try {
      const [integrationRecords, shopifyStatus, health] = await Promise.all([
        fetchIntegrations(),
        fetchShopifyStatus(),
        // Never rejects — each connector's status settles on its own — so one endpoint that is
        // down cannot take the whole Integrations page down with it.
        fetchConnectorHealth(),
      ]);
      setBaseRecords(integrationRecords);
      setShopify(shopifyStatus);
      setConnectorHealth(health);
      setLoadState('success');
    } catch (error) {
      console.error('Failed to load integrations', error);
      setLoadState('error');
    }
  }, []);

  /** Re-reads only the verdicts. The connector cards call it after they touch their data source. */
  const refreshConnectorHealth = useCallback(async () => {
    setConnectorHealth(await fetchConnectorHealth());
  }, []);

  /**
   * The verdict for the connector open in the drawer, read live rather than from the record captured
   * when it was clicked — so a read finishing behind the drawer updates what the drawer says.
   */
  const selectedHealth = selected && (isGoogleProvider(selected.id) || selected.id === PAGESPEED_PROVIDER)
    ? connectorHealth[selected.id as HealthCheckedProvider]
    : undefined;

  useEffect(() => {
    load();
  }, [load]);

  // The OAuth callback redirects the browser back here with the outcome. Read it once, show it,
  // then strip it from the URL so a refresh does not replay a stale "connected" banner.
  useEffect(() => {
    // Both OAuth callbacks land here, each with its own parameter. Handled in one effect so the
    // `reason` key — which they share — is stripped exactly once however the merchant arrived.
    const shopifyOutcome = searchParams.get('shopify');
    const googleOutcome = searchParams.get('google');
    if (!shopifyOutcome && !googleOutcome) return;

    const described = shopifyOutcome
      ? describeConnectOutcome(shopifyOutcome, searchParams.get('reason'))
      : describeGoogleOutcome(googleOutcome, searchParams.get('reason'));
    if (described) setBanner(described);

    const next = new URLSearchParams(searchParams);
    next.delete('shopify');
    next.delete('google');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const groups = useMemo(() => [...new Set(records.map((record) => record.group))], [records]);
  const connected = records.filter((record) => record.status === 'Connected').length;
  const attention = records.filter((record) => record.status === 'Needs Attention').length;
  const availableCount = records.filter((record) => record.available).length;

  const startConnect = async () => {
    const shopDomain = normalizeShopDomain(shopInput);
    if (!shopDomain) {
      setShopInputError('Enter your store address, for example my-store.myshopify.com');
      return;
    }
    setShopInputError(null);
    setBusy('connecting');
    try {
      // Navigates away to Shopify's permission screen; nothing is connected until Shopify
      // redirects back and the backend verifies the signed callback.
      await beginShopifyInstall(shopDomain);
    } catch (error) {
      setBusy(null);
      setBanner({ tone: 'error', message: describeShopifyError(error) });
    }
  };

  const runSync = async () => {
    setBusy('syncing');
    setBanner(null);
    try {
      const summary = await syncShopifyStore();
      const partial = summary.truncated.length > 0 ? ` Scope limit reached for ${summary.truncated.join(', ')}.` : '';
      setBanner({
        tone: 'success',
        message:
          `Synced ${summary.products} products, ${summary.collections} collections, ` +
          `${summary.pages} pages and ${summary.articles} articles from your store.${partial}`,
      });
      await load();
    } catch (error) {
      // A failed sync says so. It never leaves the previous success on screen.
      setBanner({ tone: 'error', message: describeShopifyError(error) });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const runDisconnect = async () => {
    setBusy('disconnecting');
    try {
      setShopify(await disconnectShopify());
      setConfirmingDisconnect(false);
      setSelected(null);
      setBanner({ tone: 'info', message: 'Shopify disconnected. Your previous audit history has been kept.' });
      await load();
    } catch (error) {
      setBanner({ tone: 'error', message: describeShopifyError(error) });
    } finally {
      setBusy(null);
    }
  };

  if (loadState === 'loading') {
    return <div className="page-shell text-[12.5px] text-surface-500">Loading integrations…</div>;
  }

  if (loadState === 'error') {
    return <div className="page-shell text-[12.5px] text-critical-600">Failed to load integrations. Please try again.</div>;
  }

  return (
    <div className="page-shell section-stack">
      <ModuleHeader
        eyebrow="Data connections"
        title="Integrations"
        description="Connect your data sources to give Rankvora AI the information it needs to analyze your store."
        actions={<Button onClick={() => setIsAdding(true)}><Link2 size={15} />Add integration</Button>}
      />

      {banner && <BannerNotice banner={banner} onDismiss={() => setBanner(null)} />}

      <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Integration summary">
        <MetricTile label="Connected" value={connected} detail="Data sources active" tone="success" />
        <MetricTile label="Needs attention" value={attention} detail="Action recommended" tone="warning" />
        <MetricTile label="Available now" value={availableCount} detail="Connectors you can use" />
        <MetricTile label="Last Shopify sync" value={shopify?.lastSyncedAt ? new Date(shopify.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never'} detail="Most recent store read" tone="info" />
      </section>

      <ShopifyPanel
        status={shopify}
        busy={busy}
        shopInput={shopInput}
        shopInputError={shopInputError}
        onShopInputChange={(value) => { setShopInput(value); setShopInputError(null); }}
        onConnect={startConnect}
        onSync={runSync}
        onRequestDisconnect={() => setConfirmingDisconnect(true)}
      />

      {/* Their own panels beside Shopify's, not cards in the catalogue grid below. Both are real
          OAuth connectors with their own state — connect, choose a property, read live data,
          disconnect — and neither fits the one-line "View details" card the remaining providers
          use, which exists precisely because those have no connector behind them. They ride on the
          SAME Google grant, which is why Analytics is remounted when Search Console ends it.

          Each reports back after touching Google, so the catalogue card, the drawer and the counts
          above re-read that connector's verdict instead of keeping the one from page load.

          SIDE BY SIDE FROM `lg`: they answer the two halves of one question — what brought people
          in, and what they did next — and they are read by comparing them, which stacking made
          impossible without scrolling past one to reach the other.

          EQUAL HEIGHT, via the grid's default `stretch`. This was `items-start`, which let each
          card keep its natural height — and because Search Console carries a scrolling query list
          and three actions while Analytics carries neither, the pair ended in a ragged step with
          empty page showing beside the taller one. Two cards that are read as a pair should read
          as a pair. */}
      <div className="grid gap-2 lg:grid-cols-2">
        <GoogleSearchConsoleCard
          onHealthChange={() => void refreshConnectorHealth()}
          onDisconnected={() => setGoogleGrantEpoch((epoch) => epoch + 1)}
        />
        <GoogleAnalyticsCard key={googleGrantEpoch} onHealthChange={() => void refreshConnectorHealth()} />
      </div>

      {/* Beside the other two rather than in the catalogue grid, and for the same reason: it is a
          real connector with its own state. It is NOT a Google OAuth connector though — PageSpeed
          Insights measures a public url and asks for no account — so it has no Connect action and
          is unaffected by the grant above. What it needs is a Shopify store, because the storefront
          is what it measures. */}
      <PageSpeedCard onHealthChange={() => void refreshConnectorHealth()} />

      {groups.map((group) => {
        const GroupIcon = iconMap[group] ?? Database;
        const groupRecords = records.filter((record) => record.group === group);
        return (
          <section key={group} className="space-y-2" aria-labelledby={`${group}-integrations`}>
            <SectionHeading eyebrow="Connection group" title={group} />
            {/* Three across from `sm` up, because every group holds three or fewer providers and
                the previous md:2 / xl:3 left the third alone on its own row at most window
                widths — a lone card beside dead space, which reads as a layout fault rather than
                as a set. */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groupRecords.map((record) => (
                <article key={record.id} className="group flex flex-col rounded-lg border border-surface-200 bg-surface-0 p-2.5 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)] transition hover:-translate-y-0.5 hover:border-brand-200">
                  {/* Icon, name and status on ONE line. Stacking them cost a full row of height
                      per card for an icon that identifies nothing the name does not. */}
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-surface-100 text-surface-700"><GroupIcon size={14} /></span>
                    <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-surface-950">{record.name}</h3>
                    {record.available
                      // A Google connector carries its own verdict — "Not verified", "Choose a
                      // property" — which the three-way status cannot express.
                      ? <StatusBadge label={record.badge?.label ?? record.status} tone={record.badge?.tone ?? statusTone[record.status]} />
                      : <StatusBadge label="Coming soon" tone="neutral" />}
                  </div>

                  {/* line-clamp rather than a min-height: the cards align on their own because the
                      action below is pushed to the bottom, so reserving space here only padded
                      every card to fit the longest description in the group. */}
                  <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-[1.4] text-surface-500">{record.description}</p>

                  {record.notice && <p className="mt-1.5 rounded-md bg-warning-50 px-2 py-1 text-[11px] font-medium leading-[1.4] text-warning-700">{record.notice}</p>}

                  {/* Label and value on one line. Stacked, this was two rows to say "Not connected". */}
                  <div className="mt-2 flex items-baseline gap-1.5 border-t border-surface-100 pt-2">
                    <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">{record.status === 'Connected' ? 'Synced' : 'Connection'}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-surface-800">{record.status === 'Connected' ? record.lastSynced : record.detail}</span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {record.data.slice(0, 2).map((item) => <span key={item} className="rounded bg-surface-100 px-1.5 py-0.5 text-[10.5px] text-surface-600">{item}</span>)}
                  </div>

                  {/* mt-auto pins the action to the card's floor, so buttons share a baseline
                      across a row whatever each description ran to. */}
                  <div className="mt-auto flex items-center gap-2 pt-2">
                    {record.available
                      ? <Button variant="secondary" onClick={() => setSelected(record)}>View details</Button>
                      // No Connect action without a connector behind it. The previous build offered
                      // one for all six providers and "connected" them by writing a status column.
                      : <p className="text-[11.5px] leading-[1.4] text-surface-500">Connector not available yet.</p>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}

      <Drawer open={Boolean(selected)} title={selected?.name ?? ''} eyebrow="Integration detail" onClose={() => setSelected(null)}>
        {selected && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <StatusBadge
                label={selectedHealth?.badge.label ?? selected.badge?.label ?? selected.status}
                tone={selectedHealth?.badge.tone ?? selected.badge?.tone ?? statusTone[selected.status]}
              />
              <StatusBadge label={selected.group} tone="neutral" />
            </div>

            {selectedHealth && <p className="text-[12px] leading-[1.45] text-surface-700">{selectedHealth.summary}</p>}

            <div className="rounded-md border border-surface-200 bg-surface-50 px-2.5 py-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Account / store</p>
              <p className="mt-0.5 text-[12px] font-bold text-surface-900">{selectedHealth?.account ?? selected.detail}</p>
              <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Last read</p>
              <p className="mt-0.5 text-[12px] text-surface-700">{selected.lastSynced}</p>
            </div>

            {/* The connector's own checks, in the order they have to be fixed — what is actually
                standing between this store and real data, rather than a list of what it could send. */}
            {selectedHealth ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Connection checks</p>
                <ul className="mt-1.5 space-y-1">
                  {selectedHealth.checks.map((check) => (
                    <li key={check.label} className="flex gap-2 text-[12px]">
                      {check.outcome === 'pass' ? (
                        <Check size={14} className="mt-px flex-shrink-0 text-success-600" aria-hidden="true" />
                      ) : check.outcome === 'fail' ? (
                        <AlertCircle size={14} className="mt-px flex-shrink-0 text-critical-600" aria-hidden="true" />
                      ) : (
                        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-surface-300" />
                      )}
                      <span className="min-w-0">
                        <span className={`block font-semibold ${check.outcome === 'fail' ? 'text-critical-700' : 'text-surface-800'}`}>
                          {check.label}
                        </span>
                        <span className="block text-[11.5px] leading-[1.4] text-surface-500">{check.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div>
                {/* "Data received" only where something was received: a green tick beside a connector
                    that has never been read claims data nobody sent. */}
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">
                  {selected.lastSynced === 'Never synced' ? 'Data this connector provides' : 'Data received'}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {selected.data.map((item) => (
                    <li key={item} className="flex gap-2 text-[12px] text-surface-700">
                      {selected.lastSynced === 'Never synced'
                        ? <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-surface-300" />
                        : <Check size={14} className="mt-px flex-shrink-0 text-success-600" aria-hidden="true" />}
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selected.id === 'shopify' && shopify?.scopes.length ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Permissions granted</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {shopify.scopes.map((scope) => <span key={scope} className="rounded bg-surface-100 px-1.5 py-0.5 font-mono text-[10.5px] text-surface-600">{scope}</span>)}
                </div>
              </div>
            ) : null}

            {selectedHealth?.nextStep && (
              <p className="rounded-md border border-warning-100 bg-warning-50 px-2.5 py-2 text-[11.5px] leading-[1.45] text-warning-800">
                {selectedHealth.nextStep}
              </p>
            )}

            <p className="text-[11px] leading-[1.4] text-surface-500">
              {selected.id === 'shopify'
                ? 'Manage this connection from the Shopify panel above.'
                : selectedHealth
                  // Said plainly, rather than the old "not available yet" — untrue of both Google
                  // connectors, which are available and each have a panel on this page.
                  ? `Manage this connection from the ${selected.name} panel above.`
                  : 'This connector is not available yet. Nothing is connected.'}
            </p>
          </div>
        )}
      </Drawer>

      <Drawer open={isAdding} title="Add an integration" eyebrow="Available data sources" onClose={() => setIsAdding(false)}>
        <div className="space-y-2">
          {records.filter((record) => record.available && record.status === 'Not Connected').map((record) => (
            <button
              key={record.id}
              onClick={() => { setIsAdding(false); setSelected(null); document.getElementById('shopify-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
              className="flex w-full items-center gap-2.5 rounded-lg border border-surface-200 p-2.5 text-left transition hover:border-brand-200 hover:bg-brand-50"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-surface-100"><Database size={16} /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-surface-900">{record.name}</p>
                <p className="mt-0.5 text-[11px] leading-[1.4] text-surface-500">{record.description}</p>
              </div>
              <span aria-hidden="true" className="text-surface-400">&#8250;</span>
            </button>
          ))}
          <div className="rounded-md bg-surface-50 px-2.5 py-2 text-[11px] leading-[1.4] text-surface-500">
            {records.some((record) => record.available && record.status === 'Not Connected')
              ? 'Only Shopify has a live connector today. The remaining providers are listed on this page and will become connectable as their connectors ship.'
              : 'Every available connector is already set up. The remaining providers will become connectable as their connectors ship.'}
          </div>
        </div>
      </Drawer>

      <Drawer open={confirmingDisconnect} title="Disconnect Shopify?" eyebrow="Confirm" onClose={() => setConfirmingDisconnect(false)}>
        <div className="space-y-2">
          <p className="text-[12.5px] leading-[1.45] text-surface-700">
            Rankvora AI will delete its stored Shopify credentials and stop reading data from
            <span className="font-semibold text-surface-900"> {shopify?.shopDomain}</span>. New audits cannot run until you reconnect.
          </p>
          <p className="text-[12.5px] leading-[1.45] text-surface-700">
            Your existing audit history, findings and reports are kept — disconnecting does not delete past analysis.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={runDisconnect} disabled={busy === 'disconnecting'}>
              <Unplug size={15} />{busy === 'disconnecting' ? 'Disconnecting…' : 'Yes, disconnect'}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingDisconnect(false)}>Cancel</Button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}

function BannerNotice({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  const { wrap, icon: Icon } = bannerStyles[banner.tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 ${wrap}`} role="status">
      <Icon size={15} className="mt-px shrink-0" />
      <p className="flex-1 text-[12px] leading-[1.4]">{banner.message}</p>
      <button type="button" onClick={onDismiss} className="text-[11px] font-semibold underline underline-offset-2">Dismiss</button>
    </div>
  );
}

interface ShopifyPanelProps {
  status: ShopifyStatus | null;
  busy: 'connecting' | 'syncing' | 'disconnecting' | null;
  shopInput: string;
  shopInputError: string | null;
  onShopInputChange: (value: string) => void;
  onConnect: () => void;
  onSync: () => void;
  onRequestDisconnect: () => void;
}

/**
 * The one connector with a real backend. Every value shown here comes from GET /shopify/status —
 * the page has no local notion of "connected", so it cannot display a connection that does not
 * exist, or a sync time for a sync that never ran.
 */
function ShopifyPanel({ status, busy, shopInput, shopInputError, onShopInputChange, onConnect, onSync, onRequestDisconnect }: ShopifyPanelProps) {
  if (!status) return null;

  const summary = status.lastSyncSummary;

  return (
    <section id="shopify-panel" className="scroll-mt-6 rounded-lg border border-surface-200 bg-surface-0 p-2.5 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-100 text-surface-700"><Database size={18} /></div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-bold text-surface-950">Shopify</h2>
            <p className="mt-0.5 max-w-xl text-[11.5px] leading-[1.4] text-surface-500">
              {isPillarVisible('cro')
                ? 'Connect your Shopify store to analyze SEO, content, performance, CRO and AI readiness.'
                : 'Connect your Shopify store to analyze SEO, content, performance and AI readiness.'}
            </p>
          </div>
        </div>
        <StatusBadge
          label={
            status.status === 'connected' ? 'Connected'
              : status.status === 'reauthorization_required' ? 'Reauthorization required'
              : status.status === 'error' ? 'Sync failed'
              : 'Not connected'
          }
          tone={status.status === 'connected' ? 'success' : status.status === 'not_connected' ? 'neutral' : 'warning'}
        />
      </div>

      {!status.configured && (
        <p className="mt-2 rounded-md border border-warning-100 bg-warning-50 px-2.5 py-1.5 text-[11px] leading-[1.4] text-warning-800">
          Shopify is not configured on this server yet. An administrator needs to add the app credentials before stores can be connected.
        </p>
      )}

      {status.status === 'not_connected' && isEmbedded() ? (
        // Inside the Shopify admin the store is connected by opening the app — Shopify identifies it —
        // so there is no address to type, and asking for one is not allowed: installation and sign-in
        // must start from a Shopify surface. Reloading opens the app for the shop again.
        <div className="mt-2 max-w-lg">
          <p className="text-[11.5px] leading-[1.45] text-surface-500">
            Rankvora AI connects to this store by itself whenever you open it from your Shopify admin. If it shows as not connected, reload to try again.
          </p>
          <div className="mt-2">
            <Button onClick={() => window.location.reload()}><RefreshCw size={15} />Reload</Button>
          </div>
        </div>
      ) : status.status === 'not_connected' ? (
        <div className="mt-2 max-w-lg">
          <label htmlFor="shop-domain" className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Your Shopify store address</label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input
              id="shop-domain"
              value={shopInput}
              onChange={(event) => onShopInputChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') onConnect(); }}
              placeholder="my-store.myshopify.com"
              disabled={!status.configured || busy === 'connecting'}
              className="h-8 min-w-[16rem] flex-1 rounded-md border border-surface-200 px-2.5 text-[12px] text-surface-900 placeholder:text-surface-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-surface-50"
            />
            <Button onClick={onConnect} disabled={!status.configured || busy === 'connecting'}>
              <Link2 size={15} />{busy === 'connecting' ? 'Opening Shopify…' : 'Connect Shopify'}
            </Button>
          </div>
          {shopInputError && <p className="mt-1.5 text-[11px] text-critical-600">{shopInputError}</p>}
          {/* The address only tells Shopify which admin to open. Approval happens in Shopify's own
              UI, and only its signed callback creates a connection here. */}
          <p className="mt-1.5 text-[11px] leading-[1.4] text-surface-500">
            You'll be taken to Shopify to review the permissions Rankvora AI requests and approve them. Nothing is connected until you do.
          </p>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Store" value={status.shopDomain ?? '—'} />
            <Field label="Connected since" value={status.installedAt ? new Date(status.installedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'} />
            <Field label="Last synced" value={status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never synced'} />
          </div>

          {status.status === 'reauthorization_required' && (
            <p className="rounded-md border border-warning-100 bg-warning-50 px-2.5 py-1.5 text-[11px] leading-[1.4] text-warning-800">
              Shopify authorization has expired. Reconnect your store to resume audits.
            </p>
          )}
          {status.lastSyncError && (
            <p className="rounded-md border border-critical-100 bg-critical-50 px-2.5 py-1.5 text-[11px] leading-[1.4] text-critical-800">{status.lastSyncError}</p>
          )}

          {summary ? (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Data read from your store</p>
              <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Field label="Products" value={String(summary.products)} />
                <Field label="Collections" value={String(summary.collections)} />
                <Field label="Pages" value={String(summary.pages)} />
                <Field label="Articles" value={String(summary.articles)} />
                <Field label="Policies" value={String(summary.policies)} />
              </div>
              {summary.truncated.length > 0 && (
                <p className="mt-2 text-[11.5px] leading-[1.4] text-warning-700">
                  Your crawl scope limit was reached for {summary.truncated.join(', ')} — these counts are partial. Raise the page limit in Settings → Analysis to read more.
                </p>
              )}
              {summary.unavailable.length > 0 && (
                <p className="mt-2 text-[11.5px] leading-[1.4] text-surface-500">Could not read: {summary.unavailable.join(', ')}.</p>
              )}
            </div>
          ) : (
            <p className="rounded-md bg-surface-50 px-2.5 py-1.5 text-[11px] leading-[1.4] text-surface-500">
              No data has been read from this store yet. Run a sync to pull your catalog and content.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={onSync} disabled={busy === 'syncing' || status.status === 'reauthorization_required'}>
              <RefreshCw size={15} className={busy === 'syncing' ? 'animate-spin' : ''} />{busy === 'syncing' ? 'Syncing…' : 'Sync now'}
            </Button>
            {status.storeUrl && (
              <a href={status.storeUrl} target="_blank" rel="noreferrer noopener" className="btn-secondary"><Link2 size={15} />View store</a>
            )}
            {/* Not inside the Shopify admin: there the store is removed by uninstalling the app from
                Shopify, and a Disconnect here would only be undone the next time the app opens. */}
            {!isEmbedded() && <Button variant="danger" onClick={onRequestDisconnect}><Unplug size={15} />Disconnect</Button>}
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-surface-200 bg-surface-50 px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">{label}</p>
      <p className="mt-0.5 truncate text-[12px] font-semibold text-surface-900" title={value}>{value}</p>
    </div>
  );
}
