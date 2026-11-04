import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { audits, googleConnections, jobs, promptQueries, shopifyConnections, stores } from '../db/schema.js';
import { googleConfigured } from '../config/env.js';
// The PURE schedule module, not auto-analysis.service: that service reaches the audit runner, and
// this file is read by the setup snapshot the app shell polls. Importing the arithmetic directly
// keeps a request for "when is the next scan" from pulling in the machinery that runs one.
import { FREQUENCY_DAYS, nextScheduledScanAt } from '../lib/analysisSchedule.js';
import type { OnboardingPreferences } from './onboarding-preferences.service.js';

/**
 * ─── What the store can actually DO ──────────────────────────────────
 *
 * Setup used to report one number: how many of five steps had been answered. That could read
 * "All answered" while the store had never been analysed and no measurement source was connected
 * — which is the opposite of the thing a merchant needs to know.
 *
 * So completion is reported by CAPABILITY instead: one row per thing the product can or cannot do
 * for this store, each with the reason and the one action that changes it.
 *
 * EVERY ROW IS DERIVED FROM REAL STATE, never from a stored summary that could go stale:
 *
 *   business context         the answers on `onboarding_state`
 *   store synchronization    `shopify_connections` (installed, and when it was last read)
 *   first audit              `audits` for this store, and any `jobs` row running now
 *   search measurement       `google_connections.site_url`
 *   traffic measurement      `google_connections.ga4_property_id`
 *   AI prompt monitoring     `prompt_queries` for this store
 *   publishing permissions   `onboarding_state.automation_consent`
 *   scheduled monitoring     `stores.auto_analysis` / `analysis_frequency` + the preferred hour
 *
 * There is no row for PageSpeed: it measures a public URL and asks for no account, so there is
 * nothing for a merchant to connect and nothing that could be "required".
 */

export type CapabilityStatus =
  /** Working. */
  | 'complete'
  /** The merchant has to do one thing for it to work. Never shown as a fault in their store. */
  | 'action_required'
  /** Deliberately switched off by the merchant. Not a problem. */
  | 'off'
  /** This server cannot offer it at all (no credentials configured), so it is not the merchant's to fix. */
  | 'unavailable';

export interface Capability {
  key: string;
  label: string;
  status: CapabilityStatus;
  /** The real state, in words: a date, a count, a mode. Never a value nothing recorded. */
  detail: string;
  /** Where the one action lives, when there is one. An in-app path, never an external URL. */
  action: { label: string; href: string } | null;
}

export interface MonitoringSchedule {
  enabled: boolean;
  frequency: string;
  /** Local hour (0–23) a scheduled run may start in, or null for any hour. */
  preferredHour: number | null;
  /** The store's IANA timezone as Shopify reported it, or null when it never did. */
  timeZone: string | null;
  /** When the next scheduled analysis would start, or null when scheduling is off or unknown. */
  nextScanAt: string | null;
  /** When this store was last analysed, whoever started it. */
  lastAnalyzedAt: string | null;
}

/** A question already being tracked for this store, so setup lists what exists before adding to it. */
export interface TrackedQuestion {
  id: number;
  query: string;
  active: boolean;
}

/** Enough of the setup row to judge the answer-based capabilities. */
export interface CapabilityAnswers {
  organizationName: string | null;
  brandName: string | null;
  industries: string[];
  targetCountries: string[];
  priorityPillars: string[];
  automationConsent: string | null;
}

const CONSENT_LABELS: Record<string, string> = {
  none: 'Nothing is ever written to your store',
  ask: 'Review every change before publishing',
  low_risk: 'Low-risk fixes publish automatically',
};

