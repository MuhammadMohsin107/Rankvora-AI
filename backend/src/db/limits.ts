/**
 * ─── Cloudflare D1's per-statement limit ─────────────────────────────
 *
 * D1 accepts at most 100 bound values in one SQL statement (Cloudflare's D1 limits page: "Max bound
 * parameters per query: 100"). A multi-row insert binds every value of every row, so writing many
 * rows means writing them in groups.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Splits `rows` into groups whose bound values together stay within D1's limit, keeping their order.
 * `valuesIn(row)` is how many values one row binds — measured from the real statement, e.g.
 * `db.insert(table).values(row).toSQL().params.length`, so nothing here guesses at column counts.
 *
 * A single row over the limit cannot be written to D1 at all, so that throws rather than sending a
 * statement D1 would refuse.
 */
export function groupForD1<T>(rows: readonly T[], valuesIn: (row: T) => number, limit = D1_MAX_BOUND_PARAMETERS): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const row of rows) {
    const values = valuesIn(row);
    if (values > limit) throw new Error(`One row binds ${values} values; D1 accepts at most ${limit} in a statement.`);
    if (current.length > 0 && used + values > limit) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(row);
    used += values;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** D1 refuses a statement longer than this many bytes (limits page: "Max SQL statement length: 100,000 bytes"). */
export const D1_MAX_STATEMENT_BYTES = 100_000;

/**
 * How many ids go in one `IN (...)` list. D1 counts every bound value in a statement, so a list of
 * 100 ids plus the store id beside it is 101 and is refused. 90 leaves room for the handful of other
 * values the same statement binds (a store id, the new status and its timestamp); the test in
 * tests/d1-limits.test.ts measures the real statements, so the room is checked, not assumed.
 */
export const D1_ID_LIST_SIZE = 90;

/** Splits a list of ids (or any bound values) into pieces small enough for one `IN (...)` each, keeping order. */
export function chunkForD1<T>(values: readonly T[], size = D1_ID_LIST_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}
