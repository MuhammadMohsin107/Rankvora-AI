/**
 * True when `error` — or anything in its `cause` chain — is a UNIQUE constraint violation.
 *
 * Both databases this app runs on are SQLite and say so in the message: D1 reports
 * "D1_ERROR: UNIQUE constraint failed: jobs.store_id: SQLITE_CONSTRAINT", node:sqlite reports
 * "UNIQUE constraint failed: jobs.store_id". Drizzle wraps the driver's error in its own, with the
 * original on `cause`, so the whole chain is checked. (On MySQL this was the ER_DUP_ENTRY code.)
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error && /UNIQUE constraint failed/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
