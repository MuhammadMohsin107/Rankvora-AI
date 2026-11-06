import { formatReadTime, sequentialChecks, type ConnectorHealth, type HealthTone } from './connectorHealth';
import type { PageSpeedStatus } from './pagespeed.repository';

/**
 * ─── Is PageSpeed Insights actually working? ─────────────────────────
 *
 * Same contract as the Google connectors' verdict, and deliberately a different SHAPE of question,
 * because this connector is a different kind of thing. There is no account, no grant and no
 * property to choose: PageSpeed Insights measures a public url. What can go wrong is narrower —
 * there may be no storefront to measure, or Google may have refused or failed the last run.
 *
 * WORKING means exactly one thing here too: Google completed a real measurement of this store's
 * storefront, and has not failed one since. A connector that has never been run is NOT working —
 * it is a connector that has never been run, and the badge says so.
 *
 * Pure — no fetching — so the catalogue card, the drawer and the panel cannot disagree.
 */

export const PAGESPEED_PROVIDER = 'pagespeed';

export type PageSpeedHealthState =
  /** No store connected, so there is no storefront to point Google at. */
  | 'no_storefront'
  /** A storefront exists, but no measurement has ever been taken. */
  | 'never_measured'
  /** The last attempt failed, or completed for only one of the two devices. */
  | 'failing'
  /** Google measured the storefront and did not fail afterwards. */
  | 'working';

export interface PageSpeedHealth extends ConnectorHealth {
  state: PageSpeedHealthState;
  /** Whether a measurement can honestly be offered right now. */
  canRun: boolean;
  /** The storefront Google is pointed at, for the panel to show. */
  storefrontUrl: string | null;
}

const BADGES: Record<PageSpeedHealthState, { label: string; tone: HealthTone }> = {
  // Names the missing step rather than grading the setup — the same reason the Google connectors
  // say "Choose a property" instead of "Setup incomplete".
  no_storefront: { label: 'Connect a store', tone: 'neutral' },
  never_measured: { label: 'Not measured', tone: 'warning' },
  failing: { label: 'Not working', tone: 'critical' },
  working: { label: 'Working', tone: 'success' },
};

/**
 * The first thing standing between this connector and a real measurement.
 *
 * A failure ranks above a missing measurement because a run that just failed is what the merchant
 * has to deal with, even where an older successful reading is still on file.
 */
function stateOf(status: PageSpeedStatus): PageSpeedHealthState {
  if (!status.storefrontUrl) return 'no_storefront';
  if (status.lastError) return 'failing';
  if (!status.lastMeasuredAt) return 'never_measured';
  return 'working';
}

function describe(state: PageSpeedHealthState, status: PageSpeedStatus): { summary: string; nextStep: string | null } {
  switch (state) {
    case 'no_storefront':
      return {
        summary: 'No store connected to measure.',
        nextStep: 'Connect your Shopify store above.',
      };
    case 'never_measured':
      return {
        summary: `Ready to measure ${status.storefrontUrl}.`,
        nextStep: 'Run a measurement. It takes up to a minute.',
      };
    case 'failing':
      return {
        // Google's own reason, already written for the merchant by the service that caught it.
        summary: `The last measurement did not complete. ${status.lastError}`,
        nextStep: 'Fix the problem above, then measure again.',
      };
    case 'working':
      return {
        summary: `Last measured ${formatReadTime(status.lastMeasuredAt)}.`,
        nextStep: null,
      };
  }
}

/**
 * The same facts as a checklist, in the order they have to be fixed.
 *
 * Shorter than the Google connectors' list, and honestly so — there is no sign-in to configure, no
 * account to connect and no grant to check. Padding it out to match theirs would invent steps.
 */
function checksFor(state: PageSpeedHealthState, status: PageSpeedStatus) {
  return sequentialChecks([
    {
      label: 'Storefront available',
      passed: Boolean(status.storefrontUrl),
      pass: status.storefrontUrl ?? '',
      fail: 'No Shopify store connected.',
    },
    {
      label: 'Last measurement completed',
      passed: !status.lastError,
      pass: 'No failure on record.',
      fail: status.lastError ?? '',
    },
    {
      label: 'Storefront measured',
      passed: Boolean(status.lastMeasuredAt),
      pass: `Last measured ${formatReadTime(status.lastMeasuredAt)}.`,
      fail: 'Not measured yet.',
      // Not-yet-run is not a fault. It is the step that has not happened.
      failOutcome: 'pending' as const,
    },
  ]).map((check) =>
    // A failed run leaves an older successful measurement on file. The row still describes it,
    // because deleting a real reading from the checklist would hide a fact the merchant has.
    check.label === 'Storefront measured' && state === 'failing' && status.lastMeasuredAt
      ? { ...check, outcome: 'pass' as const, detail: `Last successful measurement ${formatReadTime(status.lastMeasuredAt)}.` }
      : check);
}

export function pagespeedHealth(status: PageSpeedStatus): PageSpeedHealth {
  const state = stateOf(status);
  const { summary, nextStep } = describe(state, status);

  return {
    state,
    badge: BADGES[state],
    displayStatus: state === 'working' ? 'Connected' : state === 'no_storefront' ? 'Not Connected' : 'Needs Attention',
    summary,
    nextStep,
    checks: checksFor(state, status),
    canRun: Boolean(status.storefrontUrl),
    storefrontUrl: status.storefrontUrl,
    // No account by design: PageSpeed Insights asks for no merchant credential. The storefront is
    // what identifies the measurement, and it is shown in its own right rather than dressed up as
    // an account so this card can match the shape of the Google ones.
    account: null,
    lastSyncedAt: status.lastMeasuredAt,
    lastError: status.lastError,
  };
}
