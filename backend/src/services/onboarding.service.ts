import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { describeError } from '../lib/logger.js';
import { onboardingState, shopifyConnections, stores, users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { applyShopifyFacts, factsFromShop } from './store-profile.service.js';
import { hasStoreDataSource, resolveShopifyClient, StoreDataError } from '../audit-engine/store-data/index.js';
import {
  fetchCatalogSignals,
  fetchContentCounts,
  fetchShopIdentity,
  fetchShopLocales,
  type ContentCounts,
  type ResourceChoice,
  type ShopLocale,
} from '../audit-engine/store-data/shopify.queries.js';
import {
  CATALOG_SHAPES,
  INDUSTRY_OPTIONS,
  deriveBrandedTerms,
  deriveCatalogShape,
  deriveCustomerQuestions,
  deriveIndustry,
  deriveKeywords,
  type DerivedAnswer,
} from './onboarding-signals.js';
import {
  ALERT_FREQUENCIES,
  ANALYSIS_FREQUENCIES,
  BUSINESS_MODELS,
  PILLAR_KEYS,
  PRIMARY_GOALS,
  type SaveOnboardingStepInput,
} from '../schemas/onboarding.schema.js';
import {
  normalisePath,
  readOnboardingPreferences,
  writeOnboardingPreferences,
  type OnboardingPreferences,
} from './onboarding-preferences.service.js';
import {
  buildCapabilities,
  measurementConnected,
  type Capability,
  type MonitoringSchedule,
  type TrackedQuestion,
} from './onboarding-capabilities.service.js';
import { addPromptQuery } from './ai-discovery.service.js';

/**
 * ─── Guided setup ────────────────────────────────────────────────────
 *
 * Five steps, all state server-side so a merchant resumes on any device, on any step.
 *
 *   1  Confirm the store   what Shopify already told us, confirmed — storefront and markets
 *   2  The business        brand, aliases, industry, the language content is written in
 *   3  Priorities          what to improve first, plus optional keywords, products, competitors
 *                          and the questions customers ask an assistant
 *   4  Measurement         Search Console / Analytics / PageSpeed — OPTIONAL, and skippable
 *   5  Permissions         how changes are approved, what to leave alone, when to scan
 *
 * FOUR STEPS BLOCK FINISHING, not five. Connecting Google is not something every merchant can do
 * in the minute they are setting up, and a store can be audited completely without it — so step 4
 * never holds anyone back, and what it would have unlocked is reported as a CAPABILITY instead
 * (onboarding-capabilities.service.ts) rather than as a step they failed.
 *
 * THE RULE THIS FILE IS BUILT AROUND: a suggested answer is either read from the merchant's real
 * Shopify store or it is absent. Nothing here substitutes a plausible value for a missing one.
 * Suggestions are only ever offered — the UI never writes them into a field, so the answer
 * columns below hold nothing the merchant did not choose. When the Admin API cannot be reached,
 * `detection.available` is false and the UI says no suggestions could be read.
 *
 * Facts Shopify owns — store name, domain, currency, timezone, country, plan, catalogue size —
 * are read LIVE on every load rather than copied into our tables. A merchant who changes their
 * currency in Shopify sees the change here immediately, and there is no second copy to go stale.
 */

export const TOTAL_STEPS = 5;

/**
 * A step is answered or it is not. No third state: an unanswered step is unanswered whether it was
 * skipped or never opened, and rendering a skip as its own colour told merchants they had made
 * progress on a step that still counted for nothing.
 */
export type StepStatus = 'complete' | 'pending';

export interface StepProgress {
  step: number;
  status: StepStatus;
  /**
   * Whether this step blocks finishing. False only for the measurement step, which reports
   * `complete` when a source is genuinely connected and `pending` otherwise — honest either way,
   * and never a reason the merchant cannot continue.
   */
  required: boolean;
}

/** The steps whose answers must be in before setup can be finished. */
export const REQUIRED_STEPS = [1, 2, 3, 5] as const;

/** Whether a step blocks finishing. */
export function stepIsRequired(step: number): boolean {
  return (REQUIRED_STEPS as readonly number[]).includes(step);
}

/** What Shopify told us about the store, read live. Null fields mean Shopify returned nothing for
 * them — never that we substituted a default. */
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
  automationConsent: string | null;
  alertFrequency: string | null;
}

