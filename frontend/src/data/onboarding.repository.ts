import { api, ApiError } from '../lib/api';

/**
 * ─── Guided setup ────────────────────────────────────────────────────
 *
 * Five steps a merchant completes after connecting their Shopify store:
 *
 *   1 Confirm the store   2 The business   3 Priorities   4 Measurement (optional)   5 Permissions
 *
 * Every suggestion in this flow is read from THEIR store — the shop name, domain, currency and
 * country from the shop record, the industry, keyword and question seeds derived from their own
 * collections and product types. Suggestions are offered beside a field, never written into it.
 *
 * Where the backend could not read something it says so explicitly (`detection.available: false`,
 * `suggestions.available: false`, `languages: null`). The UI must render those states as unknown.
 * It must never substitute an example value: a merchant who accepts an answer they did not check
 * has handed Rankvora AI a wrong input for every title tag it later writes.
 */

/** Answered or not. No third state: an unanswered step is unanswered however it got that way. */
export type StepStatus = 'complete' | 'pending';
export type SignalConfidence = 'high' | 'medium' | 'low';

export const TOTAL_STEPS = 5;

/**
 * The steps that block finishing. MIRRORS `REQUIRED_STEPS` in the backend: measurement (4) is not
 * one of them, because a store is fully auditable without Google and "Set up later" must never be a
 * reason the merchant cannot continue. The server also reports `required` on each step, and that is
 * what the UI reads — this exists for code that has no snapshot yet.
 */
export const REQUIRED_STEPS: readonly number[] = [1, 2, 3, 5];

export interface StepProgress {
  step: number;
  status: StepStatus;
  /** False only for the measurement step. */
  required: boolean;
}

/** Read live from the Shopify Admin API on every load. A null field means Shopify returned
 * nothing for it — not that a default was applied. */
export interface ShopContext {
  name: string;
  contactEmail: string | null;
  myshopifyDomain: string | null;
  primaryUrl: string | null;
  currencyCode: string | null;
  ianaTimezone: string | null;
  country: string | null;
  planName: string | null;
}

export interface OnboardingAnswers {
  organizationName: string | null;
  brandName: string | null;
  primaryDomain: string | null;
  industries: string[];
  sellsDescription: string | null;
  businessModels: string[];
  catalogShape: string | null;
  targetCountries: string[];
  targetLanguages: string[];
  primaryMarket: string | null;
  targetKeywords: string[];
  brandedTerms: string[];
  competitorDomains: string[];
  primaryGoal: string | null;
  priorityPillars: string[];
  automationConsent: AutomationConsent | null;
  alertFrequency: string | null;
}

/**
 * 'ask' is the behaviour for null too — an unanswered question is never consent to write.
 * 'low_risk' is LEGACY: setup no longer offers it (nothing applies a fix unless the merchant presses
 * Apply), but a store that chose it earlier still reads back as that choice.
 */
export type AutomationConsent = 'none' | 'ask' | 'low_risk';

/** A product or collection the merchant marked as a priority, named as their store names it. */
export interface PriorityResource {
  kind: 'product' | 'collection';
  handle: string;
  title: string;
}

/** The setup answers stored outside `onboarding_state` — see backend onboarding-preferences.service. */
export interface OnboardingPreferences {
  /** A locale code, e.g. "en" or "fr-CA". */
  contentLanguage: string | null;
  priorityResources: PriorityResource[];
  protectedPaths: string[];
  /** Local hour 0-23 in the store's own timezone, or null for "any hour". */
  preferredScanHour: number | null;
}

/** One thing the store can or cannot do, and why — see backend onboarding-capabilities.service. */
export type CapabilityStatus = 'complete' | 'action_required' | 'off' | 'unavailable';

export interface Capability {
  key: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
  action: { label: string; href: string } | null;
}

export interface MonitoringSchedule {
  enabled: boolean;
  frequency: string;
  preferredHour: number | null;
  timeZone: string | null;
  nextScanAt: string | null;
  lastAnalyzedAt: string | null;
}

export interface TrackedQuestion {
  id: number;
  query: string;
  active: boolean;
}

