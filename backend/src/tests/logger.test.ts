// ─── Log lines say when, why, and nothing private (npm test) ─────────
// Covers lib/logger.ts: the one function every caught error is logged through, and the line format
// the whole API writes. Pure — no database. The errors below are built by hand to match the exact
// shapes drizzle and the database drivers produce. The failures a real database produces are in
// logger-database-errors.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DrizzleQueryError } from 'drizzle-orm';
import { describeError, describeErrorWithStack, formatLogLine, logValue } from '../lib/logger.js';
import { ApiError } from '../middleware/error.js';

/** A database driver puts the reason on an Error with a string `code`. */
function driverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const insertUser = new DrizzleQueryError(
  'insert into `users` (`full_name`, `email`, `password_hash`) values (?, ?, ?)',
  ['Ayesha Khan', 'ayesha@shop.example', '$2a$12$abcdefghijklmnopqrstuv'],
  driverError('ER_DUP_ENTRY', "Duplicate entry 'ayesha@shop.example' for key 'users.users_email_unique'"),
);

describe('describeError', () => {
  it('keeps the SQL that failed', () => {
    assert.match(describeError(insertUser), /^Failed query: insert into `users`/);
  });

  /** THE ONE THIS EXISTS FOR. drizzle's message ends in every bound value. */
  it('never includes the bound parameters', () => {
    const line = describeError(insertUser);
    assert.doesNotMatch(line, /params:/);
    assert.doesNotMatch(line, /Ayesha Khan/);
    assert.doesNotMatch(line, /\$2a\$12\$/);
  });

  it('says why the query failed — the driver code and reason from `cause`', () => {
    assert.match(describeError(insertUser), /caused by ER_DUP_ENTRY: Duplicate entry/);
  });

  it('redacts the row value MySQL quotes back, and any email address', () => {
    const line = describeError(insertUser);
    assert.doesNotMatch(line, /ayesha@shop\.example/);
    assert.match(line, /Duplicate entry '\[redacted\]' for key 'users\.users_email_unique'/);
  });

  it('is always a single line', () => {
    assert.doesNotMatch(describeError(insertUser), /\n/);
  });

  /** What a migration against a stopped MySQL actually threw — and logged without the reason. */
  it('surfaces a connection failure buried in the cause chain', () => {
    const migration = new DrizzleQueryError(
      'create table if not exists `__drizzle_migrations` (id serial primary key)',
      [],
      driverError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3306'),
    );
    assert.equal(
      describeError(migration),
      'Failed query: create table if not exists `__drizzle_migrations` (id serial primary key) — caused by connect ECONNREFUSED 127.0.0.1:3306',
    );
  });

  it('redacts a recipient address in a mail transport error', () => {
    const smtp = driverError('EENVELOPE', "Can't send mail - all recipients were rejected: 550 5.1.1 <owner@store.example>: Recipient address rejected");
    assert.equal(describeError(smtp), "EENVELOPE: Can't send mail - all recipients were rejected: 550 5.1.1 <[email]>: Recipient address rejected");
  });

  it('prefixes an ApiError with its code', () => {
    assert.equal(describeError(new ApiError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND')), 'NOTIFICATION_NOT_FOUND: Notification not found');
  });

  it('describes something that is not an Error without inventing detail', () => {
    assert.equal(describeError('socket hang up'), 'socket hang up');
    assert.equal(describeError(undefined), 'unknown error');
    assert.equal(describeError({ weird: true }), 'unknown error');
  });

  it('stops on a cyclic cause', () => {
    const a = new Error('first');
    const b = new Error('second', { cause: a });
    (a as { cause?: unknown }).cause = b;
    assert.ok(describeError(a).length < 500);
  });
});

describe('describeErrorWithStack', () => {
  it('keeps the frames and still drops the parameters the stack header repeats', () => {
    const text = describeErrorWithStack(insertUser);
    assert.match(text, /^DrizzleQueryError: Failed query:/);
    assert.match(text, /\n\s+at /);
    assert.doesNotMatch(text, /params:|ayesha@shop\.example|Ayesha Khan/);
  });
});

describe('logValue', () => {
  /** A newline in a query string must not be able to write a second, forged log line. */
  it('quotes and escapes an outside value', () => {
    assert.equal(logValue('x.myshopify.com\n2026-09-24T00:00:00.000Z ERROR fake'), '"x.myshopify.com\\n2026-09-24T00:00:00.000Z ERROR fake"');
  });

  it('caps a long value', () => {
    assert.equal(logValue('a'.repeat(250), 10), `"${'a'.repeat(10)}…"`);
  });
});

describe('formatLogLine', () => {
  it('prefixes the time and level', () => {
    const at = new Date('2026-09-24T10:15:30.123Z');
    assert.equal(formatLogLine('WARN', ['[scorelo-api] something happened'], at), '2026-09-24T10:15:30.123Z WARN  [scorelo-api] something happened');
  });

  it('renders an Error argument through the same redaction', () => {
    const line = formatLogLine('ERROR', ['[scorelo-api] crashed', insertUser]);
    assert.match(line, /ERROR \[scorelo-api\] crashed DrizzleQueryError: Failed query:/);
    assert.doesNotMatch(line, /ayesha@shop\.example/);
  });

  it('keeps util.format placeholders working as console did', () => {
    assert.match(formatLogLine('INFO', ['%s audits', 3]), /INFO  3 audits$/);
  });
});
