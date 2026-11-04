// ─── Request log and error handler, through a real Express server (npm test) ───
// Starts the real middleware — requestLog, a route, errorHandler — on a real port, sends real HTTP
// requests, and reads what was actually written to the console. The only stand-in is the route
// that fails, which throws the same error shape drizzle throws for a failed query.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { DrizzleQueryError } from 'drizzle-orm';
import { accessLogLine, newRequestId, requestLog, requestPath } from '../middleware/requestLog.js';
import { ApiError, errorHandler, notFound } from '../middleware/error.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { z } from 'zod';

describe('accessLogLine', () => {
  it('writes method, path, status, time, request id and user', () => {
    assert.equal(
      accessLogLine({ method: 'GET', path: '/api/notifications', status: 200, durationMs: 12, requestId: 'abc123', userId: 5 }),
      '[scorelo-http] GET /api/notifications 200 12ms rid=abc123 user=5',
    );
  });

  it('appends why a request was refused', () => {
    assert.equal(
      accessLogLine({ method: 'DELETE', path: '/api/notifications/88', status: 404, durationMs: 4, requestId: 'r', error: 'NOTIFICATION_NOT_FOUND: Notification not found' }),
      '[scorelo-http] DELETE /api/notifications/88 404 4ms rid=r — NOTIFICATION_NOT_FOUND: Notification not found',
    );
  });

  it('says when the client went away before the response', () => {
    assert.match(accessLogLine({ method: 'GET', path: '/x', status: 200, durationMs: 9, requestId: 'r', aborted: true }), / aborted 9ms /);
  });
});

describe('requestPath', () => {
  /** OAuth callbacks carry a single-use authorization code and a signed state in the query. */
  it('drops the query string', () => {
    assert.equal(requestPath({ originalUrl: '/api/google/callback?code=4/0AbC&state=eyJ' }), '/api/google/callback');
  });
});

describe('newRequestId', () => {
  it('is 16 hex characters and different each time', () => {
    const a = newRequestId();
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.notEqual(a, newRequestId());
  });
});

describe('request log + error handler over real HTTP', () => {
  let server: Server;
  let base: string;
  const lines: Array<{ level: string; text: string }> = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };

  before(async () => {
    console.log = (...args: unknown[]) => lines.push({ level: 'info', text: args.join(' ') });
    console.warn = (...args: unknown[]) => lines.push({ level: 'warn', text: args.join(' ') });
    console.error = (...args: unknown[]) => lines.push({ level: 'error', text: args.join(' ') });

    const app = express();
    app.use(requestLog);
    app.use(express.json());
    app.get('/ok', (_req, res) => { res.json({ data: true }); });
    app.get('/refused', asyncHandler(async () => { throw new ApiError(409, 'An audit run is already in progress for this store', 'AUDIT_RUN_IN_PROGRESS'); }));
    app.get('/broken', asyncHandler(async () => {
      throw new DrizzleQueryError(
        'update `users` set `email` = ? where `users`.`id` = ?',
        ['owner@store.example', 7],
        Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT' }),
      );
    }));
    app.post('/validated', validateRequest({ body: z.object({ email: z.email() }).strict() }), (_req, res) => { res.json({}); });
    app.use(notFound);
    app.use(errorHandler);

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    Object.assign(console, originals);
    server.close();
  });

  const lineFor = (rid: string | null) => lines.filter((line) => rid && line.text.includes(`rid=${rid}`));

  it('logs a successful request at INFO and returns its id', async () => {
    const response = await fetch(`${base}/ok?token=secret`);
    const rid = response.headers.get('x-request-id');
    assert.match(rid ?? '', /^[0-9a-f]{16}$/);
    const [line] = lineFor(rid);
    assert.equal(line.level, 'info');
    assert.match(line.text, /^\[scorelo-http\] GET \/ok 200 \d+ms rid=/);
    assert.doesNotMatch(line.text, /secret/);
  });

  it('logs a refused request at WARN with its reason, on one line', async () => {
    const response = await fetch(`${base}/refused`);
    const found = lineFor(response.headers.get('x-request-id'));
    assert.equal(found.length, 1);
    assert.equal(found[0].level, 'warn');
    assert.match(found[0].text, / 409 \d+ms rid=\w+ — AUDIT_RUN_IN_PROGRESS: An audit run is already in progress/);
  });

  it('names the fields that failed validation, not their values', async () => {
    const response = await fetch(`${base}/validated`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email' }) });
    const [line] = lineFor(response.headers.get('x-request-id'));
    assert.match(line.text, / 400 .*Request validation failed: body\.email \(invalid_format\)/);
    assert.doesNotMatch(line.text, /not-an-email/);
  });

  it('logs a 500 with the stack, the request, and no bound values — and returns the id', async () => {
    const response = await fetch(`${base}/broken`);
    const rid = response.headers.get('x-request-id');
    const body = await response.json() as { requestId?: string };
    assert.equal(body.requestId, rid);

    const found = lineFor(rid);
    const detail = found.find((line) => line.text.startsWith('[scorelo-api] 500'));
    assert.ok(detail, 'the error handler writes its own line');
    assert.equal(detail.level, 'error');
    assert.match(detail.text, /\[scorelo-api\] 500 GET \/broken rid=\w+ — DrizzleQueryError: Failed query: update `users`/);
    assert.match(detail.text, /caused by ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded/);
    assert.match(detail.text, /\n\s+at /);
    assert.doesNotMatch(detail.text, /owner@store\.example|params:/);

    const access = found.find((line) => line.text.startsWith('[scorelo-http]'));
    assert.equal(access?.level, 'error');
  });

  it('logs an unknown route as a 404', async () => {
    const response = await fetch(`${base}/no-such-route`);
    const [line] = lineFor(response.headers.get('x-request-id'));
    assert.match(line.text, /GET \/no-such-route 404 /);
  });
});