export interface OnboardingSnapshot {
  /** False when no live Shopify connection exists. Setup cannot run without one — every
   * pre-filled answer comes from the store — so the UI sends the merchant to connect first. */
  connected: boolean;
  currentStep: number;
  progress: StepProgress[];
  startedAt: string | null;
  deferredAt: string | null;
  completedAt: string | null;
  answers: OnboardingAnswers;
  /** The answers stored outside `onboarding_state` — see onboarding-preferences.service.ts. */
  preferences: OnboardingPreferences;
  /**
   * What this store can actually DO, each row derived from real state rather than from how many
   * questions were answered. This is what "finished" means now.
   */
  capabilities: Capability[];
  /** The real monitoring schedule, including when the next scan would start. */
  schedule: MonitoringSchedule;
  /** Questions already being tracked, so step 3 lists them instead of inviting duplicates. */
  trackedQuestions: TrackedQuestion[];
  /**
   * When the store was FIRST analysed — the baseline every later analysis is compared against.
   * Null until it has been. Read from the earliest real audit, so it cannot disagree with it.
   */
  firstAuditAt: string | null;
  detection: {
    available: boolean;
    /** Merchant-readable explanation when `available` is false. Never a raw Shopify message. */
    unavailableReason: string | null;
    shop: ShopContext | null;
  };
  /** The closed vocabularies the UI renders as options. Sent with the state so the client cannot
   * drift out of step with what the API will accept. */
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

export interface OnboardingSuggestions {
  available: boolean;
  unavailableReason: string | null;
  industry: DerivedAnswer<string> | null;
  catalogShape: DerivedAnswer<string> | null;
  /** Seeded from the merchant's own collections and product types. Empty for a store that has
   * neither — which the UI states plainly rather than filling in. */
  keywords: Array<{ value: string; source: string }>;
  /**
   * Questions shoppers might ask an assistant, built from the store's own categories and the
   * merchant's priority market. Suggestions only — none is tracked until the merchant adds it.
   */
  questions: Array<{ value: string; source: string }>;
  brandedTerms: string[];
  /** Null when the shop would not disclose its locales. Distinct from an empty list. */
  languages: ShopLocale[] | null;
  /** The shop's own country, from its Shopify billing address. */
  detectedCountry: string | null;
  catalogue: {
    productTotal: { count: number; exact: boolean } | null;
    collectionCount: number;
    sampledProducts: number;
  };
  /** Pages and articles the store holds. Null fields mean "not read", never zero. */
  content: ContentCounts;
  /**
   * The merchant's own products and collections, for the priority picker. Only what was actually
   * read — a store whose catalogue could not be read offers none rather than examples.
   */
  resources: { products: ResourceChoice[]; collections: ResourceChoice[] };
}

// ─── Row helpers ─────────────────────────────────────────────────────

/**
 * The market to phrase suggested questions around: the merchant's own primary market if they chose
 * one, else their first priority market, else the country Shopify reports for the shop. Null when
 * none exists, and then the questions are phrased without a place.
 */
function savedMarket(row: StateRow, shopCountry: string | null): string | null {
  const countries = stringArray(row.targetCountries);
  return row.primaryMarket?.trim() || countries[0] || shopCountry || null;
}

/** JSON columns come back as `unknown`. Accept only an array of strings; anything else is treated
 * as absent rather than coerced, so a malformed row cannot inject junk into an answer. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Reads the store's setup row, creating it on first access.
 *
 * Created lazily rather than at install: a row that exists only once a merchant has actually
 * opened setup makes "never started" answerable from the data, instead of being indistinguishable
 * from "started and answered nothing". */
async function loadOrCreateState(storeId: number) {
  const [existing] = await db.select().from(onboardingState).where(eq(onboardingState.storeId, storeId)).limit(1);
  if (existing) return existing;

  await db.insert(onboardingState).values({ storeId });
  const [created] = await db.select().from(onboardingState).where(eq(onboardingState.storeId, storeId)).limit(1);
  if (!created) throw new ApiError(500, 'Could not start guided setup', 'ONBOARDING_STATE_UNAVAILABLE');
  return created;
}

type StateRow = Awaited<ReturnType<typeof loadOrCreateState>>;

export function toAnswers(row: StateRow): OnboardingAnswers {
  return {
    organizationName: row.organizationName,
    brandName: row.brandName,
    primaryDomain: row.primaryDomain,
    industries: stringArray(row.industries),
    sellsDescription: row.sellsDescription,
    businessModels: stringArray(row.businessModels),
    catalogShape: row.catalogShape,
    targetCountries: stringArray(row.targetCountries),
    targetLanguages: stringArray(row.targetLanguages),
    primaryMarket: row.primaryMarket,
    targetKeywords: stringArray(row.targetKeywords),
    brandedTerms: stringArray(row.brandedTerms),
    competitorDomains: stringArray(row.competitorDomains),
    primaryGoal: row.primaryGoal,
    priorityPillars: stringArray(row.priorityPillars),
    automationConsent: row.automationConsent,
    alertFrequency: row.alertFrequency,
  };
}

/**
 * THE REQUIRED ANSWERS. One definition, used everywhere "is this step done?" is asked: the ticks
 * in the merchant's progress rail, whether `current_step` may advance, and whether setup may be
 * finished at all.
 *
 * A step counts as answered only when the answers that make it USEFUL are present — not merely
 * when it was visited. Step 4 with no keywords has taught the audit nothing, so calling it
 * complete would put a tick beside work that did not happen.
 *
 * Everything NOT listed here is genuinely optional and stays that way. The storefront domain falls
 * back to Shopify's own primary domain; languages, competitors and the priority order all have a
 * defensible default. Demanding an answer we can read or reason out ourselves would be a toll
 * booth, not a requirement.
 *
 * The client mirrors this rule field for field in `frontend/src/data/onboarding.repository.ts`, so
 * a merchant is told what is missing before the request is sent. This is the copy that decides.
 */
export function stepIsAnswered(
  answers: OnboardingAnswers,
  preferences: OnboardingPreferences,
  step: number,
  measurement: boolean,
): boolean {
  switch (step) {
    // Confirming the store: the organisation these reports are for, and the markets that matter.
    // The storefront domain is not demanded — left blank it falls back to Shopify's own primary
    // domain, which is the right answer for almost every store.
    case 1:
      return Boolean(answers.organizationName) && answers.targetCountries.length > 0;
    // The business: what to call it, what it sells, and the language to write in.
    case 2:
      return Boolean(answers.brandName) && answers.industries.length > 0 && Boolean(preferences.contentLanguage);
    // Priorities. Every area is still analysed; this only decides what leads.
    case 3:
      return answers.priorityPillars.length > 0;
    // Measurement is optional, so this reports the TRUTH rather than a tick: connected or not.
    case 4:
      return measurement;
    // How changes are approved. Null is not "no preference" — setup asks, and this is the answer.
    case 5:
      return Boolean(answers.automationConsent);
    default:
      return false;
  }
}

/**
 * The REQUIRED steps still missing an answer, in order. Empty means setup may be finished.
 *
 * The measurement step is absent by construction: it is not in REQUIRED_STEPS, so a merchant who
 * chose "Set up later" is never told they have an outstanding answer they do not have.
 */
export function unansweredSteps(answers: OnboardingAnswers, preferences: OnboardingPreferences): number[] {
  return REQUIRED_STEPS.filter((step) => !stepIsAnswered(answers, preferences, step, false));
}

/**
 * Whether each step has been answered.
 *
 * Read from the ANSWERS alone. `skipped_steps` is deliberately not consulted: a step on that list
 * was passed by before setup became mandatory, which today means exactly what an untouched step
 * means — it still has to be answered — and reporting it as its own state made the dashboard
 * contradict itself, showing two steps marked in progress above a count of "0 of 5 done".
 */
function computeProgress(
  row: StateRow,
  preferences: OnboardingPreferences,
  measurement: boolean,
): StepProgress[] {
  const answers = toAnswers(row);
  return Array.from({ length: TOTAL_STEPS }, (_, index) => {
    const step = index + 1;
    return {
      step,
      status: (stepIsAnswered(answers, preferences, step, measurement) ? 'complete' : 'pending') as StepStatus,
      required: stepIsRequired(step),
    };
  });
}

/** Merchant-facing wording for a failed Shopify read. Raw API messages describe our request, not
 * anything the merchant can act on, so they are never surfaced. */
function describeDetectionFailure(error: unknown): string {
  if (error instanceof StoreDataError) {
    switch (error.code) {
      case 'NOT_CONNECTED':
        return 'No connected Shopify store.';
      case 'TOKEN_REVOKED':
        return 'Shopify authorization has expired. Reconnect your store to continue setup.';
      case 'MISSING_SCOPES':
        return 'Rankvora AI is missing a Shopify permission needed to read your store. Reconnect to grant it.';
      case 'RATE_LIMITED':
        return 'Shopify is rate-limiting us right now. Your answers are saved — try again in a few minutes.';
      default:
        return "We couldn't reach Shopify to read your store details.";
    }
  }
  if (error instanceof ApiError && error.code === 'SHOPIFY_REAUTH_REQUIRED') {
    return 'Shopify authorization has expired. Reconnect your store to continue setup.';
  }
  return "We couldn't reach Shopify to read your store details.";
}

// ─── Reads ───────────────────────────────────────────────────────────

/**
 * The state of guided setup for the caller's store, plus the live shop context the first step
 * offers as suggestions.
 *
 * Never throws for a disconnected store: this is polled by the app shell to decide whether to
 * route a merchant into setup, and a 400 on every navigation would be both noisy and useless.
 */
export async function getOnboarding(userId: number, storeId?: number): Promise<OnboardingSnapshot> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const connected = await hasStoreDataSource(resolvedStoreId);
  const row = await loadOrCreateState(resolvedStoreId);
  const preferences = await readOnboardingPreferences(resolvedStoreId);
  const answers = toAnswers(row);

