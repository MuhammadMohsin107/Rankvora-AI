import { useCallback, useEffect, useMemo, useState, type HTMLAttributes } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { AlertCircle, Building2, CreditCard, Link2, Sparkles, UserRound, type LucideIcon } from 'lucide-react';
import { planInfo, type SettingsState } from '../data/settings.config';
import { fetchSettings, persistSettings, withStore } from '../data/settings.repository';
import WorkspaceStoreCard from '../components/settings/WorkspaceStoreCard';
import { fetchConnectorHealth, fetchIntegrations, overlayConnectorHealth, type IntegrationRecord } from '../data/integrations.repository';
import { ApiError } from '../lib/api';
import AppPage from '../components/polaris/AppPage';
import Banner from '../components/polaris/Banner';
import { Button, StatusBadge } from '../components/workflows/WorkflowPrimitives';
import ProfileSection from '../components/settings/ProfileSection';
import AiDiscoverySection from '../components/settings/AiDiscoverySection';
import GuidedSetupCard from '../components/onboarding/GuidedSetupCard';
import {
  Field,
  PreviewNotice,
  SaveBar,
  SavedToast,
  SettingsCard,
  TextInput,
  settingsCard,
} from '../components/settings/SettingsPrimitives';

type SectionId =
  | 'profile'
  | 'workspace'
  | 'integrations'
  | 'ai-discovery'
  | 'billing';

interface SectionMeta {
  id: SectionId;
  label: string;
  group: 'Account' | 'Workspace' | 'Platform';
  icon: LucideIcon;
  title: string;
}

const SECTIONS: SectionMeta[] = [
  { id: 'profile', label: 'Profile', group: 'Account', icon: UserRound, title: 'Profile' },
  { id: 'workspace', label: 'Workspace & store', group: 'Workspace', icon: Building2, title: 'Workspace & store' },
  { id: 'integrations', label: 'Integrations', group: 'Platform', icon: Link2, title: 'Integrations' },
  { id: 'ai-discovery', label: 'AI Discovery', group: 'Platform', icon: Sparkles, title: 'AI Discovery' },
  { id: 'billing', label: 'Plan & usage', group: 'Platform', icon: CreditCard, title: 'Plan & usage' },
];

const GROUP_ORDER: SectionMeta['group'][] = ['Account', 'Workspace', 'Platform'];

/** Sections whose fields feed the draft the save bar writes. The rest read live data or are
 * read-only, so they neither show the save bar nor carry an unsaved-changes marker. */
const EDITABLE_SECTIONS = new Set<SectionId>(['profile', 'workspace']);

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const isDomain = (value: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());

/**
 * The frame of every Settings state: the page frame (the "Settings" title in the Shopify admin's title
 * bar, which every state keeps) around the usual padded content. The backdrop is the admin's own grey,
 * so the white cards stand out on it without the page painting one of its own.
 */
function SettingsPage({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <AppPage heading="Settings">
      <div className={`page-shell ${className}`} {...rest}>
        {children}
      </div>
    </AppPage>
  );
}

