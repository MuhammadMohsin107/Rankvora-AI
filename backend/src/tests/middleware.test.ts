// ─── Basic unit tests (npm test) ─────────────────────────────────────
// Covers the pure/mockable pieces: request validation, the central error
// handler, asyncHandler, and CSV escaping. Loading config/env needs the JWT
// secrets, which tests/helpers/test-env.ts supplies, so no .env is required —
// and no test here touches the database.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validateRequest, RequestValidationError } from '../middleware/validateRequest.js';
import { ApiError, errorHandler, notFound } from '../middleware/error.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { escapeCsv } from '../services/report.service.js';

type AnyRecord = Record<string, unknown>;

function mockRes() {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.payload = payload; return res; },
  };
  return res;
}

describe('validateRequest', () => {
  const middleware = validateRequest({
    query: z.object({ page: z.coerce.number().int().min(1).default(1) }).strict(),
    params: z.object({ id: z.coerce.number().int().positive() }).strict(),
  });

  it('coerces valid values onto the request', () => {
    const req = { query: { page: '3' }, params: { id: '7' }, body: {} } as AnyRecord;
    let error: unknown = 'not called';
    middleware(req as never, mockRes() as never, (err?: unknown) => { error = err; });
    assert.equal(error, undefined);
    assert.deepEqual(req.query, { page: 3 });
    assert.deepEqual(req.params, { id: 7 });
  });

  it('forwards a RequestValidationError with prefixed paths on invalid input', () => {
    const req = { query: { page: '0' }, params: { id: 'abc' }, body: {} } as AnyRecord;
    let error: unknown;
    middleware(req as never, mockRes() as never, (err?: unknown) => { error = err; });
    assert.ok(error instanceof RequestValidationError);
    assert.equal(error.statusCode, 400);
    const paths = error.issues.map((issue) => issue.path[0]);
    assert.ok(paths.includes('query'));
    assert.ok(paths.includes('params'));
  });
});

describe('errorHandler', () => {
  it('maps ApiError to its status and code', () => {
    const res = mockRes();
    errorHandler(new ApiError(404, 'Nope', 'NOT_FOUND_TEST'), {} as never, res as never, () => {});
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, { error: 'Nope', code: 'NOT_FOUND_TEST' });
  });

  it('maps RequestValidationError to 400 with issues', () => {
    const res = mockRes();
    const result = z.object({ id: z.number() }).safeParse({ id: 'x' });
    assert.equal(result.success, false);
    errorHandler(new RequestValidationError(result.error!.issues), {} as never, res as never, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal((res.payload as AnyRecord).error, 'Request validation failed');
    assert.ok(Array.isArray((res.payload as AnyRecord).issues));
  });

  it('maps unknown errors to a 500 without leaking internals', () => {
    const res = mockRes();
    errorHandler(new Error('secret sql detail'), {} as never, res as never, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal((res.payload as AnyRecord).error, 'Internal server error');
  });

  it('notFound responds 404', () => {
    const res = mockRes();
    notFound({} as never, res as never);
    assert.equal(res.statusCode, 404);
  });
});

describe('asyncHandler', () => {
  it('forwards async rejections to next', async () => {
    const boom = new Error('boom');
    const wrapped = asyncHandler(async () => { throw boom; });
    const error = await new Promise((resolve) => {
      wrapped({} as never, {} as never, (err?: unknown) => resolve(err));
    });
    assert.equal(error, boom);
  });

  it('does not call next on success', async () => {
    let called = false;
    const wrapped = asyncHandler(async (_req, res) => { (res as unknown as { done: boolean }).done = true; });
    const res = { done: false };
    wrapped({} as never, res as never, () => { called = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, false);
    assert.equal(res.done, true);
  });
});

describe('escapeCsv', () => {
  it('passes plain values through', () => {
    assert.equal(escapeCsv('seo'), 'seo');
    assert.equal(escapeCsv(42), '42');
    assert.equal(escapeCsv(null), '');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    assert.equal(escapeCsv('a,b'), '"a,b"');
    assert.equal(escapeCsv('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsv('line1\nline2'), '"line1\nline2"');
  });

  it('serialises dates as ISO strings', () => {
    assert.equal(escapeCsv(new Date('2026-08-25T00:00:00.000Z')), '2026-08-25T00:00:00.000Z');
  });
});