  // What the store can actually do, from our own rows. No Shopify, Google or AI call is made here:
  // the app shell polls this endpoint, and a capability list that cost a round trip to three
  // vendors would make every navigation wait on them.
  const { capabilities, schedule, trackedQuestions, firstAuditAt } = await buildCapabilities(
    resolvedStoreId,
    {
      organizationName: answers.organizationName,
      brandName: answers.brandName,
      industries: answers.industries,
      targetCountries: answers.targetCountries,
      priorityPillars: answers.priorityPillars,
      automationConsent: answers.automationConsent,
    },
    preferences,
  );

  let shop: ShopContext | null = null;
  let unavailableReason: string | null = null;

  if (connected) {
    try {
      const client = await resolveShopifyClient(resolvedStoreId);
      const identity = await fetchShopIdentity(client);
      shop = {
        name: identity.name,
        contactEmail: identity.contactEmail,
        myshopifyDomain: identity.myshopifyDomain,
        primaryUrl: identity.primaryUrl,
        currencyCode: identity.currencyCode,
        ianaTimezone: identity.ianaTimezone,
        country: identity.country,
        planName: identity.planName,
      };
    } catch (error) {
      unavailableReason = describeDetectionFailure(error);
      console.warn(
        `[scorelo-api] onboarding: shop detection failed for store ${resolvedStoreId} — ${describeError(error)}`,
      );
    }
  } else {
    unavailableReason = 'Connect your Shopify store to start guided setup.';
  }

