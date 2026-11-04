/**
 * ─── A real database for every test run ──────────────────────────────
 *
 * Some suites here are genuinely integration tests: they insert a user, a store and a connection
 * and assert on what the services actually wrote. They need a real database, and they get one: an
 * in-memory SQLite database built from the real D1 migration (drizzle-d1/), the same SQL Cloudflare
 * D1 runs. SQLite is the engine D1 is built on, so these run on every machine, every time — the
 * MySQL they once needed was usually absent, and they were skipped.
 *
 * ALWAYS IN MEMORY. DATABASE_PATH is set to ':memory:' unconditionally, before the database is first
 * opened, so no test can ever write to a developer's local database file, whatever .env says. The
 * database disappears with the test process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';

process.env.DATABASE_PATH = ':memory:';

const { db } = await import('../../db/client.js');

/** Applies every D1 migration, in order, to the in-memory database. */
async function migrate(): Promise<void> {
  const folder = path.resolve(import.meta.dirname, '../../../drizzle-d1');
  const files = fs.readdirSync(folder).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(folder, file), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.run(sql.raw(statement));
    }
  }
}

await migrate();
