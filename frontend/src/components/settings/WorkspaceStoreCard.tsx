import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { WorkspaceSettings } from '../../data/settings.config';
import type { StoreRow } from '../../data/api.types';
import { fetchIndustryOptions, refreshWorkspaceFromShopify } from '../../data/settings.repository';
import { countryNames, currencyCodes, currencyLabel, timeZoneNames } from '../../data/referenceLists';
import { ApiError } from '../../lib/api';
import { Field, SelectInput, SettingsCard, TextInput } from './SettingsPrimitives';
import Button from '../../components/polaris/Button';
import Banner from '../polaris/Banner';

/**
 * ─── Settings · the store, as Shopify knows it ───────────────────────
 *
 * Login → connect Shopify → the store's real name, primary URL, country, currency and timezone are
 * read from the shop and filled in here (backend store-profile.service.ts). Every field stays
 * editable, and editing is optional: a value changed by hand is kept on every later refresh, with
 * Shopify's own value shown beside it and one click to switch back.
 *
 * NOTHING HERE IS A STAND-IN. Before a shop is connected the fields are empty or "Not set", because
 * nothing is known yet — not "My store", example.com, UTC and US dollars, which signup used to write
 * and this page displayed as though they were the merchant's details.
 */

/** The honest "not known yet" value the store columns hold, shown as words rather than a code. */
const NOT_SET = 'Unspecified';
const showNotSet = (value: string) => (value === NOT_SET || value === '' ? 'Not set' : value);

type EditableField = 'storeName' | 'storeUrl' | 'country' | 'currency' | 'timezone';

const stripProtocol = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** Shopify's value for a field, in the same form the field holds it. */
function shopifyValue(workspace: WorkspaceSettings, field: EditableField): string | null {
  const facts = workspace.shopify;
  if (!facts) return null;
  switch (field) {
    case 'storeName': return facts.name;
    case 'storeUrl': return facts.url ? stripProtocol(facts.url) : null;
    case 'country': return facts.country;
    case 'currency': return facts.currency;
    case 'timezone': return facts.timezone;
  }
}

/**
 * Where a field's value came from — the line under each control.
 *
 * "From Shopify" when it matches what Shopify reported; otherwise Shopify's value with a button to
 * use it. Nothing at all when Shopify has not been read or did not report this field: no source is
 * claimed for a value that has none.
 */