  return {
    connected,
    currentStep: row.currentStep,
    progress: computeProgress(row, preferences, measurementConnected(capabilities)),
    startedAt: row.startedAt?.toISOString() ?? null,
    deferredAt: row.deferredAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    answers,
    preferences,
    capabilities,
    schedule,
    trackedQuestions,
    firstAuditAt,
    detection: { available: shop !== null, unavailableReason, shop },
    options: {
      industries: INDUSTRY_OPTIONS,
      businessModels: [...BUSINESS_MODELS],
      catalogShapes: [...CATALOG_SHAPES],
      primaryGoals: [...PRIMARY_GOALS],
      pillars: [...PILLAR_KEYS],
      alertFrequencies: [...ALERT_FREQUENCIES],
      analysisFrequencies: [...ANALYSIS_FREQUENCIES],
    },
  };
}

/**
 * Reads the merchant's catalogue and derives the answers steps 2, 3 and 4 suggest.
 *
 * A separate endpoint from `getOnboarding` on purpose: this reads a page of products and every
 * collection, which is far heavier than the single shop query the app shell polls. It is fetched
 * once, when the merchant actually reaches the steps that use it.
 */
export async function getOnboardingSuggestions(userId: number, storeId?: number): Promise<OnboardingSuggestions> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const row = await loadOrCreateState(resolvedStoreId);

  const empty: OnboardingSuggestions = {
    available: false,
    unavailableReason: null,
    industry: null,
    catalogShape: null,
    keywords: [],
    questions: [],
    brandedTerms: [],
    languages: null,
    detectedCountry: null,
    catalogue: { productTotal: null, collectionCount: 0, sampledProducts: 0 },
    content: { publishedProducts: null, publishedCollections: null, pages: null, articles: null },
    resources: { products: [], collections: [] },
  };

  if (!(await hasStoreDataSource(resolvedStoreId))) {
    return { ...empty, unavailableReason: 'Connect your Shopify store to see suggestions from your catalogue.' };
  }

  try {
    const client = await resolveShopifyClient(resolvedStoreId);
    // Identity first: brand terms are derived from the shop name, and the keyword seeds need them
    // in order to exclude the merchant's own brand from non-branded targets.
    const identity = await fetchShopIdentity(client);
    const brandedTerms = deriveBrandedTerms(identity.name, identity.myshopifyDomain);
    const signals = await fetchCatalogSignals(client);
    // Locales and the page/article counts are read last and can never fail the request — both
    // readers return "unknown" rather than throwing, and step 1 renders that as unknown.
    const languages = await fetchShopLocales(client);
    const content = await fetchContentCounts(client);

    return {
      available: true,
      unavailableReason: null,
      industry: deriveIndustry(signals),
      catalogShape: deriveCatalogShape(signals),
      keywords: deriveKeywords(signals, brandedTerms),
      questions: deriveCustomerQuestions(signals, brandedTerms, savedMarket(row, identity.country)),
      brandedTerms,
      languages,
      detectedCountry: identity.country,
      catalogue: {
        productTotal: signals.productTotal,
        collectionCount: signals.collections.length,
        sampledProducts: signals.sampledProducts,
      },
      content,
      resources: {
        products: signals.productChoices ?? [],
        collections: signals.collectionChoices ?? [],
      },
    };
  } catch (error) {
    console.warn(
      `[scorelo-api] onboarding: suggestions failed for store ${resolvedStoreId} — ${describeError(error)}`,
    );
    return { ...empty, unavailableReason: describeDetectionFailure(error) };
  }
}

