import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import { requireDatabasePath } from '../config/env.js';
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_STATEMENT_BYTES } from './limits.js';
import * as schema from './schema.js';

/**
 * ─── Where a query goes ──────────────────────────────────────────────
 *
 * `db` is imported by more than fifty files and is used the same way everywhere. What it points at
 * depends on where the code runs. Both are SQLite, with the same tables (schema.ts):
 *
 *   Cloudflare Workers (worker.ts)    Cloudflare D1, through the D1 binding. worker.ts runs every
 *                                     request, workflow step and cron tick inside runWithDatabase(),
 *                                     and `db` is that database for all of it.
 *   Node (tests, scripts, server.ts)  A SQLite file on this machine (DATABASE_PATH), opened on first
 *                                     use with Node's built-in node:sqlite — no driver to install.
 *
 * Callers never see the difference: both are asynchronous Drizzle SQLite databases.
 */

/**
 * A Drizzle SQLite database with this app's schema — D1 on Cloudflare, node:sqlite on Node.
 *
 * The result type of `.run()` differs between the two drivers, so it is left open. Code here does
 * not read it: rows written are read back with `.returning()`, which is the same on both.
 *
 * WRITES THAT BELONG TOGETHER GO IN `batch()`, NEVER `transaction()`. D1 refuses an interactive
 * transaction outright ("To execute a transaction, please use the state.storage.transaction() ...
 * APIs instead of the SQL BEGIN TRANSACTION"), and writes nothing. A batch is D1's transaction:
 * its statements run in order as one unit, all of them or none. Both drivers here provide it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = BaseSQLiteDatabase<'async', any, typeof schema> & {
  batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>;
};

/** One statement for `db.batch()`: a query built but not yet awaited. */
export type BatchStatement = BatchItem<'sqlite'>;

// ─── Cloudflare: the D1 database, per request ────────────────────────

const requestDatabase = new AsyncLocalStorage<Database>();

/** Runs `run` with `db` bound to `database`, for everything it awaits as well. */
export function runWithDatabase<T>(database: Database, run: () => T): T {
  return requestDatabase.run(database, run);
}

// ─── Node: a SQLite file, opened on first use ────────────────────────

type SqliteParam = string | number | bigint | null | Uint8Array;
type QueryMethod = 'run' | 'all' | 'values' | 'get';

let nodeDb: Database | undefined;
let nodeSqlite: import('node:sqlite').DatabaseSync | undefined;
let readOnly = false;

/**
 * Opens the Node database read-only, so SQLite itself refuses every write — from the caller or from
 * any service it calls. For the verify:* scripts, which must only ever look. Call before the first
 * query; it cannot change a database that is already open.
 */
export function useReadOnlyDatabase(): void {
  if (nodeDb) throw new Error('useReadOnlyDatabase() must be called before the database is first used');
  readOnly = true;
}

/**
 * Opened on first use rather than at import, so merely LOADING this module needs no database — a
 * Worker loads it and never has one. A Node process that has no DATABASE_PATH fails by name, here
 * (and at start-up, where server.ts asks for it up front).
 */
function nodeDatabase(): Database {
  if (nodeDb) return nodeDb;

  // Loaded here, not imported at the top: node:sqlite is a Node built-in that Workers does not have,
  // and this line only ever runs on Node.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const sqlite = new DatabaseSync(requireDatabasePath(), { readOnly });
  // D1 enforces foreign keys; a local database must behave the same, or a missing parent row that
  // D1 would refuse could pass every local test.
  sqlite.exec('PRAGMA foreign_keys = ON');

  const execute = (query: string, params: unknown[], method: QueryMethod): { rows: unknown } => {
    // D1's per-statement limits, enforced here too. SQLite itself accepts 32,766 bound values and
    // far longer statements, so without this a query D1 would refuse passes every local run and
    // fails only once deployed.
    if (params.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(`D1 allows at most ${D1_MAX_BOUND_PARAMETERS} bound values in a statement; this one binds ${params.length}.`);
    }
    if (Buffer.byteLength(query) > D1_MAX_STATEMENT_BYTES) {
      throw new Error(`D1 allows a statement of at most ${D1_MAX_STATEMENT_BYTES} bytes; this one is ${Buffer.byteLength(query)}.`);
    }
    const statement = sqlite.prepare(query);
    const bound = params as SqliteParam[];
    if (method === 'run') {
      statement.run(...bound);
      return { rows: [] };
    }
    // Drizzle's SQLite proxy driver reads rows as arrays of values in column order. Arrays rather
    // than objects, so two selected columns with the same name (a join) cannot overwrite each other.
    statement.setReturnArrays(true);
    if (method === 'get') return { rows: statement.get(...bound) };
    return { rows: statement.all(...bound) };
  };

  nodeDb = drizzleProxy(
    async (query, params, method) => execute(query, params, method) as { rows: never[] },
    // A batch runs as one transaction, as it does on D1: all of it, or none of it.
    async (queries) => {
      sqlite.exec('BEGIN');
      try {
        const results = queries.map(({ sql: query, params, method }) => execute(query, params, method));
        sqlite.exec('COMMIT');
        return results as { rows: never[] }[];
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    { schema },
  ) as unknown as Database;
  nodeSqlite = sqlite;
  return nodeDb;
}

/**
 * Runs one SQL statement on the Node database and returns its rows as plain objects. For the
 * verify:* scripts' own reports; the app itself always goes through `db`.
 */
export function queryRows(text: string): Record<string, unknown>[] {
  nodeDatabase();
  const rows = (nodeSqlite as import('node:sqlite').DatabaseSync).prepare(text).all();
  // node:sqlite hands back objects with no prototype; copied into ordinary objects so they behave
  // like any other value the scripts compare or print.
  return rows.map((row) => ({ ...row }));
}

/** Closes the Node database, for scripts and tests that are done with it. A no-op on Cloudflare. */
export function closeDatabase(): void {
  nodeSqlite?.close();
  nodeSqlite = undefined;
  nodeDb = undefined;
  readOnly = false;
}

// ─── What every caller imports ───────────────────────────────────────

/** Forwards to whichever database is current: the request's D1 database, or the Node file. */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const target = requestDatabase.getStore() ?? nodeDatabase();
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/** True when the database answers a trivial query. Never throws. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await db.run(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
