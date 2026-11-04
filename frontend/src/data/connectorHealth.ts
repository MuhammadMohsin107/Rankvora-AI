/**
 * ─── Is a connector actually working? ────────────────────────────────
 *
 * The shape every connector's verdict shares, so the Integrations catalogue card, the detail
 * drawer and the connector's own panel read from one answer and cannot disagree with each other.
 *
 * The rule each connector implements against this shape is the same one: WORKING has exactly one
 * meaning — this connector's data source answered a real read, and has not refused one since.
 * Nothing is inferred from a status column a client can write.
 *
 * Verdicts are PURE functions of a status payload. No fetching happens here, which is what lets
 * the same verdict drive three places at once.
 */

export type HealthTone = 'neutral' | 'success' | 'warning' | 'critical';

export interface HealthCheck {
  label: string;
  /** `pending` = not reached yet: an earlier step failed, or no read has happened to judge by. */
  outcome: 'pass' | 'fail' | 'pending';
  detail: string;
}

export interface ConnectorHealth {
  badge: { label: string; tone: HealthTone };
  /** For the catalogue's three-way counts. Only a WORKING connector counts as connected. */
  displayStatus: 'Connected' | 'Needs Attention' | 'Not Connected';
  summary: string;
  /** The one thing to do next, or null when there is nothing to do. */
  nextStep: string | null;
  /** The same facts as a checklist, in the order they have to be fixed. */
  checks: HealthCheck[];
  /** The account behind the connection, where there is one. Null for connectors that need none. */
  account: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/**
 * Walks a connector's steps in dependency order and marks everything after the first failure as
 * `pending` — not passed and not failed, because it cannot be judged until that step is fixed.
 *
 * Shared because getting this wrong is how a checklist ends up showing green ticks below a broken
 * step, which reads as "these parts are fine" about things nothing has checked.
 */
export function sequentialChecks(
  steps: Array<{
    label: string;
    passed: boolean;
    pass: string;
    fail: string;
    /** Use 'pending' where not-yet-done is the honest reading, e.g. "no read has happened". */
    failOutcome?: HealthCheck['outcome'];
  }>,
): HealthCheck[] {
  let blocked = false;
  return steps.map((step): HealthCheck => {
    if (blocked) return { label: step.label, outcome: 'pending', detail: 'Waiting on the step above.' };
    if (step.passed) return { label: step.label, outcome: 'pass', detail: step.pass };
    blocked = true;
    return { label: step.label, outcome: step.failOutcome ?? 'fail', detail: step.fail };
  });
}

export function formatReadTime(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