// ─── Writes ──────────────────────────────────────────────────────────

/** "" means the merchant cleared the field; undefined means they did not touch it. Both are
 * preserved — collapsing them would make clearing a field impossible. */
function normaliseText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Case-insensitive dedupe that keeps the merchant's own capitalisation and ordering. */
function dedupe(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalises whatever the merchant typed into the storefront-domain field.
 *
 * A bare host ("example.com") and a full URL are both accepted — the first is what people
 * actually type — and a scheme is added when one is missing. `undefined` passes through untouched
 * and `""` clears the field; only genuinely unparseable input is rejected, with wording that says
 * what to do rather than quoting a validator.
 */
function normaliseDomain(value: string | null | undefined): string | null | undefined {
  const text = normaliseText(value);
  if (text === undefined || text === null) return text;

  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ApiError(400, 'Enter a valid storefront address, for example https://example.com', 'ONBOARDING_INVALID_DOMAIN');
  }
  // A hostname with no dot is not a public storefront — it is a typo or an intranet name, and
  // accepting it would send the crawler somewhere that can never be audited.
  if (!parsed.hostname.includes('.')) {
    throw new ApiError(400, 'Enter a valid storefront address, for example https://example.com', 'ONBOARDING_INVALID_DOMAIN');
  }
  // Stored origin-only: a path, query or fragment on the canonical domain would be carried into
  // every crawl URL built from it.
  return parsed.origin;
}

/** Strips a pasted URL down to a bare hostname so competitor entries compare cleanly. */
function toHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!trimmed) return null;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed) ? trimmed : null;
}

/**
 * Saves one step's answers.
 *
 * Only the fields belonging to `step` are written, even if the client sends more. That keeps a
 * replayed or malformed request from reaching across the form and overwriting an answer on a step
 * the merchant is not on.
 *
 * `current_step` only ever moves FORWARD, and only past a step that is now complete. Navigating
 * back to review step 2 must not reset a merchant's progress to step 2.
 */