function formatDate(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/**
 * The capability rows for one store, and the monitoring schedule the dashboard states.
 *
 * One pass of small indexed reads. It is called from the setup snapshot, which the app shell polls,
 * so nothing here calls Shopify, Google or an AI provider — every answer comes from our own rows.
 */
export async function buildCapabilities(
  storeId: number,
  answers: CapabilityAnswers,
  preferences: OnboardingPreferences,
): Promise<{
  capabilities: Capability[];
  schedule: MonitoringSchedule;
  trackedQuestions: TrackedQuestion[];
  firstAuditAt: string | null;
}> {
  const [[store], [connection], [latestAudit], [firstAudit], [runningJob], [google], trackedQuestions] = await Promise.all([
    db.select().from(stores).where(eq(stores.id, storeId)).limit(1),
    db
      .select()
      .from(shopifyConnections)
      .where(and(eq(shopifyConnections.storeId, storeId), isNull(shopifyConnections.uninstalledAt)))
      .limit(1),
    db.select().from(audits).where(eq(audits.storeId, storeId)).orderBy(desc(audits.runAt), desc(audits.id)).limit(1),
    // The BASELINE: the first real analysis of this store. 'engine' only — a seeded development
    // fixture is not an analysis of anyone's store and must never be presented as the starting point.
    db
      .select({ runAt: audits.runAt })
      .from(audits)
      .where(and(eq(audits.storeId, storeId), eq(audits.source, 'engine')))
      .orderBy(asc(audits.runAt), asc(audits.id))
      .limit(1),
    db
      .select({ id: jobs.id, stage: jobs.stage, progress: jobs.progress })
      .from(jobs)
      .where(and(eq(jobs.storeId, storeId), inArray(jobs.status, ['queued', 'running'])))
      .limit(1),
    db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.storeId, storeId), isNull(googleConnections.disconnectedAt)))
      .limit(1),
    db
      .select({ id: promptQueries.id, query: promptQueries.query, active: promptQueries.active })
      .from(promptQueries)
      .where(eq(promptQueries.storeId, storeId))
      .orderBy(promptQueries.id),
  ]);

  const frequency = store?.analysisFrequency ?? 'Weekly';
  const scheduleEnabled = Boolean(store?.autoAnalysis) && Boolean(FREQUENCY_DAYS[frequency]);
  const lastAnalyzedAt = latestAudit?.runAt ?? null;
  // Shopify reports an IANA zone; 'Unspecified' is what the schema writes when it never did.
  const timeZone = store?.timezone && store.timezone !== 'Unspecified' ? store.timezone : null;

  const schedule: MonitoringSchedule = {
    enabled: scheduleEnabled,
    frequency,
    preferredHour: preferences.preferredScanHour,
    timeZone,
    nextScanAt: scheduleEnabled
      ? formatDate(nextScheduledScanAt(lastAnalyzedAt, frequency, { timeZone, preferredHour: preferences.preferredScanHour }))
      : null,
    lastAnalyzedAt: formatDate(lastAnalyzedAt),
  };

  const businessAnswered = Boolean(
    answers.organizationName && answers.brandName && answers.industries.length > 0 && answers.targetCountries.length > 0,
  );
  const prioritiesAnswered = answers.priorityPillars.length > 0;
  const activeQuestions = trackedQuestions.filter((row) => row.active).length;

  const capabilities: Capability[] = [
    {
      key: 'business_context',
      label: 'Business context',
      status: businessAnswered ? 'complete' : 'action_required',
      detail: businessAnswered
        ? `${answers.brandName} · ${answers.industries.join(', ')}`
        : 'Your brand, industry and markets decide which checks apply.',
      action: businessAnswered ? null : { label: 'Answer these', href: '/onboarding' },
    },
    {
      key: 'priorities',
      label: 'Optimization priorities',
      status: prioritiesAnswered ? 'complete' : 'action_required',
      detail: prioritiesAnswered
        ? `Leading with ${answers.priorityPillars.length} of your areas`
        : 'Choose what to improve first — every area is still analysed.',
      action: prioritiesAnswered ? null : { label: 'Choose', href: '/onboarding' },
    },
    {
      key: 'store_sync',
      label: 'Store synchronization',
      status: connection ? 'complete' : 'action_required',
      detail: connection
        ? `Connected to ${connection.shopDomain}`
        : 'No Shopify store is connected, so nothing can be read or fixed.',
      action: connection ? null : { label: 'Connect Shopify', href: '/integrations' },
    },
    {
      key: 'first_audit',
      label: 'First analysis',
      status: latestAudit ? 'complete' : 'action_required',
      detail: runningJob
        ? `Running now — ${runningJob.stage ?? 'starting'}`
        : latestAudit
          ? `Last analysed ${latestAudit.runAt.toISOString()}`
          : 'Your store has not been analysed yet.',
      action: latestAudit || runningJob ? null : { label: 'Start analysis', href: '/' },
    },
    {
      key: 'search_measurement',
      label: 'Search measurement',
      status: !googleConfigured()
        ? 'unavailable'
        : google?.siteUrl
          ? 'complete'
          : 'action_required',
      detail: !googleConfigured()
        ? 'Search Console is not configured on this server.'
        : google?.siteUrl
          ? `Reporting on ${google.siteUrl}`
          : google
            ? 'Connected — choose which Search Console property this store reports on.'
            : 'Connect Search Console for queries, clicks and positions. Your technical SEO audit runs either way.',
      action: !googleConfigured() ? null : { label: google ? 'Choose property' : 'Connect', href: '/integrations' },
    },
    {
      key: 'traffic_measurement',
      label: 'Traffic measurement',
      status: !googleConfigured() ? 'unavailable' : google?.ga4PropertyId ? 'complete' : 'action_required',
      detail: !googleConfigured()
        ? 'Google Analytics is not configured on this server.'
        : google?.ga4PropertyId
          ? `Reporting on property ${google.ga4PropertyId}`
          : 'Connect Analytics to see sessions referred by AI assistants. Everything else runs either way.',
      action: !googleConfigured() ? null : { label: google ? 'Choose property' : 'Connect', href: '/integrations' },
    },
    {
      key: 'ai_prompt_monitoring',
      label: 'AI prompt monitoring',
      status: activeQuestions > 0 ? 'complete' : 'action_required',
      detail:
        activeQuestions > 0
          ? `Tracking ${activeQuestions} customer question${activeQuestions === 1 ? '' : 's'}`
          : 'Add the questions customers ask, to see whether assistants name your store.',
      action: activeQuestions > 0 ? null : { label: 'Add questions', href: '/ai-discovery' },
    },
    {
      key: 'publishing_permissions',
      label: 'Publishing permissions',
      status: answers.automationConsent ? 'complete' : 'action_required',
      detail: answers.automationConsent
        ? CONSENT_LABELS[answers.automationConsent] ?? answers.automationConsent
        // Null genuinely behaves as review-first, and says so — an unanswered question is never
        // treated as permission to write.
        : 'Not answered, so Rankvora AI reviews every change with you before publishing.',
      action: answers.automationConsent ? null : { label: 'Set this', href: '/onboarding' },
    },
    {
      key: 'scheduled_monitoring',
      label: 'Scheduled monitoring',
      status: scheduleEnabled ? 'complete' : 'off',
      detail: scheduleEnabled
        ? `${frequency}${preferences.preferredScanHour !== null ? `, around ${String(preferences.preferredScanHour).padStart(2, '0')}:00` : ''}`
        : 'Scheduled analysis is off. You can still analyse your store whenever you like.',
      action: { label: 'Change schedule', href: '/onboarding' },
    },
  ];

  return { capabilities, schedule, trackedQuestions, firstAuditAt: formatDate(firstAudit?.runAt ?? null) };
}

/** Whether at least one measurement source is actually reporting. Drives the optional step's tick. */
export function measurementConnected(capabilities: Capability[]): boolean {
  return capabilities.some(
    (capability) =>
      (capability.key === 'search_measurement' || capability.key === 'traffic_measurement')
      && capability.status === 'complete',
  );
}