function Source({
  workspace,
  field,
  display = (value: string) => value,
  onUse,
}: {
  workspace: WorkspaceSettings;
  field: EditableField;
  display?: (value: string) => string;
  onUse: (value: string) => void;
}) {
  const fromShopify = shopifyValue(workspace, field);
  if (fromShopify === null) return null;
  const current = field === 'storeUrl' ? stripProtocol(workspace.storeUrl) : workspace[field];
  if (current === fromShopify) {
    return (
      <span className="inline-flex items-center gap-1 text-success-700">
        <CheckCircle2 size={11} aria-hidden="true" /> From Shopify
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <span>Edited · Shopify says <span className="font-medium text-surface-700">{display(fromShopify)}</span></span>
      <Button variant="ghost" onClick={() => onUse(fromShopify)}>
        Use Shopify value
      </Button>
    </span>
  );
}

export default function WorkspaceStoreCard({
  workspace,
  errors,
  dirty,
  onChange,
  onRefreshed,
}: {
  workspace: WorkspaceSettings;
  errors: Record<string, string>;
  /** Unsaved edits on the page. A refresh replaces the fields, so it waits for them to be saved. */
  dirty: boolean;
  onChange: (patch: Partial<WorkspaceSettings>) => void;
  /** A refresh wrote the store; the page adopts the returned row as saved state. */
  onRefreshed: (store: StoreRow) => void;
}) {
  const [industries, setIndustries] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const connected = workspace.platform === 'Shopify';

  useEffect(() => {
    let active = true;
    fetchIndustryOptions()
      .then((options) => { if (active) setIndustries(options); })
      // Without the list the select still shows the stored value — never an invented set.
      .catch((error) => console.error('Failed to load industry options', error));
    return () => { active = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      onRefreshed(await refreshWorkspaceFromShopify());
    } catch (error) {
      setRefreshError(error instanceof ApiError ? error.message : 'Shopify could not be read.');
    } finally {
      setRefreshing(false);
    }
  };

  const readAt = workspace.shopify ? new Date(workspace.shopify.readAt).toLocaleString() : null;

  return (
    <SettingsCard title="Store">
      {connected ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-50/60 px-2.5 py-1.5">
          <p className="text-[11.5px] text-surface-600">
            {readAt
              ? <>Read from Shopify {readAt}</>
              : 'Not read from Shopify yet.'}
          </p>
          <Button loading={refreshing} variant="secondary" onClick={() => void refresh()} disabled={refreshing || dirty}>
            {refreshing ? 'Reading Shopify…' : 'Refresh from Shopify'}
          </Button>
        </div>
      ) : (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-info-100 bg-info-50 px-2.5 py-1.5">
          <p className="text-[11.5px] text-info-800">
            No Shopify store connected.
          </p>
          <Button variant="primary" to="/integrations">Connect Shopify</Button>
        </div>
      )}

      {refreshError && (
        <div className="mb-2"><Banner tone="critical"><s-text>{refreshError}</s-text></Banner></div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          label="Store name"
          htmlFor="storeName"
          error={errors.storeName}
          hint={<Source workspace={workspace} field="storeName" onUse={(value) => onChange({ storeName: value })} />}
        >
          <TextInput
            id="storeName"
            value={workspace.storeName}
            onChange={(value) => onChange({ storeName: value })}
            invalid={Boolean(errors.storeName)}
            describedBy={errors.storeName ? 'storeName-error' : 'storeName-hint'}
          />
        </Field>
        <Field
          label="Store URL"
          htmlFor="storeUrl"
          error={errors.storeUrl}
          hint={<Source workspace={workspace} field="storeUrl" onUse={(value) => onChange({ storeUrl: value })} />}
        >
          <TextInput
            id="storeUrl"
            value={workspace.storeUrl}
            onChange={(value) => onChange({ storeUrl: value })}
            invalid={Boolean(errors.storeUrl)}
            prefix="https://"
            describedBy={errors.storeUrl ? 'storeUrl-error' : 'storeUrl-hint'}
          />
        </Field>
        <Field label="Country" htmlFor="country" hint={<Source workspace={workspace} field="country" display={showNotSet} onUse={(value) => onChange({ country: value })} />}>
          <SelectInput
            id="country"
            value={workspace.country}
            options={[NOT_SET, ...countryNames()]}
            labelFor={showNotSet}
            onChange={(value) => onChange({ country: value })}
            describedBy="country-hint"
          />
        </Field>
        <Field
          label="Currency"
          htmlFor="currency"
          hint={<Source workspace={workspace} field="currency" display={currencyLabel} onUse={(value) => onChange({ currency: value })} />}
        >
          <SelectInput
            id="currency"
            value={workspace.currency}
            options={[NOT_SET, ...currencyCodes()]}
            labelFor={(value) => (value === NOT_SET ? 'Not set' : currencyLabel(value))}
            onChange={(value) => onChange({ currency: value })}
            describedBy="currency-hint"
          />
        </Field>
        <Field label="Timezone" htmlFor="timezone" hint={<Source workspace={workspace} field="timezone" onUse={(value) => onChange({ timezone: value })} />}>
          <SelectInput
            id="timezone"
            value={workspace.timezone}
            options={[NOT_SET, ...timeZoneNames()]}
            labelFor={showNotSet}
            onChange={(value) => onChange({ timezone: value })}
            describedBy="timezone-hint"
          />
        </Field>
        <Field label="Industry" htmlFor="industry">
          <SelectInput
            id="industry"
            value={workspace.industry}
            options={[NOT_SET, ...industries]}
            labelFor={showNotSet}
            onChange={(value) => onChange({ industry: value })}
            describedBy="industry-hint"
          />
        </Field>
      </div>

      <p className="mt-2 border-t border-surface-100 pt-2 text-[11.5px] text-surface-500">
        Platform: <span className="font-medium text-surface-700">{connected ? 'Shopify' : 'Not connected'}</span>
        {connected && workspace.shopify && <> · <span className="font-mono">{workspace.shopify.shopDomain}</span></>}
      </p>
    </SettingsCard>
  );
}