export default function Settings() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

  const [saved, setSaved] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<SettingsState | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [isSaving, setIsSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const active: SectionId = useMemo(() => {
    const match = SECTIONS.find((item) => item.id === section);
    return match ? match.id : 'profile';
  }, [section]);
  const activeMeta = SECTIONS.find((item) => item.id === active) ?? SECTIONS[0];

  // Rewrite the address bar when the URL names a section that does not exist. The page already
  // fell back to Profile, but the bogus path stayed visible and shareable — so a link like
  // /settings/billling looked meaningful, and bookmarking it preserved the mistake.
  // `/settings` with no section is left alone: it is a legitimate entry point, not a typo.
  useEffect(() => {
    if (section !== undefined && section !== active) {
      navigate(`/settings/${active}`, { replace: true });
    }
  }, [section, active, navigate]);

  const load = useCallback(async () => {
    try {
      setState('loading');
      const result = await fetchSettings();
      setSaved(result);
      setDraft(structuredClone(result));
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const isDirty = Boolean(saved && draft) && JSON.stringify(saved) !== JSON.stringify(draft);

  // Warn before losing edits on a full page unload.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const errors = useMemo(() => {
    if (!draft) return {} as Record<string, string>;
    const next: Record<string, string> = {};
    if (!draft.profile.fullName.trim()) next.fullName = 'Enter your name.';
    if (!isEmail(draft.profile.email)) next.email = 'Enter a valid email address.';
    if (!draft.workspace.workspaceName.trim()) next.workspaceName = 'Workspace name is required.';
    // Required once there is a store to name. Before Shopify is connected both are empty on
    // purpose — nothing is known yet — and that must not block saving the rest of Settings.
    if (draft.workspace.platform === 'Shopify' && !draft.workspace.storeName.trim()) next.storeName = 'Store name is required.';
    if (draft.workspace.storeUrl.trim() && !isDomain(draft.workspace.storeUrl.replace(/\/$/, ''))) {
      next.storeUrl = 'Enter a domain, for example myshopifystore.com';
    }
    return next;
  }, [draft]);

  const hasErrors = Object.keys(errors).length > 0;

  const update = <K extends keyof SettingsState>(key: K, patch: Partial<SettingsState[K]>) =>
    setDraft((current) => (current ? { ...current, [key]: { ...current[key], ...patch } } : current));

  // A rejected save used to leave `isSaving` true forever — the button stayed on "Saving…",
  // the edits looked lost, and the reason (a duplicate email address, say) never reached the
  // customer. The failure is now surfaced and the draft is left untouched so it can be retried.
  const onSave = async () => {
    if (!draft || hasErrors) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await persistSettings(draft);
      setSaved(structuredClone(result));
      setDraft(structuredClone(result));
      setShowToast(true);
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : 'Could not save your changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const onDiscard = () => saved && setDraft(structuredClone(saved));

  // ─── Load / error states ───────────────────────────────────────────
  if (state === 'loading' || !draft) {
    if (state === 'error') {
      return (
        <SettingsPage>
          <div className={`${settingsCard} mx-auto flex max-w-md flex-col items-center p-6 text-center`}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-critical-50 text-critical-600">
              <AlertCircle size={18} />
            </span>
            <h2 className="mt-2.5 text-[15px] font-bold text-surface-950">Unable to load settings</h2>
            <div className="mt-2">
              <Button onClick={load}>
                Retry
              </Button>
            </div>
          </div>
        </SettingsPage>
      );
    }
    return <SettingsSkeleton />;
  }

  return (
    <SettingsPage className="section-stack">
      <div className="grid gap-2.5 lg:grid-cols-[212px_minmax(0,1fr)] lg:items-start">
        {/* ── Navigation ────────────────────────────────────────── */}
        <nav className="lg:sticky lg:top-3" aria-label="Settings sections">
          {/* Mobile / tablet: horizontal pills. Desktop: grouped list. */}
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1.5 lg:hidden">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/settings/${item.id}`)}
                aria-current={active === item.id ? 'page' : undefined}
                className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  active === item.id ? 'bg-surface-950 text-surface-0' : 'border border-surface-200 bg-surface-0 text-surface-600'
                }`}
              >
                <item.icon size={13} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>

          <div className="hidden lg:block">
            {GROUP_ORDER.map((group) => {
              const items = SECTIONS.filter((item) => item.group === group);
              return (
                <div key={group} className="mb-1.5">
                  <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-surface-400">{group}</p>
                  <ul className="space-y-0.5">
                    {items.map((item) => {
                      const isActive = active === item.id;
                      return (
                        <li key={item.id}>
                          <Link
                            to={`/settings/${item.id}`}
                            aria-current={isActive ? 'page' : undefined}
                            className={`group relative flex items-center gap-2 rounded-md py-1.5 pl-2.5 pr-2 text-[12.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                              isActive
                                ? 'bg-brand-50 text-brand-700'
                                : 'text-surface-600 hover:bg-surface-200/60 hover:text-surface-900'
                            }`}
                          >
                            {/* Accent rail — reinforces the active row beyond colour alone. */}
                            {isActive && (
                              <span
                                aria-hidden="true"
                                className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-600"
                              />
                            )}
                            <item.icon
                              size={14}
                              aria-hidden="true"
                              className={`flex-shrink-0 transition-colors ${
                                isActive ? '' : 'text-surface-400 group-hover:text-surface-600'
                              }`}
                            />
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {/* Unsaved-changes marker: the sections the save bar actually covers. */}
                            {isDirty && EDITABLE_SECTIONS.has(item.id) && (
                              <span
                                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning-500"
                                title="Unsaved changes"
                                aria-label="Unsaved changes"
                              />
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </nav>

        {/* ── Active section ────────────────────────────────────── */}
        <div className="min-w-0">
          {/* The section's name is the highlighted row in the menu beside it, so it is not repeated
              as a heading here — it stays for screen readers. */}
          <h2 className="sr-only">{activeMeta.title}</h2>

          {saveError && (
            <div className="mb-2">
              <Banner key={saveError} tone="critical" heading="Changes were not saved" onDismiss={() => setSaveError(null)}>
                <s-text>{saveError}</s-text>
              </Banner>
            </div>
          )}

          <div className="space-y-2">
            {active === 'profile' && (
              <ProfileSection
                profile={draft.profile}
                workspace={draft.workspace}
                errors={errors}
                onChange={(patch) => update('profile', patch)}
              />
            )}

            {active === 'workspace' && (
              <>
                {/* The way back into guided setup. Without an entry point here, the answers given
                    during onboarding — including whether Rankvora AI may write to the store — would be
                    fixed at whatever was chosen on the first run. */}
                <GuidedSetupCard />

                <SettingsCard title="Workspace">
                  <Field label="Workspace name" htmlFor="workspaceName" error={errors.workspaceName}>
                    <TextInput
                      id="workspaceName"
                      value={draft.workspace.workspaceName}
                      onChange={(value) => update('workspace', { workspaceName: value })}
                      invalid={Boolean(errors.workspaceName)}
                      describedBy={errors.workspaceName ? 'workspaceName-error' : 'workspaceName-hint'}
                    />
                  </Field>
                </SettingsCard>

                {/* Filled from the connected Shopify store; every field stays editable. The old card
                    offered hand-picked lists (7 countries, 6 timezones, 5 currencies), a Platform
                    choice of stores Rankvora AI cannot connect, and hints promising benchmarking and
                    revenue findings that nothing performs. */}
                <WorkspaceStoreCard
                  workspace={draft.workspace}
                  errors={errors}
                  dirty={isDirty}
                  onChange={(patch) => update('workspace', patch)}
                  onRefreshed={(store) => {
                    // The server wrote the store, so its answer is the saved state as well as the draft.
                    setSaved((current) => (current ? withStore(current, store) : current));
                    setDraft((current) => (current ? withStore(current, store) : current));
                  }}
                />
              </>
            )}

            {active === 'integrations' && <IntegrationsSection />}

            {/* Merchant-supplied AI Discovery inputs: the IndexNow key and the tracked questions,
                plus the llms.txt / agents.md generator. Read-only elsewhere in the app — this is
                the one place those values are entered. */}
            {active === 'ai-discovery' && <AiDiscoverySection />}

            {active === 'billing' && <BillingSection />}

          </div>

          {/* Save bar — only for sections that hold editable state. */}
          {EDITABLE_SECTIONS.has(active) && (
            <SaveBar
              visible={isDirty}
              saving={isSaving}
              onSave={onSave}
              onCancel={onDiscard}
              message={hasErrors ? 'Fix the highlighted fields' : 'Unsaved changes'}
            />
          )}
        </div>
      </div>

      <SavedToast visible={showToast} onDismiss={() => setShowToast(false)} />

    </SettingsPage>
  );
}

// ─── Integrations (reads the real records; does not duplicate the module) ──
function IntegrationsSection() {
  const [records, setRecords] = useState<IntegrationRecord[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>('loading');

  useEffect(() => {
    // The Google connectors' verdicts are applied here too, so Settings reports each one exactly as
    // the Integrations page does — "Working" only for a connector Google has actually answered.
    Promise.all([fetchIntegrations(), fetchConnectorHealth()])
      .then(([data, health]) => { setRecords(overlayConnectorHealth(data, health)); setLoadState('success'); })
      .catch((error) => { console.error('Failed to load integrations', error); setLoadState('error'); });
  }, []);

  const connected = records.filter((record) => record.status === 'Connected').length;
  const attention = records.filter((record) => record.status === 'Needs Attention').length;

  if (loadState === 'loading') return <SettingsCard title="Data sources" description="Loading…"><div className="h-24" /></SettingsCard>;
  if (loadState === 'error') return <SettingsCard title="Data sources" description="Failed to load integrations."><div /></SettingsCard>;

  return (
    <>
      <SettingsCard
        title="Data sources"
        footer={
          <Link
            to="/integrations"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand-700 transition-colors hover:text-brand-800"
          >
            <Link2 size={14} aria-hidden="true" />
            Open Integrations
          </Link>
        }
      >
        <div className="mb-2 grid grid-cols-3 gap-2">
          {[
            { label: 'Connected', value: connected },
            { label: 'Need attention', value: attention },
            { label: 'Available', value: records.length },
          ].map((tile) => (
            <div key={tile.label} className="rounded-md border border-surface-200 px-2.5 py-2">
              <p className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">{tile.label}</p>
              <p className="mt-0.5 text-[15px] font-bold leading-[1.15] tabular-nums text-surface-950">{tile.value}</p>
            </div>
          ))}
        </div>

        <ul className="divide-y divide-surface-100">
          {records.map((record) => (
            <li key={record.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-surface-900">{record.name}</p>
                <p className="text-[11px] text-surface-500">
                  {record.status === 'Connected' ? `Last synced ${record.lastSynced}` : record.detail}
                </p>
              </div>
              {/* A Google connector's badge says what its verdict found — "Not verified", "Setup
                  incomplete" — rather than the three-way status, which cannot tell those apart. */}
              <StatusBadge
                label={record.badge?.label ?? record.status}
                tone={record.badge?.tone ?? (record.status === 'Connected' ? 'success' : record.status === 'Needs Attention' ? 'warning' : 'neutral')}
              />
            </li>
          ))}
        </ul>
      </SettingsCard>
    </>
  );
}

// ─── Plan & usage (no billing backend — read-only) ────────────────────
function BillingSection() {
  return (
    <>
      <SettingsCard title="Current plan">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-[17px] font-bold tracking-tight text-surface-950">{planInfo.name}</h4>
              <StatusBadge label="Active" tone="success" />
            </div>
            <p className="mt-0.5 text-[11.5px] text-surface-500">{planInfo.description}</p>
          </div>
          <div className="text-right">
            <p className="text-[17px] font-bold tracking-tight text-surface-950 tabular-nums">{planInfo.price}</p>
            <p className="text-[11px] text-surface-500">{planInfo.cadence}</p>
          </div>
        </div>
      </SettingsCard>

      {/* This card previously rendered hard-coded meters (1,342 / 2,000 pages, 4 / 6 integrations)
          as filled progress bars, which read as measured consumption. Nothing tracks usage yet,
          so it says that instead — the same treatment the Billing card below already had. */}
      <SettingsCard title="Usage">
        <PreviewNotice>Usage tracking is not available yet.</PreviewNotice>
      </SettingsCard>

      <SettingsCard title="Billing">
        <PreviewNotice>Paid plans and invoices are not available yet.</PreviewNotice>
      </SettingsCard>
    </>
  );
}

// ─── Loading ──────────────────────────────────────────────────────────
function SettingsSkeleton() {
  return (
    <SettingsPage className="section-stack" aria-busy="true" aria-label="Loading settings">
      {/* Mirrors the loaded layout exactly — same track width, same paddings — so the page does
          not jump when the real content replaces it. */}
      <div className="grid gap-2.5 lg:grid-cols-[212px_minmax(0,1fr)]">
        <div className="space-y-1.5">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-7 w-full rounded-md" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className={`${settingsCard} p-3`}>
              <div className="skeleton h-5 w-44" />
              <div className="skeleton mt-1.5 h-4 w-72 max-w-full" />
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, field) => (
                  <div key={field} className="space-y-1.5">
                    <div className="skeleton h-4 w-24" />
                    <div className="skeleton h-8 w-full rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsPage>
  );
}
