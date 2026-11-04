// Insert or update, and hand back the rows exactly as written.
//
// SQLite (and so Cloudflare D1) has a RETURNING clause, so the row comes back from the same
// statement that wrote it — atomically, with no follow-up read. These helpers existed because MySQL
// had no RETURNING and had to re-read by id; they keep their names and shapes so the 40-odd callers
// are unchanged, and are now thin wrappers over `.returning()`.

import type { SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { db } from './client.js';

/** Every table in this schema has an auto-increment `id`. */
type TableWithId = SQLiteTable & { id: SQLiteColumn };

/** Inserts one row and returns it as stored, defaults included. */
export async function insertReturning<T extends TableWithId>(
  table: T,
  values: T['$inferInsert'],
): Promise<T['$inferSelect']> {
  // The casts are Drizzle's generics, not a loosening: `values` is already typed by T above.
  const [row] = (await db.insert(table).values(values as never).returning()) as T['$inferSelect'][];
  if (!row) throw new Error(`insertReturning: ${String(table)} returned no row`);
  return row;
}

/**
 * Updates the rows matching `where` and returns them as they are after the update.
 *
 * One statement, so the rows returned are exactly the rows changed — even when the update changes
 * the very column the predicate tests (marking every unread notification as read, say).
 */
export async function updateReturning<T extends TableWithId>(
  table: T,
  values: Partial<T['$inferInsert']>,
  where: SQL | undefined,
): Promise<T['$inferSelect'][]> {
  return (await db.update(table).set(values as never).where(where).returning()) as T['$inferSelect'][];
}