export interface OnboardingSnapshot {
  connected: boolean;
  currentStep: number;
  progress: StepProgress[];
  startedAt: string | null;
  deferredAt: string | null;
  completedAt: string | null;
  answers: OnboardingAnswers;
  preferences: OnboardingPreferences;
  /** What the store can actually do — the honest answer to "is setup finished?". */
  capabilities: Capability[];
  schedule: MonitoringSchedule;
  trackedQuestions: TrackedQuestion[];
  /** When the store was first analysed (the baseline), or null if it has not been. */
  firstAuditAt: string | null;
  detection: {
    available: boolean;
    unavailableReason: string | null;
    shop: ShopContext | null;
  };
  /** Sent by the server so the client's options cannot drift from what the API accepts. */
  options: {
    industries: string[];
    businessModels: string[];
    catalogShapes: string[];
    primaryGoals: string[];
    pillars: string[];
    alertFrequencies: string[];
    analysisFrequencies: string[];
  };
}

export interface DerivedAnswer {
  value: string;
  confidence: SignalConfidence;
  /** Why the store produced this answer, shown under the field so it can be judged. */
  basis: string;
}

export interface ShopLocale {
  locale: string;
  name: string | null;
  primary: boolean;
  published: boolean;
}

export interface OnboardingSuggestions {
  available: boolean;
  unavailableReason: string | null;
  industry: DerivedAnswer | null;
  catalogShape: DerivedAnswer | null;
  keywords: Array<{ value: string; source: string }>;
  /** Questions shoppers might ask an assistant, built from the store's own categories. Suggestions only. */
  questions: Array<{ value: string; source: string }>;
  brandedTerms: string[];
  /** Null means the shop would not disclose its locales — different from an empty list. */
  languages: ShopLocale[] | null;
  detectedCountry: string | null;
  catalogue: {
    productTotal: { count: number; exact: boolean } | null;
    collectionCount: number;
    sampledProducts: number;
  };
  /**
   * What the store holds. A null field means "not read", never zero. Pages and articles include
   * unpublished ones — Shopify offers no way to count only the published — and the screen says so.
   */
  content: {
    publishedProducts: { count: number; exact: boolean } | null;
    publishedCollections: { count: number; exact: boolean } | null;
    pages: { count: number; exact: boolean } | null;
    articles: { count: number; exact: boolean } | null;
  };
  /** The merchant's own products and collections, for the priority picker. Empty when unread. */
  resources: {
    products: Array<{ handle: string; title: string }>;
    collections: Array<{ handle: string; title: string }>;
  };
}

/** Answers for one step. Omitted keys are left untouched; null clears a field. */
export interface StepPayload {
  step: number;
  organizationName?: string | null;
  brandName?: string | null;
  primaryDomain?: string | null;
  contentLanguage?: string | null;
  priorityResources?: PriorityResource[];
  /** New questions to start tracking. Add-only: removing a tracked one happens in AI Discovery. */
  customerQuestions?: string[];
  protectedPaths?: string[];
  autoAnalysis?: boolean;
  analysisFrequency?: string;
  preferredScanHour?: number | null;
  industries?: string[];
  sellsDescription?: string | null;
  businessModels?: string[];
  catalogShape?: string | null;
  targetCountries?: string[];
  targetLanguages?: string[];
  primaryMarket?: string | null;
  targetKeywords?: string[];
  brandedTerms?: string[];
  competitorDomains?: string[];
  primaryGoal?: string | null;
  priorityPillars?: string[];
  automationConsent?: AutomationConsent | null;
  alertFrequency?: string | null;
}

export function fetchOnboarding(): Promise<OnboardingSnapshot> {
  return api.get<OnboardingSnapshot>('/onboarding');
}

let inflightSnapshot: Promise<OnboardingSnapshot> | null = null;

/**
 * The same read as `fetchOnboarding`, shared between components that mount together.
 *
 * The dashboard shows more than one panel built from the setup snapshot, and Settings shows another;
 * without this each would make its own identical request on the same page load. Concurrent callers
 * share one request, and a short window after it settles still answers from it, so a sibling that
 * mounts a moment later does not start another. It is NOT a cache: a read after the window is fresh.
 */
export function fetchOnboardingShared(): Promise<OnboardingSnapshot> {
  if (!inflightSnapshot) {
    inflightSnapshot = fetchOnboarding().finally(() => {
      window.setTimeout(() => {
        inflightSnapshot = null;
      }, 1500);
    });
  }
  return inflightSnapshot;
}

export function fetchOnboardingSuggestions(): Promise<OnboardingSuggestions> {
  return api.get<OnboardingSuggestions>('/onboarding/suggestions');
}

export function saveOnboardingStep(payload: StepPayload): Promise<OnboardingSnapshot> {
  return api.put<OnboardingSnapshot>('/onboarding/step', payload);
}

export function reopenOnboarding(): Promise<OnboardingSnapshot> {
  return api.post<OnboardingSnapshot>('/onboarding/reopen');
}

