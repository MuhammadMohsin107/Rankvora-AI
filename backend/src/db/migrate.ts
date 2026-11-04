// One-shot migration runner for the LOCAL SQLite database (npm run db:migrate, DATABASE_PATH).
// Applies ./drizzle-d1 — the same files `wrangler d1 migrations apply` applies to Cloudflare D1 —
// with drizzle-orm's programmatic migrator, so failures surface with real error messages.
import { sql } from 'drizzle-orm';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import { closeDatabase, db } from './client.js';
import { describeError } from '../lib/logger.js';

try {
  // Drizzle hands over each migration's statements; they run in order on the same database.
  await migrate(db as unknown as SqliteRemoteDatabase, async (statements) => {
    for (const statement of statements) await db.run(sql.raw(statement));
  }, { migrationsFolder: './drizzle-d1' });
  console.log('[scorelo-db] migrations applied');
} catch (error) {
  // describeError, not error.message: drizzle's message names only the SQL it was running, and the
  // reason is on `error.cause`.
  console.error(`[scorelo-db] migration failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
