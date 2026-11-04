import { z } from 'zod';
import { CATALOG_SHAPES, INDUSTRY_OPTIONS } from '../services/onboarding-signals.js';

/**
 * ─── Guided setup request shapes ─────────────────────────────────────
 *
 * Every answer is optional AT THE SCHEMA LEVEL, and that is deliberate: this endpoint saves the
 * merchant's work in progress, including a half-filled step they are still typing into. Which
 * answers a step cannot be finished without is a product rule, not a shape — it lives in
 * `onboarding.service.ts`, is what decides whether a step counts as complete, and is what stops
 * setup being finished with a step unanswered.
 *
 * What is NOT optional is that a value, once sent, is one Rankvora AI can act on — so the closed
 * vocabularies below are enumerated rather than accepted as free strings. `.strict()` throughout:
 * an unknown key is a bug in the client, and silently dropping it would let a mislabelled field
 * look like it saved.
 *
 * Empty strings are normalised to null by the service, not here, so the distinction between
 * "cleared the field" and "never touched it" survives validation.
 */

export const BUSINESS_MODELS = [
  'Direct to consumer',
  'B2B or wholesale',
  'Subscription',
  'Made to order',
  'Print on demand',
  'Marketplace or multi-vendor',
] as const;

/**
 * How often a scheduled analysis runs. The SAME four `updateStoreSchema` accepts for
 * `stores.analysis_frequency`, because step 5 writes that column directly — a fifth value here
 * would be accepted by setup and then refused by the store endpoint.
 */
export const ANALYSIS_FREQUENCIES = ['Daily', 'Weekly', 'Fortnightly', 'Monthly'] as const;

/**
 * LEGACY. The single "what matters most" answer setup used to require, before priorities became a
 * multiple choice over the pillars themselves (`priorityPillars`). Still accepted so an older
 * client's request is not rejected, and still read back, so an answer already stored is not lost —
 * but nothing asks for it any more.
 */
export const PRIMARY_GOALS = [
  'Grow organic traffic',
  'Rank for specific keywords',
  'Fix technical SEO issues',
  'Improve conversion rate',
  'Get found by AI assistants',
] as const;

/** Must match the pillar route slugs — these order the dashboard and rank findings. */
export const PILLAR_KEYS = ['seo', 'speed', 'content', 'cro', 'ai-discovery'] as const;

/**
 * The write gate. Stored as a slug rather than a label because it is read by code, not only
 * displayed: 'ask' is the default everywhere a value is missing.
 */
export const AUTOMATION_CONSENTS = ['none', 'ask', 'low_risk'] as const;

export const ALERT_FREQUENCIES = [
  'Every audit',
  'Weekly summary',
  'Only critical issues',
  'No email alerts',
] as const;

/** Trimmed, length-capped free text that treats "" as an explicit clear. */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/** A short list of trimmed, non-empty strings. Deduplication happens in the service, where the
 * comparison can be case-insensitive without changing what the merchant typed. */
const stringList = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);

export const saveOnboardingStepSchema = z
  .object({
    /** Which step produced this payload. Drives which fields are allowed to advance progress. */
    step: z.number().int().min(1).max(5),

    // Step 1
    organizationName: optionalText(255),
    brandName: optionalText(255),
    /**
     * Accepted as loose text and normalised in the service, NOT validated as a URL here.
     *
     * `z.string().url()` rejects both of the two things a merchant most often does in this field:
     * clearing it (""), and typing a bare host ("example.com"). Both are reasonable inputs, and
     * answering either with a 400 from a schema would make the field feel broken. The service
     * adds a scheme when one is missing and rejects what is genuinely unparseable, with wording
     * that says what to type.
     */
    primaryDomain: optionalText(512),

    /** The language drafts are written in and content is judged against: a locale code ("en", "fr-CA"). */
    contentLanguage: optionalText(35),

    // Step 2
    /**
     * LISTS, both of them. A catalogue routinely spans categories — beauty and supplements,
     * apparel and accessories — and a store is routinely DTC *and* wholesale. These answers decide
     * which checks apply, so forcing one value narrowed the audit to whichever the merchant
     * happened to pick first.
     *
     * Still a closed vocabulary per entry: the values are read by code, not only displayed.
     * Capped at the vocabulary's own length, since selecting the same option twice is the only way
     * to exceed it and dedupe in the service handles that.
     */
    industries: z.array(z.enum(INDUSTRY_OPTIONS as [string, ...string[]])).max(INDUSTRY_OPTIONS.length).optional(),
    sellsDescription: optionalText(500),
    businessModels: z.array(z.enum(BUSINESS_MODELS)).max(BUSINESS_MODELS.length).optional(),
    /** Single by design: focused and broad are opposite crawl plans, and a store cannot be both. */
    catalogShape: z.enum(CATALOG_SHAPES).nullish(),

    // Step 3
    targetCountries: stringList(50, 120).optional(),
    targetLanguages: stringList(50, 35).optional(),
    primaryMarket: optionalText(120),

    // Step 4
    targetKeywords: stringList(10, 60).optional(),
    brandedTerms: stringList(10, 80).optional(),
    competitorDomains: stringList(3, 253).optional(),

    /**
     * Products and collections to weight ahead of the rest. The merchant picks them from their own
     * catalogue, so each entry carries the handle that identifies it and the title it was shown as.
     */
    priorityResources: z
      .array(
        z
          .object({
            kind: z.enum(['product', 'collection']),
            handle: z.string().trim().min(1).max(255),
            title: z.string().trim().min(1).max(255),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    /**
     * Questions customers ask an assistant, to be tracked for whether this store gets named.
     *
     * ADD-ONLY here, and deliberately: a tracked question owns its observation history, so letting
     * this list delete one would destroy a measurement the merchant has been accruing. Removing is
     * done where that history is shown (AI Discovery), which is also where the limit is enforced.
     */
    customerQuestions: z.array(z.string().trim().min(3).max(500)).max(10).optional(),

    // Step 5
    primaryGoal: z.enum(PRIMARY_GOALS).nullish(),
    priorityPillars: z.array(z.enum(PILLAR_KEYS)).max(PILLAR_KEYS.length).optional(),
    automationConsent: z.enum(AUTOMATION_CONSENTS).nullish(),
    alertFrequency: z.enum(ALERT_FREQUENCIES).nullish(),
    /** Storefront paths Rankvora AI must never propose or apply a change to. */
    protectedPaths: stringList(20, 512).optional(),
    /** Whether a scheduled analysis runs at all. Writes `stores.auto_analysis`. */
    autoAnalysis: z.boolean().optional(),
    /** How often it runs. Writes `stores.analysis_frequency`. */
    analysisFrequency: z.enum(ANALYSIS_FREQUENCIES).optional(),
    /** The local hour (0–23, the store's own timezone) a scheduled run may start in. */
    preferredScanHour: z.number().int().min(0).max(23).nullish(),
  })
  .strict();

export type SaveOnboardingStepInput = z.infer<typeof saveOnboardingStepSchema>;
