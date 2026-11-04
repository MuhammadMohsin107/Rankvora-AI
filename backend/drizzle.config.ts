import { defineConfig } from 'drizzle-kit';

/**
 * Migrations for Cloudflare D1 (SQLite), generated from src/db/schema.ts into ./drizzle-d1.
 *
 * `npm run db:generate` needs no database: it compares the schema with the last snapshot and writes
 * the difference as a new SQL file. The files are applied to D1 with `wrangler d1 migrations apply`
 * and to a local SQLite file with `npm run db:migrate` (src/db/migrate.ts).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle-d1',
});