export function completeOnboarding(): Promise<OnboardingSnapshot> {
  return api.post<OnboardingSnapshot>('/onboarding/complete');
}

// ─── What every step requires ────────────────────────────────────────

/**
 * The answers a merchant cannot move past a step without.
 *
 * MIRRORS `stepIsAnswered` in backend/src/services/onboarding.service.ts, field for field. The
 * server decides — it refuses to finish setup while any of these is missing — and this copy exists
 * so the merchant is told which answer is needed, beside the field that needs it, instead of
 * meeting a 400 after pressing Continue.
 *
 * Everything not listed here is optional on purpose. The storefront domain falls back to Shopify's
 * own primary domain, languages come from the store's locales, and competitors, the priority order
 * and the alert frequency all have a defensible default. Only what Rankvora AI genuinely cannot audit
 * without — and cannot read for itself — is required.
 */
export type RequiredField =
  | 'organizationName'
  | 'targetCountries'
  | 'brandName'
  | 'industries'
  | 'contentLanguage'
  | 'priorityPillars'
  | 'automationConsent';

export const REQUIRED_FIELDS: Record<number, readonly RequiredField[]> = {
  1: ['organizationName', 'targetCountries'],
  2: ['brandName', 'industries', 'contentLanguage'],
  3: ['priorityPillars'],
  // Measurement is optional: nothing here blocks continuing.
  4: [],
  5: ['automationConsent'],
};

/** What the merchant is told when one is missing: the answer to give, not the rule they broke. */
export const REQUIRED_FIELD_MESSAGE: Record<RequiredField, string> = {
  organizationName: 'Confirm the store name your reports should use.',
  targetCountries: 'Choose at least one market that matters to your business.',
  brandName: 'Enter the brand name to use in your page titles.',
  industries: 'Choose at least one industry your store sells in.',
  contentLanguage: 'Choose the language your content is written in.',
  priorityPillars: 'Choose at least one area to improve first. Every area is still analysed.',
  automationConsent: 'Choose how changes to your store are approved.',
};

/** A blank string, a whitespace-only one and an empty list are all "not answered". */
function isAnswered(draft: StepPayload, field: RequiredField): boolean {
  const value = draft[field];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

/** The required answers `step` is still missing. Empty means the merchant may move on. */
export function missingRequired(step: number, draft: StepPayload): RequiredField[] {
  return (REQUIRED_FIELDS[step] ?? []).filter((field) => !isAnswered(draft, field));
}

/**
 * The first step still missing a required answer, or null when setup is ready to finish.
 *
 * Checked against the whole draft rather than the step on screen, because an answer can be cleared
 * on a step the merchant went back to — finishing must mean every step, not just the last one.
 */
export function firstUnansweredStep(draft: StepPayload): number | null {
  // Only steps with required fields can be returned: measurement has none, so it never is.
  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    if (missingRequired(step, draft).length > 0) return step;
  }
  return null;
}

// ─── Step metadata ───────────────────────────────────────────────────
// Titles and the one-line purpose shown in the stepper and page header. Copy, not data.

export const STEP_META: Array<{ step: number; title: string; purpose: string; optional?: boolean }> = [
  { step: 1, title: 'Confirm your store', purpose: 'Check what Shopify told us, and say which markets matter most.' },
  { step: 2, title: 'Your business', purpose: 'Your brand, what you sell and the language your content is written in.' },
  { step: 3, title: 'Priorities', purpose: 'What to improve first. Every area is still analysed — this decides what leads.' },
  {
    step: 4,
    title: 'Measurement',
    purpose: 'Connect the sources that show how you perform. Your first analysis runs without them.',
    optional: true,
  },
  { step: 5, title: 'Permissions & monitoring', purpose: 'How changes are approved, what to leave alone and when to re-scan.' },
];

/**
 * What setup OFFERS for publishing. Two choices, both true to what the product does: nothing is
 * applied unless the merchant presses Apply on a specific fix, so there is no "automatic" option to
 * offer — one that claimed to fill things in for the merchant would describe a feature that does
 * not exist.
 */
export const AUTOMATION_CONSENT_OPTIONS: Array<{ value: AutomationConsent; label: string; description: string }> = [
  {
    value: 'ask',
    label: 'Review every change before publishing',
    description: 'Rankvora AI prepares drafts. Nothing reaches your store until you approve that specific change. Recommended.',
  },
  {
    value: 'none',
    label: 'Never publish — recommendations only',
    description: 'Rankvora AI reports issues and shows you how to fix them. It writes nothing to your store.',
  },
];

