import { useState } from 'react';
import {
  Boxes,
  CalendarClock,
  CircleDollarSign,
  Clock3,
  FileText,
  Globe2,
  Languages,
  Lightbulb,
  Loader2,
  MapPin,
  Newspaper,
  Package,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Tag,
  Target,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { isPillarVisible } from '../../config/modules';
import {
  CheckCard,
  Chip,
  ChoiceCard,
  Combobox,
  DetectedNote,
  FactTile,
  FetchFailedNote,
  FormField,
  FormGrid,
  FormSection,
  MultiCombobox,
  MultiSelectChips,
  PriorityList,
  QuietNote,
  SegmentedControl,
  SuggestionRow,
  TagInput,
  TextArea,
  TextField,
  ToggleCard,
  UnavailableNote,
} from './OnboardingPrimitives';
import {
  AUTOMATION_CONSENT_OPTIONS,
  FIELD_LIMITS,
  SCAN_HOURS,
  consentLabel,
  countryNames,
  formatScanHour,
  languageChoices,
  languageLabel,
  normaliseProtectedPath,
  storefrontAddressProblem,
  type AutomationConsent,
  type InvalidField,
  type OnboardingSnapshot,
  type OnboardingSuggestions,
  type RequiredField,
  type StepPayload,
} from '../../data/onboarding.repository';

/**
 * ─── The four steps ──────────────────────────────────────────────────
 *
 *   1  Confirm your store     what Shopify told us, shown read-only, and the markets that matter
 *   2  Your business          brand, aliases, industry, content language
 *   3  Priorities             what to improve first, plus optional keywords and priority products
 *                             (competitors and the questions customers ask are no longer asked here)
 *   4  Permissions            how changes are approved, what to leave alone, when to re-scan
 *
 * (The server also has a measurement step, numbered 4 there. Setup does not show it: Search Console and
 * Analytics are connected from the Integrations page. This step is the server's step 5.)
 *
 * Each step edits a slice of one draft object held by the page. They never fetch their own answers
 * and never save them — that belongs to the page, so a merchant moving between steps cannot lose an
 * answer to a component unmounting.
 *
 * IMPORTED FACTS AND EDITABLE PREFERENCES ARE KEPT APART. What Shopify reported is shown in its own
 * block, read-only and labelled as imported; what the merchant decides sits in fields. Mixing the two
 * would make an edit look like a correction to Shopify, and a Shopify value look like a choice.
 *
 * No field is ever filled in for the merchant. Where the store has something to say about a field, a
 * `DetectedNote` under it names the source and offers the value as a one-click answer. Where something
 * could not be read, an `UnavailableNote` says so — and a count Shopify withheld is "not reported",
 * never zero.
 *
 * REQUIRED FIELDS CARRY A BADGE, and only they do.
 */

export interface StepProps {
  draft: StepPayload;
  patch: (changes: Partial<StepPayload>) => void;
  snapshot: OnboardingSnapshot;
  suggestions: OnboardingSuggestions | null;
  suggestionsLoading: boolean;
  /** True when the request for the store's details failed, so the step can say so and offer a retry. */
  suggestionsFailed: boolean;
  /** Asks for the store's details again. */
  onRetrySuggestions: () => void;
  /**
   * Required answers the merchant has been stopped on, by field. Only ever populated after they
   * press Continue: a field they have not reached yet is not a mistake, and colouring it red on
   * arrival would tell them they had done something wrong before they had done anything at all.
   */
  errors: Partial<Record<RequiredField | InvalidField, string>>;
}

/**
 * What each pillar is called when the merchant is choosing what to improve first, with one line on
 * what it covers (the sub-pillars it audits, data/pillarMeta.ts) and its mark.
 */
export const PILLAR_GOALS: Record<string, { label: string; icon: LucideIcon }> = {
  seo: { label: 'Search visibility', icon: Search },
  content: { label: 'Product & collection content', icon: FileText },
  speed: { label: 'Store performance', icon: Zap },
  'ai-discovery': { label: 'AI discovery', icon: Sparkles },
  cro: { label: 'Conversion (CRO)', icon: Target },
};

/** What each way of approving changes means, in plain words. */
const CONSENT_ICONS: Record<string, { icon: LucideIcon }> = {
  ask: { icon: ShieldCheck },
  none: { icon: Lightbulb },
};

/** "1,240", or "1,240+" when Shopify only reported a lower bound. Null stays null — never zero. */
function formatCount(total: { count: number; exact: boolean } | null | undefined): string | null {
  if (!total) return null;
  return `${total.count.toLocaleString()}${total.exact ? '' : '+'}`;
}

function SuggestionsPending() {
  return (
    <QuietNote>
      <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      Reading your store…
    </QuietNote>
  );
}

/** Adds or removes one value from a multi-select answer. `undefined` is empty: a draft holds only
 * the fields the merchant has touched. */
function toggleValue(current: string[] | undefined, value: string): string[] {
  const list = current ?? [];
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/** Adds without removing — what a suggestion does. Idempotent. */
function addValue(current: string[] | undefined, value: string): string[] {
  const list = current ?? [];
  return list.includes(value) ? list : [...list, value];
}

/** Lets the last card of a group fill its row when the count does not divide evenly. */
function lastCardSpan(index: number, count: number, columns: { sm: number; lg: number }): string {
  if (index !== count - 1) return '';
  const sm = count % columns.sm === 0 ? '' : SM_SPAN[columns.sm - (count % columns.sm) + 1] ?? '';
  const lg = count % columns.lg === 0 ? 'lg:col-span-1' : LG_SPAN[columns.lg - (count % columns.lg) + 1] ?? '';
  return `${sm} ${lg}`.trim();
}

const SM_SPAN: Record<number, string> = { 2: 'sm:col-span-2', 3: 'sm:col-span-3' };
const LG_SPAN: Record<number, string> = { 2: 'lg:col-span-2', 3: 'lg:col-span-3', 4: 'lg:col-span-4' };

/** "No email alerts" is a stored value; Rankvora AI sends no alert email at all, so it reads "No alerts". */
const ALERT_LABELS: Record<string, string> = { 'No email alerts': 'No alerts' };

// ─── Step 1 · Confirm your store ─────────────────────────────────────

export function StepStore({ draft, patch, snapshot, suggestions, suggestionsLoading, suggestionsFailed, onRetrySuggestions, errors }: StepProps) {
  const shop = snapshot.detection.shop;
  const countries = draft.targetCountries ?? [];
  const languages = draft.targetLanguages ?? [];
  const available = countryNames();
  // The address is checked once the merchant has left the field (so it is not flagged mid-word), and
  // again, as `errors`, when they press Continue.
  const [domainTouched, setDomainTouched] = useState(false);
  const domainProblem = errors.primaryDomain ?? (domainTouched ? (storefrontAddressProblem(draft.primaryDomain) ?? undefined) : undefined);
  const locales = suggestions?.languages ?? null;
  const primaryLocale = locales?.find((locale) => locale.primary) ?? null;
  const content = suggestions?.content ?? null;

  const removeCountry = (country: string) => {
    const next = countries.filter((item) => item !== country);
    patch({
      targetCountries: next,
      // The primary market must stay one of the selected markets.
      primaryMarket: draft.primaryMarket === country ? (next[0] ?? null) : draft.primaryMarket,
    });
  };

  const addCountry = (country: string) => {
    if (!country || countries.includes(country)) return;
    patch({ targetCountries: [...countries, country], primaryMarket: draft.primaryMarket ?? country });
  };

  /** A count tile: still reading, read, or honestly not reported. */
  const countValue = (total: { count: number; exact: boolean } | null | undefined): string | null =>
    suggestionsLoading ? 'Reading…' : formatCount(total);
  // The facts that come from the store-details request: if that request failed, say so, rather than
  // claiming Shopify chose not to report them.
  const missing = suggestionsFailed ? 'Couldn’t be loaded' : undefined;

  return (
    <div className="space-y-3">
      {suggestionsFailed && <FetchFailedNote onRetry={onRetrySuggestions} retrying={suggestionsLoading} />}
      {!snapshot.detection.available && snapshot.detection.unavailableReason && (
        <UnavailableNote>{snapshot.detection.unavailableReason}</UnavailableNote>
      )}

      {/* ── Imported from Shopify · read-only ─────────────────────────── */}
      {shop && (
        <FormSection title="Imported from Shopify">
          {/* Ten facts in one grid: two even rows of five on a wide screen, so nothing is left alone in a last row. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <FactTile label="Store" value={shop.name || null} icon={Store} />
            <FactTile label="Storefront" value={shop.primaryUrl ?? shop.myshopifyDomain} icon={Globe2} />
            <FactTile
              label="Primary language"
              value={suggestionsLoading ? 'Reading…' : primaryLocale ? languageLabel(primaryLocale.locale) : null}
              icon={Languages}
              missing={missing}
            />
            <FactTile label="Currency" value={shop.currencyCode} icon={CircleDollarSign} />
            <FactTile label="Timezone" value={shop.ianaTimezone} icon={Clock3} />
            <FactTile label="Billing country" value={shop.country} icon={MapPin} />
            <FactTile label="Published products" value={countValue(content?.publishedProducts)} icon={Boxes} missing={missing} />
            <FactTile label="Published collections" value={countValue(content?.publishedCollections)} icon={Boxes} missing={missing} />
            <FactTile label="Articles" value={countValue(content?.articles)} icon={Newspaper} missing={missing} hint="Includes unpublished" />
            <FactTile label="Pages" value={countValue(content?.pages)} icon={FileText} missing={missing} hint="Includes unpublished" />
          </div>
        </FormSection>
      )}

      {/* ── The merchant's own choices ─────────────────────────────────── */}
      <FormGrid>
        <FormField
          label="Store name"
          htmlFor="onboarding-organization"
          badge="required"
          error={errors.organizationName}
          extras={
            shop?.name ? (
              <DetectedNote
                action={{
                  label: 'Use this',
                  applied: draft.organizationName === shop.name,
                  onApply: () => patch({ organizationName: shop.name }),
                }}
              >
                Shopify store name: {shop.name}
              </DetectedNote>
            ) : null
          }
        >
          <TextField
            id="onboarding-organization"
            icon={Store}
            maxLength={FIELD_LIMITS.organizationName}
            value={draft.organizationName ?? ''}
            invalid={Boolean(errors.organizationName)}
            onChange={(value) => patch({ organizationName: value })}
            placeholder="Enter your store or business name"
          />
        </FormField>

        <FormField
          label="Storefront address"
          htmlFor="onboarding-domain"
          badge="optional"
          error={domainProblem}
          extras={
            shop?.primaryUrl ? (
              <DetectedNote
                action={{
                  label: 'Use this',
                  applied: draft.primaryDomain === shop.primaryUrl,
                  onApply: () => patch({ primaryDomain: shop.primaryUrl }),
                }}
              >
                Shopify primary domain: {shop.primaryUrl}
              </DetectedNote>
            ) : null
          }
        >
          <TextField
            id="onboarding-domain"
            icon={Globe2}
            maxLength={FIELD_LIMITS.primaryDomain}
            invalid={Boolean(domainProblem)}
            onBlur={() => setDomainTouched(true)}
            value={draft.primaryDomain ?? ''}
            onChange={(value) => patch({ primaryDomain: value })}
            placeholder="Enter your storefront address"
          />
        </FormField>

        <FormField
          label="Priority markets"
          htmlFor="onboarding-country-add"
          badge="required"
          error={errors.targetCountries}
          className="md:col-span-2"
          extras={
            suggestions?.detectedCountry ? (
              <DetectedNote
                action={{
                  label: `Add ${suggestions.detectedCountry}`,
                  applied: countries.includes(suggestions.detectedCountry),
                  onApply: () => addCountry(suggestions.detectedCountry as string),
                }}
              >
                Billing country: {suggestions.detectedCountry}
              </DetectedNote>
            ) : null
          }
        >
          {available.length > 0 ? (
            <MultiCombobox
              id="onboarding-country-add"
              icon={MapPin}
              values={countries}
              options={available}
              placeholder="Search for a country…"
              emptyText="No matching country"
              max={50}
              invalid={Boolean(errors.targetCountries)}
              onAdd={addCountry}
              onRemove={removeCountry}
            />
          ) : (
            // `Intl.DisplayNames` is unavailable on some older engines, so there is no list to offer.
            // A market is required, and no merchant may be stranded on a step they cannot answer.
            <TagInput
              id="onboarding-country-add"
              icon={MapPin}
              values={countries}
              onChange={(next) =>
                patch({
                  targetCountries: next,
                  primaryMarket: next.includes(draft.primaryMarket ?? '') ? draft.primaryMarket : (next[0] ?? null),
                })
              }
              placeholder="Type a country name"
              max={50}
              invalid={Boolean(errors.targetCountries)}
            />
          )}
        </FormField>

        {countries.length > 1 && (
          <FormField
            label="Primary market"
            htmlFor="onboarding-primary-market"
            badge="optional"
            className="md:col-span-2"
          >
            <SegmentedControl
              id="onboarding-primary-market"
              label="Primary market"
              value={draft.primaryMarket ?? ''}
              options={countries.map((country) => ({ value: country, label: country }))}
              onChange={(value) => patch({ primaryMarket: value })}
            />
          </FormField>
        )}

        {/* Shown only when there is something to choose: while the store is being read, or once it has
            named at least one language. If Shopify would not say, or reports none, a heading over an
            apology gives the merchant nothing to do, so the whole section stays out of the way. */}
        {(suggestionsLoading || (locales !== null && locales.length > 0)) && (
          <FormSection className="md:col-span-2" title="Languages to audit" badge="optional">
            {suggestionsLoading && <SuggestionsPending />}

            {!suggestionsLoading && locales && locales.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {locales.map((locale, index) => (
                  <div key={locale.locale} className={lastCardSpan(index, locales.length, { sm: 2, lg: 3 })}>
                    <CheckCard
                      id={`onboarding-locale-${locale.locale}`}
                      checked={languages.includes(locale.locale)}
                      label={locale.name ? `${locale.name} (${locale.locale})` : locale.locale}
                      description={[locale.primary ? 'Primary' : null, locale.published ? 'Published' : 'Not published']
                        .filter(Boolean)
                        .join(' · ')}
                      onToggle={(next) =>
                        patch({
                          targetLanguages: next
                            ? [...languages, locale.locale]
                            : languages.filter((item) => item !== locale.locale),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </FormSection>
        )}
      </FormGrid>
    </div>
  );
}

// ─── Step 2 · Your business ──────────────────────────────────────────

export function StepBusiness({ draft, patch, snapshot, suggestions, suggestionsLoading, suggestionsFailed, onRetrySuggestions, errors }: StepProps) {
  const shop = snapshot.detection.shop;
  const aliases = draft.brandedTerms ?? [];
  const derivedIndustry = suggestions?.industry ?? null;
  const primaryLocale = suggestions?.languages?.find((locale) => locale.primary) ?? null;

  const aliasSuggestions = (suggestions?.brandedTerms ?? []).map((value) => ({
    value,
    hint: 'From your Shopify store name',
  }));

  const languageOptions = languageChoices(suggestions?.languages ?? null).map((code) => ({
    value: code,
    label: `${languageLabel(code)}${languageLabel(code) === code ? '' : ` (${code})`}`,
  }));
  // A language saved earlier must stay selectable even if the store's own list no longer carries it.
  const chosenLanguage = draft.contentLanguage ?? '';
  if (chosenLanguage && !languageOptions.some((option) => option.value === chosenLanguage)) {
    languageOptions.unshift({ value: chosenLanguage, label: `${languageLabel(chosenLanguage)} (${chosenLanguage})` });
  }

  return (
    <div className="space-y-3">
      {suggestionsFailed && <FetchFailedNote onRetry={onRetrySuggestions} retrying={suggestionsLoading} />}
      {!suggestionsLoading && suggestions && !suggestions.available && suggestions.unavailableReason && (
        <UnavailableNote>{suggestions.unavailableReason}</UnavailableNote>
      )}

      <FormGrid>
        <FormField
          label="Brand name"
          htmlFor="onboarding-brand"
          badge="required"
          error={errors.brandName}
          extras={
            shop?.name ? (
              <DetectedNote
                action={{
                  label: 'Use this',
                  applied: draft.brandName === shop.name,
                  onApply: () => patch({ brandName: shop.name }),
                }}
              >
                Shopify store name: {shop.name}
              </DetectedNote>
            ) : null
          }
        >
          <TextField
            id="onboarding-brand"
            icon={Tag}
            maxLength={FIELD_LIMITS.brandName}
            value={draft.brandName ?? ''}
            invalid={Boolean(errors.brandName)}
            onChange={(value) => patch({ brandName: value })}
            placeholder="Enter your brand name"
          />
        </FormField>

        <FormField
          label="Brand aliases"
          htmlFor="onboarding-aliases"
          badge="optional"
          extras={
            !suggestionsLoading && aliasSuggestions.length > 0 ? (
              <div className="mt-2">
                <SuggestionRow
                  label="From your store name"
                  suggestions={aliasSuggestions}
                  selected={aliases}
                  onAdd={(value) => aliases.length < 10 && patch({ brandedTerms: [...aliases, value] })}
                />
              </div>
            ) : null
          }
        >
          <TagInput
            id="onboarding-aliases"
            icon={Tag}
            values={aliases}
            onChange={(next) => patch({ brandedTerms: next })}
            placeholder="Type an alternative name"
            max={10}
            maxItemLength={FIELD_LIMITS.brandedTerm}
          />
        </FormField>

        <FormSection
          className="md:col-span-2"
          title="Industry"
          badge="required"
          error={errors.industries}
        >
          <MultiSelectChips
            label="Industry"
            options={snapshot.options.industries}
            selected={draft.industries ?? []}
            invalid={Boolean(errors.industries)}
            onToggle={(value) => patch({ industries: toggleValue(draft.industries, value) })}
          />
          {suggestionsLoading && (
            <div className="mt-1.5">
              <SuggestionsPending />
            </div>
          )}
          {derivedIndustry && (
            <DetectedNote
              action={{
                label: `Add “${derivedIndustry.value}”`,
                applied: (draft.industries ?? []).includes(derivedIndustry.value),
                // ADDS rather than replaces: a merchant who already chose two must not lose them.
                onApply: () => patch({ industries: addValue(draft.industries, derivedIndustry.value) }),
              }}
            >
              Detected: {derivedIndustry.value}
              {derivedIndustry.confidence === 'low' && ' · weak match'}
            </DetectedNote>
          )}
        </FormSection>

        <FormField
          label="Content language"
          htmlFor="onboarding-language"
          badge="required"
          error={errors.contentLanguage}
          extras={
            primaryLocale ? (
              <DetectedNote
                action={{
                  label: 'Use this',
                  applied: draft.contentLanguage === primaryLocale.locale,
                  onApply: () => patch({ contentLanguage: primaryLocale.locale }),
                }}
              >
                Store language: {languageLabel(primaryLocale.locale)}
              </DetectedNote>
            ) : null
          }
        >
          <Combobox
            id="onboarding-language"
            icon={Languages}
            value={chosenLanguage}
            options={languageOptions}
            placeholder="Search for a language…"
            emptyText="No matching language"
            invalid={Boolean(errors.contentLanguage)}
            onChange={(value) => patch({ contentLanguage: value || null })}
          />
        </FormField>

        <FormField
          label="What you sell"
          htmlFor="onboarding-sells"
          badge="optional"
        >
          <TextArea
            id="onboarding-sells"
            value={draft.sellsDescription ?? ''}
            onChange={(value) => patch({ sellsDescription: value })}
            placeholder="Describe what you sell in one sentence"
            maxLength={500}
            rows={2}
          />
        </FormField>
      </FormGrid>
    </div>
  );
}

// ─── Step 3 · Priorities ─────────────────────────────────────────────

export function StepPriorities({ draft, patch, snapshot, suggestions, suggestionsLoading, suggestionsFailed, onRetrySuggestions, errors }: StepProps) {
  const keywords = draft.targetKeywords ?? [];
  const chosenResources = draft.priorityResources ?? [];
  const chosenPillars = (draft.priorityPillars ?? []).filter(isPillarVisible);

  // Only the pillars the customer can see (config/modules.ts), and only ones the server knows.
  const pillarKeys = snapshot.options.pillars.filter(isPillarVisible);

  const keywordSuggestions = (suggestions?.keywords ?? []).map((suggestion) => ({
    value: suggestion.value,
    hint: suggestion.source,
  }));

  const togglePillar = (key: string) => {
    const hidden = (draft.priorityPillars ?? []).filter((entry) => !isPillarVisible(entry));
    patch({ priorityPillars: [...toggleValue(chosenPillars, key), ...hidden] });
  };

  const isChosen = (kind: 'product' | 'collection', handle: string) =>
    chosenResources.some((resource) => resource.kind === kind && resource.handle === handle);

  const addResource = (kind: 'product' | 'collection', handle: string) => {
    if (!handle || isChosen(kind, handle) || chosenResources.length >= 20) return;
    const source = kind === 'product' ? suggestions?.resources.products : suggestions?.resources.collections;
    const found = source?.find((entry) => entry.handle === handle);
    if (!found) return;
    patch({ priorityResources: [...chosenResources, { kind, handle, title: found.title }] });
  };

  const resourceOptions = (kind: 'product' | 'collection') =>
    (kind === 'product' ? suggestions?.resources.products : suggestions?.resources.collections ?? [])?.filter(
      (entry) => !isChosen(kind, entry.handle),
    ).map((entry) => ({ value: entry.handle, label: entry.title })) ?? [];

  const catalogueUnread = !suggestionsLoading && (!suggestions || !suggestions.available);

  return (
    <div className="space-y-3">
      {suggestionsFailed && <FetchFailedNote onRetry={onRetrySuggestions} retrying={suggestionsLoading} />}
      <FormGrid>
        <FormSection
          className="md:col-span-2"
          title="Improve first"
          badge="required"
          error={errors.priorityPillars}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {pillarKeys.map((key) => {
              const goal = PILLAR_GOALS[key];
              return (
                <CheckCard
                  key={key}
                  id={`onboarding-pillar-${key}`}
                  checked={chosenPillars.includes(key)}
                  label={goal?.label ?? key}
                  icon={goal?.icon}
                  rank={chosenPillars.length > 1 && chosenPillars.includes(key) ? chosenPillars.indexOf(key) + 1 : undefined}
                  onToggle={() => togglePillar(key)}
                />
              );
            })}
          </div>
          {chosenPillars.length > 1 && (
            <div className="mt-6">
              <p className="mb-2 text-[13px] font-semibold tracking-[-0.01em] text-surface-950">Priority order</p>
              <PriorityList
                items={chosenPillars.map((key) => ({ key, label: PILLAR_GOALS[key]?.label ?? key, icon: PILLAR_GOALS[key]?.icon }))}
                onReorder={(keys) => patch({ priorityPillars: [...keys, ...(draft.priorityPillars ?? []).filter((key) => !isPillarVisible(key))] })}
              />
            </div>
          )}
        </FormSection>

        <FormField
          label="Target keywords"
          htmlFor="onboarding-keywords"
          badge="optional"
          className="md:col-span-2"
          extras={
            <div className="mt-1.5 space-y-1.5 empty:hidden">
              {suggestionsLoading && <SuggestionsPending />}
              {!suggestionsLoading && keywordSuggestions.length > 0 && (
                <SuggestionRow
                  label="Suggestions"
                  suggestions={keywordSuggestions}
                  selected={keywords}
                  onAdd={(value) => keywords.length < 10 && patch({ targetKeywords: [...keywords, value] })}
                />
              )}
              {catalogueUnread && suggestions?.unavailableReason && (
                <UnavailableNote>{suggestions.unavailableReason}</UnavailableNote>
              )}
            </div>
          }
        >
          <TagInput
            id="onboarding-keywords"
            icon={Search}
            values={keywords}
            onChange={(next) => patch({ targetKeywords: next })}
            placeholder="Type a keyword"
            max={10}
            maxItemLength={FIELD_LIMITS.keyword}
            transform={(raw) => {
              const value = raw.trim().replace(/\s+/g, ' ').toLowerCase();
              return value.length >= 3 ? value : null;
            }}
          />
        </FormField>

        <FormSection
          className="md:col-span-2"
          title="Priority products and collections"
          badge="optional"
        >
          {suggestionsLoading && <SuggestionsPending />}
          {!suggestionsLoading && catalogueUnread && (
            <UnavailableNote>Your catalogue could not be read.</UnavailableNote>
          )}
          {!suggestionsLoading && !catalogueUnread && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Combobox
                id="onboarding-priority-product"
                icon={Package}
                value=""
                options={resourceOptions('product')}
                emptyText="No matching product"
                placeholder={(suggestions?.resources.products.length ?? 0) === 0 ? 'No products found' : 'Search for a product…'}
                disabled={(suggestions?.resources.products.length ?? 0) === 0 || chosenResources.length >= 20}
                onChange={(value) => addResource('product', value)}
              />
              <Combobox
                id="onboarding-priority-collection"
                icon={Boxes}
                value=""
                options={resourceOptions('collection')}
                emptyText="No matching collection"
                placeholder={(suggestions?.resources.collections.length ?? 0) === 0 ? 'No collections found' : 'Search for a collection…'}
                disabled={(suggestions?.resources.collections.length ?? 0) === 0 || chosenResources.length >= 20}
                onChange={(value) => addResource('collection', value)}
              />
            </div>
          )}
          {chosenResources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chosenResources.map((resource) => (
                <Chip
                  key={`${resource.kind}:${resource.handle}`}
                  label={`${resource.kind === 'product' ? 'Product' : 'Collection'} · ${resource.title}`}
                  onRemove={() =>
                    patch({
                      priorityResources: chosenResources.filter(
                        (entry) => !(entry.kind === resource.kind && entry.handle === resource.handle),
                      ),
                    })
                  }
                />
              ))}
            </div>
          )}
        </FormSection>
      </FormGrid>
    </div>
  );
}

// ─── Step 4 · Permissions and monitoring ─────────────────────────────

/** A permission and what it is set to, as a plain row — not a control. */
function PermissionRow({ label, state, tone }: { label: string; state: string; tone: 'on' | 'review' | 'off' }) {
  const look = {
    on: { dot: 'bg-success-500', text: 'text-success-700' },
    review: { dot: 'bg-brand-500', text: 'text-brand-700' },
    off: { dot: 'bg-surface-300', text: 'text-surface-500' },
  }[tone];
  return (
    <li className="flex min-h-9 items-center justify-between gap-x-3 rounded-lg bg-surface-50 px-3.5 py-2 ring-1 ring-inset ring-surface-200/70">
      <p className="min-w-0 flex-1 text-[13px] font-medium tracking-[-0.01em] text-surface-900">{label}</p>
      <span className={`inline-flex flex-shrink-0 items-center gap-1.5 text-[12px] font-semibold ${look.text}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${look.dot}`} aria-hidden="true" />
        {state}
      </span>
    </li>
  );
}

function formatWhen(iso: string | null, timeZone: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
}

export function StepPermissions({ draft, patch, snapshot, errors }: StepProps) {
  const consent = (draft.automationConsent ?? null) as AutomationConsent | null;
  const protectedPaths = draft.protectedPaths ?? [];
  const alerts = snapshot.options.alertFrequencies;
  const frequencies = snapshot.options.analysisFrequencies;
  const schedule = snapshot.schedule;
  const monitoring = draft.autoAnalysis ?? schedule.enabled;
  const frequency = draft.analysisFrequency ?? schedule.frequency;
  const hour = draft.preferredScanHour === undefined ? snapshot.preferences.preferredScanHour : draft.preferredScanHour;
  const timeZone = schedule.timeZone;
  const nextScan = formatWhen(schedule.nextScanAt, timeZone);

  const consentOptions = [...AUTOMATION_CONSENT_OPTIONS];
  // A store that chose the old automatic option keeps seeing it as its choice, labelled for what it
  // is — an earlier choice setup no longer offers — rather than silently becoming a different answer.
  const legacy = consent === 'low_risk';

  return (
    <div className="space-y-3">
      <FormGrid>
        <FormSection
          className="md:col-span-2"
          title="Change approval"
          badge="required"
          error={errors.automationConsent}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {legacy && (
              <ChoiceCard
                name="automation-consent"
                value="low_risk"
                label={consentLabel('low_risk')}
                icon={ShieldCheck}
                selected
                onSelect={() => undefined}
                className="sm:col-span-2"
              />
            )}
            {consentOptions.map((option) => (
              <ChoiceCard
                key={option.value}
                name="automation-consent"
                value={option.value}
                label={option.label}
                icon={CONSENT_ICONS[option.value]?.icon}
                selected={consent === option.value}
                onSelect={(value) => patch({ automationConsent: value as AutomationConsent })}
              />
            ))}
          </div>
        </FormSection>

        <FormSection className="md:col-span-2" title="Permissions">
          {/* Four equal tiles, two to a row, so the list takes two short rows instead of four tall ones. */}
          <ul className="grid gap-2 sm:grid-cols-2">
            <PermissionRow label="Analyze your published store content" state="On" tone="on" />
            <PermissionRow label="Prepare recommendations and drafts" state="On" tone="on" />
            <PermissionRow
              label="Publish changes"
              state={consent === 'none' ? 'Off' : 'You approve each'}
              tone={consent === 'none' ? 'off' : 'review'}
            />
            <PermissionRow label="Change URLs or theme code" state="Not offered" tone="off" />
          </ul>
        </FormSection>

        <FormSection className="md:col-span-2" title="Alerts" badge="optional">
          <SegmentedControl
            id="onboarding-alerts"
            label="Alerts"
            fill
            value={draft.alertFrequency ?? ''}
            options={alerts.map((option) => ({ value: option, label: ALERT_LABELS[option] ?? option }))}
            onChange={(value) => patch({ alertFrequency: value })}
          />
        </FormSection>

        <FormField label="Pages to leave alone" htmlFor="onboarding-protected" badge="optional" className="md:col-span-2">
          <TagInput
            id="onboarding-protected"
            icon={ShieldCheck}
            values={protectedPaths}
            onChange={(next) => patch({ protectedPaths: next })}
            placeholder="Type a page path, starting with /"
            max={20}
            maxItemLength={FIELD_LIMITS.protectedPath}
            transform={normaliseProtectedPath}
          />
        </FormField>

        <FormSection className="md:col-span-2" title="Scheduled monitoring">
          <ToggleCard
            id="onboarding-monitoring"
            icon={CalendarClock}
            checked={monitoring}
            label="Re-analyze my store automatically"
            onToggle={(next) => patch({ autoAnalysis: next })}
          />
          {monitoring && (
            <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-surface-900">How often</p>
                <SegmentedControl
                  id="onboarding-frequency"
                  label="How often"
                  fill
                  value={frequency}
                  options={frequencies.map((option) => ({ value: option, label: option }))}
                  onChange={(value) => patch({ analysisFrequency: value })}
                />
              </div>
              <div>
                <label htmlFor="onboarding-scan-hour" className="mb-1.5 block text-[13px] font-semibold text-surface-900">
                  Preferred time{timeZone ? ` (${timeZone})` : ' (UTC)'}
                </label>
                <Combobox
                  id="onboarding-scan-hour"
                  icon={Clock3}
                  value={hour === null || hour === undefined ? '' : String(hour)}
                  options={[
                    { value: '', label: 'Any time it is due' },
                    ...SCAN_HOURS.map((value) => ({ value: String(value), label: formatScanHour(value) })),
                  ]}
                  placeholder="Any time it is due"
                  onChange={(value) => patch({ preferredScanHour: value === '' ? null : Number(value) })}
                />
              </div>
            </div>
          )}
          {monitoring && nextScan && (
            <p className="mt-2 text-[12.5px] leading-[1.4] text-surface-500">
              Next scan: <span className="font-semibold text-surface-900">{nextScan}</span>
            </p>
          )}
        </FormSection>


      </FormGrid>
    </div>
  );
}