export async function saveOnboardingStep(
  userId: number,
  input: SaveOnboardingStepInput,
  storeId?: number,
): Promise<OnboardingSnapshot> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const row = await loadOrCreateState(resolvedStoreId);

  // A completed setup stays editable, and saving into one does NOT un-complete it — `completedAt`
  // is left exactly as it is below. A merchant must be able to change their mind about which
  // keywords they target and, above all, about whether Rankvora AI may write to their store; locking
  // those behind a one-time flow would make the write gate unrevisitable.
  const updates: Partial<typeof onboardingState.$inferInsert> = { updatedAt: new Date() };
  const set = <K extends keyof typeof updates>(key: K, value: (typeof updates)[K] | undefined) => {
    if (value !== undefined) updates[key] = value;
  };

  /** The answers for this step that live outside `onboarding_state`. */
  const preferencePatch: Partial<OnboardingPreferences> = {};
  /** Settings on the store row itself, which take effect the moment they are saved. */
  const storeUpdates: Partial<typeof stores.$inferInsert> = {};

  switch (input.step) {
    // ── 1 · Confirm the store ────────────────────────────────────────
    case 1:
      set('organizationName', normaliseText(input.organizationName));
      set('primaryDomain', normaliseDomain(input.primaryDomain));
      set('targetCountries', dedupe(input.targetCountries));
      set('targetLanguages', dedupe(input.targetLanguages));
      set('primaryMarket', normaliseText(input.primaryMarket));
      break;
    // ── 2 · The business ─────────────────────────────────────────────
    case 2:
      set('brandName', normaliseText(input.brandName));
      set('brandedTerms', dedupe(input.brandedTerms));
      set('industries', dedupe(input.industries));
      set('sellsDescription', normaliseText(input.sellsDescription));
      set('businessModels', dedupe(input.businessModels));
      set('catalogShape', normaliseText(input.catalogShape));
      if (input.contentLanguage !== undefined) preferencePatch.contentLanguage = normaliseText(input.contentLanguage) ?? null;
      break;
    // ── 3 · Priorities ───────────────────────────────────────────────
    case 3:
      set('priorityPillars', input.priorityPillars ? [...new Set(input.priorityPillars)] : undefined);
      set('targetKeywords', dedupe(input.targetKeywords?.map((keyword) => keyword.toLowerCase())));
      set(
        'competitorDomains',
        input.competitorDomains === undefined
          ? undefined
          : dedupe(input.competitorDomains.map(toHostname).filter((host): host is string => host !== null)),
      );
      if (input.priorityResources !== undefined) preferencePatch.priorityResources = input.priorityResources;
      break;
    // ── 4 · Measurement ─────────────────────────────────────────────
    // Nothing is stored. Connecting Search Console or Analytics happens through their own OAuth
    // flows, and whether they are connected is read from those connections — recording a separate
    // "they said they would" would be a second, lying copy of that state.
    case 4:
      break;
    // ── 5 · Permissions and monitoring ──────────────────────────────
    case 5:
      set('automationConsent', normaliseText(input.automationConsent));
      set('alertFrequency', normaliseText(input.alertFrequency));
      // Accepted but no longer asked for; written when an older client still sends it, so an
      // answer already given is never silently dropped.
      set('primaryGoal', normaliseText(input.primaryGoal));
      if (input.protectedPaths !== undefined) {
        preferencePatch.protectedPaths = input.protectedPaths
          .map((path) => normalisePath(path))
          .filter((path): path is string => path !== null);
      }
      if (input.preferredScanHour !== undefined) preferencePatch.preferredScanHour = input.preferredScanHour ?? null;
      // These two are real store settings the scheduler already reads, so they are written to the
      // store rather than kept as a setup answer that would have to be applied later.
      if (input.autoAnalysis !== undefined) storeUpdates.autoAnalysis = input.autoAnalysis;
      if (input.analysisFrequency !== undefined) storeUpdates.analysisFrequency = input.analysisFrequency;
      break;
  }

  await db.update(onboardingState).set(updates).where(eq(onboardingState.id, row.id));

  if (Object.keys(preferencePatch).length > 0) {
    await writeOnboardingPreferences(resolvedStoreId, preferencePatch);
  }
  if (Object.keys(storeUpdates).length > 0) {
    await db.update(stores).set(storeUpdates).where(eq(stores.id, resolvedStoreId));
  }

  /**
   * The questions customers ask, started as tracked questions.
   *
   * ADD-ONLY, and tolerant: a question already tracked is left alone, and hitting the tracked
   * limit stops the loop instead of failing a save the merchant has already made. Removing one is
   * done where its observation history is shown, because deleting a question deletes that history.
   */
  if (input.step === 3 && input.customerQuestions && input.customerQuestions.length > 0) {
    const answers = toAnswers(row);
    for (const question of input.customerQuestions) {
      try {
        await addPromptQuery(resolvedStoreId, question, answers.brandName ?? undefined);
      } catch (error) {
        console.warn(
          `[scorelo-api] onboarding: question not tracked for store ${resolvedStoreId} — ${describeError(error)}`,
        );
      }
    }
  }

  // Re-read so progress is computed from what was actually stored, not from what we intended to
  // store. Advancement then follows real completion.
  const [saved] = await db.select().from(onboardingState).where(eq(onboardingState.id, row.id)).limit(1);
  if (!saved) throw new ApiError(500, 'Could not save your answers', 'ONBOARDING_STATE_UNAVAILABLE');

  const preferences = await readOnboardingPreferences(resolvedStoreId);
  // `false` for measurement: this decides whether the merchant may ADVANCE, and an optional step
  // must never be the thing that holds them — stepIsRequired below is what the rule turns on.
  const progress = computeProgress(saved, preferences, false);
  const stepDone = progress.find((entry) => entry.step === input.step)?.status === 'complete';
  // An optional step is always passable; a required one only once its answers are in.
  const mayAdvance = stepDone || !stepIsRequired(input.step);
  const nextStep = Math.min(TOTAL_STEPS, input.step + 1);
  if (mayAdvance && nextStep > saved.currentStep) {
    await db.update(onboardingState).set({ currentStep: nextStep }).where(eq(onboardingState.id, row.id));
  }

  return getOnboarding(userId, storeId);
}

