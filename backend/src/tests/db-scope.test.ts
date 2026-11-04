// ─── Which database a query goes to (npm test) ───────────────────────
// db/client.ts serves two runtimes: on Cloudflare every request runs inside runWithDatabase() with the
// D1 database, and on Node `db` is a local SQLite file. Here the Node database is the in-memory one
// the test helper builds from the real D1 migration, and the "request" databases are stand-ins that
// only record the SQL they receive — so what is proved is the ROUTING. No network, no Cloudflare.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy';
import './helpers/database.js';
import { db, pingDatabase, queryRows, runWithDatabase, useReadOnlyDatabase, type Database } from '../db/client.js';
import * as schema from '../db/schema.js';

/** A database that answers every query with no rows and records the SQL it was sent. */
function recordingDatabase() {
  const statements: string[] = [];
  const database = drizzleProxy(async (query) => {
    statements.push(query.toLowerCase());
    return { rows: [] };
  }, { schema }) as unknown as Database;
  return { database, statements };
}

describe('db outside a request (Node)', () => {
  it('is the local SQLite database, with the D1 tables in it', async () => {
    const [user] = await db.insert(schema.users).values({ fullName: 'Ada', email: 'ada@example.com', passwordHash: 'x' }).returning();
    assert.ok(user && user.id > 0);
    assert.equal(user.role, 'Administrator', 'column defaults come from the D1 schema');
    assert.equal(user.isPlatformAdmin, false, 'booleans come back as booleans');
    assert.ok(user.createdAt instanceof Date, 'timestamps come back as dates');

    const [read] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    assert.equal(read?.email, 'ada@example.com');
  });

  it('answers the health check', async () => {
    assert.equal(await pingDatabase(), true);
  });

  it('gives the verify scripts plain rows', () => {
    assert.deepEqual(queryRows('SELECT 1 AS one'), [{ one: 1 }]);
  });

  it('refuses to switch to read-only once the database is already open', () => {
    assert.throws(() => useReadOnlyDatabase(), /before the database is first used/);
  });
});

describe('db inside a request (Cloudflare)', () => {
  it('sends every statement to the request’s database, after awaits too, and none to the Node one', async () => {
    const before = queryRows('SELECT COUNT(*) AS n FROM users')[0]?.n;
    const { database, statements } = recordingDatabase();

    await runWithDatabase(database, async () => {
      await db.select().from(schema.users);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await db.insert(schema.users).values({ fullName: 'B', email: 'b@example.com', passwordHash: 'x' });
    });

    assert.equal(statements.length, 2);
    assert.match(statements[0] ?? '', /^select .* from "users"$/);
    assert.match(statements[1] ?? '', /^insert into "users"/);
    assert.equal(queryRows('SELECT COUNT(*) AS n FROM users')[0]?.n, before, 'nothing reached the Node database');
  });

  it('keeps two concurrent requests on their own databases', async () => {
    const a = recordingDatabase();
    const b = recordingDatabase();

    await Promise.all([
      runWithDatabase(a.database, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await db.run(sql`select 'a'`);
      }),
      runWithDatabase(b.database, async () => {
        await db.run(sql`select 'b'`);
      }),
    ]);

    assert.deepEqual(a.statements, ["select 'a'"]);
    assert.deepEqual(b.statements, ["select 'b'"]);
  });

  it('returns to the Node database once the request is over', async () => {
    const { database, statements } = recordingDatabase();
    await runWithDatabase(database, async () => {
      await db.run(sql`select 1`);
    });
    assert.equal(await pingDatabase(), true);
    assert.equal(statements.length, 1, 'the ping after the request did not reach the request’s database');
  });
});
