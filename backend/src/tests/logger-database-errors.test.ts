// ─── A failed query is logged with its reason and none of its data (npm test) ───
// lib/logger.ts's describeError() is the one function every caught error is logged through. Its job
// is to say WHICH constraint refused a write while leaving out every value that was being written —
// emails, names, job titles — because logs are read by more people than the database is.
// logger.test.ts checks that with hand-built errors. These cause the real failures on the real
// engine (SQLite, the one D1 is built on) and read what actually comes back, so a change in the
// driver's wording or in drizzle's error wrapping shows up here. Every row is the test's own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DrizzleQueryError } from 'drizzle-orm';

await import('./helpers/database.js');
const { db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { audits, findings, stores, users } = await import('../db/schema.js');
const { describeError, describeErrorWithStack } = await import('../lib/logger.js');

const SECRET_EMAIL = 'secret-person@leak.example';
const SECRET_NAME = 'Zed Secretson';
const SECRET_JOB = 'Chief Secret Officer';
const SECRET_TITLE = 'A private finding title';

/** Runs `write`, which must fail, and returns the error it failed with. */
async function failure(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (error) {
    return error;
  }
  assert.fail('the write was expected to be refused');
}

function assertSafe(text: string) {
  for (const secret of [SECRET_EMAIL, SECRET_NAME, SECRET_JOB, SECRET_TITLE]) {
    assert.ok(!text.includes(secret), `the log line contains "${secret}": ${text}`);
  }
  assert.doesNotMatch(text, /params:/);
  assert.doesNotMatch(text, /\n/, 'one line');
}

describe('errors from the real database', () => {
  it('a duplicate email: names the constraint, keeps the SQL, drops the values', async () => {
    await insertReturning(users, { fullName: SECRET_NAME, email: SECRET_EMAIL, jobTitle: SECRET_JOB });

    const error = await failure(() => insertReturning(users, { fullName: SECRET_NAME, email: SECRET_EMAIL, jobTitle: SECRET_JOB }));
    const line = describeError(error);

    assert.match(line, /^Failed query: insert into "users"/);
    assert.match(line, /UNIQUE constraint failed: users\.email/);
    assertSafe(line);
  });

  it('a missing parent row (foreign key): says so without the values', async () => {
    const error = await failure(() => insertReturning(stores, {
      ownerId: 987_654, workspaceName: SECRET_NAME, name: SECRET_TITLE, url: 'https://s.example', platform: 'Shopify',
      industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
    }));
    const line = describeError(error);

    assert.match(line, /FOREIGN KEY constraint failed/);
    assertSafe(line);
  });

  it('a value the table refuses (CHECK): says which rule, not what was written', async () => {
    const owner = await insertReturning(users, { fullName: 'Owner', email: 'owner-check@example.com' });
    const store = await insertReturning(stores, {
      ownerId: owner.id, workspaceName: 'W', name: 'S', url: 'https://s.example', platform: 'Shopify',
      industry: 'x', country: 'PK', timezone: 'UTC', currency: 'PKR',
    });
    const audit = await insertReturning(audits, { storeId: store.id, overallScore: 50 });

    const error = await failure(() => insertReturning(findings, {
      auditId: audit.id, pillar: 'seo', subPillar: 'x', title: SECRET_TITLE, severity: 'urgent',
      affectedCount: 1, affectedLabel: 'p', why: 'w', recommendation: 'r',
    }));
    const line = describeError(error);

    assert.match(line, /CHECK constraint failed: findings_severity_valid/);
    assertSafe(line);
  });

  it('a missing required value (NOT NULL): names the column', async () => {
    const error = await failure(() => db.insert(users).values({ email: SECRET_EMAIL, jobTitle: SECRET_JOB } as never));
    const line = describeError(error);

    assert.match(line, /NOT NULL constraint failed: users\.full_name/);
    assertSafe(line);
  });

  it('the stack form keeps its frames and still drops the values', async () => {
    const error = await failure(() => insertReturning(users, { fullName: SECRET_NAME, email: SECRET_EMAIL, jobTitle: SECRET_JOB }));
    const text = describeErrorWithStack(error);

    assert.match(text, /^DrizzleQueryError: Failed query:/);
    assert.match(text, /\n\s+at /);
    for (const secret of [SECRET_EMAIL, SECRET_NAME, SECRET_JOB]) assert.ok(!text.includes(secret), `the stack text contains "${secret}"`);
  });
});

describe('an error as Cloudflare D1 words it', () => {
  // The Worker's D1 driver wraps SQLite's message as "D1_ERROR: <message>: <code>". Built by hand here
  // because the Worker cannot run in this process; the same shape is produced on the local D1 engine.
  const d1Duplicate = new DrizzleQueryError(
    'insert into "users" ("id", "full_name", "email", "job_title") values (null, ?, ?, ?)',
    [SECRET_NAME, SECRET_EMAIL, SECRET_JOB],
    new Error('D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT'),
  );

  it('keeps the reason D1 gives and drops the values', () => {
    const line = describeError(d1Duplicate);

    assert.match(line, /caused by D1_ERROR: UNIQUE constraint failed: users\.email: SQLITE_CONSTRAINT/);
    assertSafe(line);
  });

  it('keeps the limit D1 names when a statement is too large', () => {
    const tooMany = new DrizzleQueryError('select ?', [SECRET_EMAIL], new Error('D1_ERROR: too many SQL variables at offset 307: SQLITE_ERROR'));

    const line = describeError(tooMany);

    assert.match(line, /too many SQL variables/);
    assertSafe(line);
  });
});