/** How a stored consent reads on screen, including the legacy value setup no longer offers. */
export function consentLabel(value: AutomationConsent | null): string {
  if (value === 'low_risk') return 'Low-risk fixes publish automatically (an earlier choice)';
  return (AUTOMATION_CONSENT_OPTIONS.find((option) => option.value === (value ?? 'ask')) ?? AUTOMATION_CONSENT_OPTIONS[0]).label;
}

/**
 * The most questions a store may track at once. MIRRORS `MAX_PROMPT_QUERIES` in the backend
 * (ai-discovery.service.ts), which is what enforces it; this only lets the screen say how many are
 * left before a save would be refused.
 */
export const MAX_TRACKED_QUESTIONS = 25;

/**
 * What a merchant typed into the protected-pages field, as the path it means — or null if it is not
 * one. A pasted full address is accepted ("https://shop.example/pages/legal"), lower-cased, with no
 * query, fragment or trailing slash. MIRRORS `normalisePath` in the backend, which is what the
 * protection actually compares against; this keeps what the merchant sees equal to what is stored.
 */
export function normaliseProtectedPath(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const withoutOrigin = text.replace(/^https?:\/\/[^/]+/, '');
  const path = withoutOrigin.split('?')[0]?.split('#')[0] ?? '';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return trimmed || null;
}

/** The whole-hour choices for a preferred scan time, read in the store's own timezone. */
export const SCAN_HOURS: number[] = Array.from({ length: 24 }, (_, hour) => hour);

/** "03:00" — a 24-hour label that reads the same in every locale. */
export function formatScanHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * The English name of a language code ("fr-CA" becomes "French (Canada)"), or the code itself when
 * the platform does not know it — the code is still the true answer, where a guessed name is not.
 */
export function languageLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : code;
  } catch {
    return code;
  }
}

/**
 * The language codes offered when the merchant must pick one themselves: the store's own enabled
 * locales first (they are what the storefront really publishes), else the languages the platform can
 * name. The codes are ISO 639-1's own list, rendered by Intl — no names are typed into the source.
 */
export function languageChoices(storeLocales: Array<{ locale: string }> | null): string[] {
  const own = (storeLocales ?? []).map((entry) => entry.locale);
  if (own.length > 0) return [...new Set(own)];
  const standard =
    'ar bg bn ca cs da de el en es et fa fi fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nb nl pa pl pt ro ru sk sl sr sv sw ta te th tr uk ur vi zh'.split(
      ' ',
    );
  return standard.filter((code) => languageLabel(code) !== code);
}

/** The readable name of a capability's state, for screen readers and plain text. */
export const CAPABILITY_STATUS_LABEL: Record<CapabilityStatus, string> = {
  complete: 'Working',
  action_required: 'Needs you',
  off: 'Off',
  unavailable: 'Not available',
};

/**
 * Names the ISO 3166-1 alpha-2 codes through the browser's own locale data rather than shipping a
 * translated country table. `Intl.DisplayNames` is the platform's real reference data; the codes
 * below are the standard's own list.
 */
const ISO_3166_ALPHA2 =
  'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GG GH GI GL GM GN GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MQ MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS XK YE ZA ZM ZW'.split(
    ' ',
  );

let countryCache: string[] | null = null;

/**
 * Every country name, sorted. Used for the step 3 picker.
 *
 * Names — not codes — because `stores.country` and Shopify's `billingAddress.country` both hold a
 * name, and the detected country has to match an option in this list for the suggestion to apply.
 */
export function countryNames(): string[] {
  if (countryCache) return countryCache;
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    const names = ISO_3166_ALPHA2.map((code) => display.of(code)).filter((name): name is string => Boolean(name));
    countryCache = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch {
    // Intl.DisplayNames is unavailable on some older engines. The merchant can still type a
    // country; an empty option list is honest, an invented one is not.
    countryCache = [];
  }
  return countryCache;
}

/** Turns an API failure into wording a merchant can act on. */
export function describeOnboardingError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'STORE_NOT_FOUND') return 'We could not find your store.';
    // Both are written for the merchant: the domain one says what to type, and the incomplete one
    // names the step still missing an answer.
    if (error.code === 'ONBOARDING_INVALID_DOMAIN' || error.code === 'ONBOARDING_INCOMPLETE') return error.message;
    if (error.status === 400) return error.message;
  }
  return "We couldn't save that. Check your connection and try again.";
}
