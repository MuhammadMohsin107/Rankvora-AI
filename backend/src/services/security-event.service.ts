import { db } from '../db/client.js';
import { securityEvents } from '../db/schema.js';
import type { RequestMetadata } from '../lib/requestMetadata.js';
import { describeError } from '../lib/logger.js';

/**
 * ─── Security event log ──────────────────────────────────────────────
 *
 * THE ONLY WRITER to `security_events`. Everything that records an event goes through
 * recordSecurityEvent(), which is what makes the no-credentials rule enforceable: there is one
 * function to audit, not a dozen scattered inserts.
 *
 * WHAT AN EVENT IS: a statement that an action happened, to whom, when, and — where the request
 * genuinely carried them — from what IP and User-Agent. It is never a record of the credential
 * involved. No refresh token, access token or hash of either is written here or accepted by this
 * module's types.
 *
 * NOTHING SEEDS THIS TABLE. An account that has taken no security action has no events.
 */

/**
 * The complete vocabulary of events this code records. Adding a member here without adding it to
 * the table's CHECK constraint would fail at insert time rather than silently widening.
 *
 * The constraint also still lists three events nothing records any more (see the note on
 * security_events in db/schema.ts), so rows copied from the old database are not refused.
 */
export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'session_revoked'
  | 'sessions_revoked';

/**
 * Non-secret context. The value type deliberately excludes strings that could carry a credential
 * by convention — callers pass counts and identifiers, never token material.
 *
 * Reviewed at every call site in this codebase: the only values passed are integers (how many
 * sessions a revoke ended) and internal row ids.
 */
export type SecurityEventMetadata = Record<string, number | boolean | null>;

export interface RecordEventInput {
  userId: number;
  type: SecurityEventType;
  /** Real request metadata, or nulls. Never fabricated — see lib/requestMetadata.ts. */
  metadata?: RequestMetadata;
  context?: SecurityEventMetadata;
}

/**
 * Appends one event.
 *
 * NEVER THROWS. An audit write failing must not take down the action it was describing: a
 * merchant whose sign-in succeeded should not see an error because the log insert lost a race. The
 * failure is logged for operators and swallowed for the caller.
 *
 * The trade-off is stated rather than hidden: this log is best-effort evidence for the account
 * owner, not a compliance-grade audit trail with delivery guarantees. Making it authoritative
 * would mean failing the user's action when logging fails, which is the wrong trade here.
 */
export async function recordSecurityEvent(input: RecordEventInput): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      userId: input.userId,
      type: input.type,
      ipAddress: input.metadata?.ipAddress ?? null,
      userAgent: input.metadata?.userAgent ?? null,
      // The column is `metadata`; the input calls it `context` so it cannot be confused with the
      // RequestMetadata above, which is a different thing entirely.
      metadata: input.context ?? null,
    });
  } catch (error) {
    // Message only. The input carries no credential, but this stays deliberately narrow anyway.
    console.error(
      `[scorelo-security] failed to record ${input.type} for user ${input.userId}: ${describeError(error)}`,
    );
  }
}
