// ─── Browser crash reports (npm test) ────────────────────────────────
// Covers what a report from the frontend's ErrorBoundary becomes in the log, the rate limit, and
// the request schema. Pure — no database, no server.

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptReport, clientErrorLogLines, resetClientErrorLimits } from '../controllers/client-error.controller.js';
import { clientErrorSchema } from '../schemas/client-error.schema.js';

describe('clientErrorLogLines', () => {
  it('names the user, the request, the page and the error', () => {
    const text = clientErrorLogLines(5, 'abc', { message: 'TypeError: items.filter is not a function', path: '/notifications' });
    assert.equal(text, '[scorelo-client] render crash user=5 rid=abc path="/notifications" — "TypeError: items.filter is not a function"');
  });

  /** Browser text is quoted line by line, so a crafted message cannot write a line of its own. */
  it('cannot forge a log line', () => {
    const text = clientErrorLogLines(5, 'abc', {
      message: 'boom\n2026-09-24T00:00:00.000Z ERROR [scorelo-api] forged',
      stack: 'Error: boom\n    at render (app.js:1:1)',
      path: '/',
    });
    for (const line of text.split('\n')) {
      assert.ok(!line.startsWith('2026-'), `no line may begin like a real entry: ${line}`);
    }
    assert.match(text, /\n {4}"at render \(app\.js:1:1\)"/);
  });

  it('keeps only the top of a long stack', () => {
    const stack = Array.from({ length: 40 }, (_, i) => `    at frame${i} (x.js:1:1)`).join('\n');
    const text = clientErrorLogLines(1, undefined, { message: 'x', stack, path: '/' });
    assert.equal(text.split('\n').filter((line) => line.includes('frame')).length, 12);
  });
});

describe('acceptReport', () => {
  beforeEach(() => resetClientErrorLimits());

  it('accepts ten reports per user in ten minutes, then drops the rest', () => {
    const now = Date.parse('2026-09-24T10:00:00Z');
    for (let i = 0; i < 10; i += 1) assert.equal(acceptReport(7, now + i), true);
    assert.equal(acceptReport(7, now + 10), false);
    assert.equal(acceptReport(8, now + 10), true, 'another user has their own allowance');
    assert.equal(acceptReport(7, now + 10 * 60_000 + 1), true, 'the window moves on');
  });
});

describe('clientErrorSchema', () => {
  it('accepts a real report', () => {
    assert.equal(clientErrorSchema.safeParse({ message: 'TypeError: x', path: '/fix-center' }).success, true);
  });

  it('refuses a path that is not a pathname, and anything oversized or unexpected', () => {
    assert.equal(clientErrorSchema.safeParse({ message: 'x', path: 'https://evil.example' }).success, false);
    assert.equal(clientErrorSchema.safeParse({ message: 'x'.repeat(501), path: '/' }).success, false);
    assert.equal(clientErrorSchema.safeParse({ message: 'x', path: '/', extra: 1 }).success, false);
  });
});