/**
 * Re-entering setup, from the resume card or from Settings. Clears both the deferral and, for a
 * finished setup, the completion — so editing answers is possible without a second flow.
 *
 * Nothing writes `deferred_at` any more; only this clears it. Setup is mandatory and has no
 * "finish later", so the column now only holds deferrals recorded before that was true.
 */
/**
 * ─── The write gate ──────────────────────────────────────────────────
 *
 * Whether Rankvora AI may write to this store's catalogue, as the merchant answered in guided setup.
 *
 * READ WITHOUT CREATING STATE, and without resolving a user: this is called from the apply path,
 * which has already resolved the store from the authenticated request. A store that has never run
 * setup returns null, which is NOT consent — see the caller.
 *
 * The schema has called this column "THE WRITE GATE" since it was added, and until now nothing
 * enforced it: a merchant who chose "Never change my store" could still have fixes written to
 * their catalogue. Asking a permission question and then ignoring the answer is worse than never
 * asking, because the merchant believes they are protected.
 */
export async function automationConsentFor(storeId: number): Promise<string | null> {
  const [row] = await db
    .select({ automationConsent: onboardingState.automationConsent })
    .from(onboardingState)
    .where(eq(onboardingState.storeId, storeId))
    .limit(1);
  return row?.automationConsent ?? null;
}

/**
 * Whether a merchant-approved write may proceed, and why not when it may not.
 *
 * 'none'            refuses every write. Nothing else in the product may override it.
 * 'ask' | null      allowed HERE, and only because this path is approval itself: a human selected
 *                   these specific fixes and pressed Apply. An unanswered question is treated as
 *                   'ask' rather than as permission, which is why null is not simply allowed —
 *                   any future path that writes WITHOUT a per-fix approval must refuse on null too.
 * 'low_risk'        allowed.
 */
export function writeIsPermitted(consent: string | null): { allowed: boolean; reason: string } {
  if (consent === 'none') {
    return {
      allowed: false,
      // Names the answer back to the merchant and where to change it, so the refusal is actionable
      // rather than a door with no handle.
      reason:
        'Your setup answer is "Never change my store", so Rankvora AI writes nothing to your catalogue. Change it in guided setup, under Goals and permission to act, if you want to apply fixes.',
    };
  }
  return { allowed: true, reason: '' };
}

export async function reopenOnboarding(userId: number, storeId?: number): Promise<OnboardingSnapshot> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const row = await loadOrCreateState(resolvedStoreId);
  await db
    .update(onboardingState)
    .set({ deferredAt: null, completedAt: null, updatedAt: new Date() })
    .where(eq(onboardingState.id, row.id));
  return getOnboarding(userId, storeId);
}

/**
 * Maps the merchant's alert choice onto the notification toggles that gate the in-app bell (no
 * alert is sent by email).
 *
 * Only the four audit-related toggles are touched. `notifyIntegrationAlerts` and
 * `notifyProductUpdates` are about the connection and about Rankvora AI itself — neither is an audit
 * alert, and silently switching them from this question would be answering something the merchant
 * was not asked.
 */
/**
 * The industry list as one line, for `stores.industry` — a varchar(128) that Settings renders and
 * a merchant can edit there.
 *
 * TRUNCATES BY WHOLE ENTRIES, never mid-word. Slicing the joined string at 128 would leave
 * "Apparel & fashion, Jewellery & access" on the store record, which reads as a typo rather than
 * as a list that ran out of room. Anything dropped is still held in full on `industries`, which is
 * what every check reads — this column is a label, not the answer.
 */
function joinIndustries(industries: string[]): string {
  const LIMIT = 128;
  const kept: string[] = [];
  for (const industry of industries) {
    const candidate = [...kept, industry].join(', ');
    if (candidate.length > LIMIT) break;
    kept.push(industry);
  }
  // A single first entry longer than the column is not possible with the current vocabulary, but
  // a hard cut is still better than a failed write if one is ever added.
  return kept.length > 0 ? kept.join(', ') : industries[0]!.slice(0, LIMIT);
}

function notificationPreferences(alertFrequency: string | null) {
  switch (alertFrequency) {
    case 'Every audit':
      return { notifyAnalysisComplete: true, notifyCriticalIssues: true, notifyScoreChanges: true, notifyWeeklySummary: false };
    case 'Weekly summary':
      return { notifyAnalysisComplete: false, notifyCriticalIssues: true, notifyScoreChanges: false, notifyWeeklySummary: true };
    case 'Only critical issues':
      return { notifyAnalysisComplete: false, notifyCriticalIssues: true, notifyScoreChanges: false, notifyWeeklySummary: false };
    case 'No email alerts':
      return { notifyAnalysisComplete: false, notifyCriticalIssues: false, notifyScoreChanges: false, notifyWeeklySummary: false };
    default:
      // Not answered. The account keeps whatever it already had — an unanswered question must not
      // silently change a merchant's email settings.
      return null;
  }
}

/**
 * Finishes setup and applies the answers to the rest of the product.
 *
 * Two distinct kinds of value are written, from two distinct sources:
 *   • what SHOPIFY told us (store name, primary URL, country, timezone, currency) — read live and
 *     applied by the same rule as every refresh, which never overwrites a hand-edited value;
 *   • what the MERCHANT told us (organisation → workspace name, industry, canonical domain) —
 *     applied only when they actually answered, and after Shopify's, so an answer wins.
 *
 * A failed Shopify read does not fail completion. The merchant's answers are theirs and are saved
 * either way; the store record simply keeps the values it already had.
 */
export async function completeOnboarding(userId: number, storeId?: number): Promise<OnboardingSnapshot> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const row = await loadOrCreateState(resolvedStoreId);
  const answers = toAnswers(row);
  const setupPreferences = await readOnboardingPreferences(resolvedStoreId);

  // The REQUIRED steps, and this is where that is decided. The client blocks the merchant step by
  // step and names the field they are missing, which is the version they should ever see; this is
  // what holds when a request arrives some other way — a replay, a stale tab, a direct call.
  // The measurement step is not among them: a store is fully auditable without Google.
  const unanswered = unansweredSteps(answers, setupPreferences);
  if (unanswered.length > 0) {
    const label =
      unanswered.length === 1
        ? `step ${unanswered[0]}`
        : `steps ${unanswered.slice(0, -1).join(', ')} and ${unanswered[unanswered.length - 1]}`;
    throw new ApiError(400, `Answer ${label} before finishing setup.`, 'ONBOARDING_INCOMPLETE');
  }

  // Shopify's facts first, then the merchant's answers on top: an answer is their own choice and
  // wins over what Shopify reports (a store can publish its canonical content on another domain).
  if (await hasStoreDataSource(resolvedStoreId)) {
    try {
      const client = await resolveShopifyClient(resolvedStoreId);
      const identity = await fetchShopIdentity(client);
      const [connection] = await db
        .select({ shopDomain: shopifyConnections.shopDomain })
        .from(shopifyConnections)
        .where(and(eq(shopifyConnections.storeId, resolvedStoreId), isNull(shopifyConnections.uninstalledAt)))
        .limit(1);
      if (connection) {
        await applyShopifyFacts(resolvedStoreId, factsFromShop({
          shopDomain: connection.shopDomain,
          name: identity.name,
          primaryUrl: identity.primaryUrl,
          country: identity.country,
          currency: identity.currencyCode,
          timezone: identity.ianaTimezone,
        }));
      }
    } catch (error) {
      console.warn(
        `[scorelo-api] onboarding: could not refresh store facts from Shopify for store ${resolvedStoreId} — ${describeError(error)}`,
      );
    }
  }

  const storeUpdates: Partial<typeof stores.$inferInsert> = {};
  // "Organisation name — the business name used across your reports" names the WORKSPACE (the
  // organisation). It used to overwrite the STORE name, so whatever was typed here replaced the
  // shop's real name from Shopify — which is how a store came to be called "fdfd".
  if (answers.organizationName) storeUpdates.workspaceName = answers.organizationName;
  if (answers.primaryDomain) storeUpdates.url = answers.primaryDomain;
  if (answers.industries.length > 0) storeUpdates.industry = joinIndustries(answers.industries);

  if (Object.keys(storeUpdates).length > 0) {
    await db.update(stores).set(storeUpdates).where(eq(stores.id, resolvedStoreId));
  }

  const preferences = notificationPreferences(answers.alertFrequency);
  if (preferences) {
    await db.update(users).set(preferences).where(eq(users.id, userId));
  }

  await db
    .update(onboardingState)
    .set({ completedAt: new Date(), deferredAt: null, currentStep: TOTAL_STEPS, updatedAt: new Date() })
    .where(eq(onboardingState.id, row.id));

  console.log(`[scorelo-api] onboarding: guided setup completed for store ${resolvedStoreId} (user ${userId})`);
  return getOnboarding(userId, storeId);
}
