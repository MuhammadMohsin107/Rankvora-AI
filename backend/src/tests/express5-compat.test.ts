// ─── The behaviours Express 5 changed, held in place (npm test) ──────
// Each test here failed, or would have, the day Express moved from 4 to 5. They run over real HTTP,
// because the unit tests of the middleware use plain objects and cannot see what a real request does.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { z } from 'zod';
import { bodyDefault } from '../middleware/bodyDefault.js';
import { validateRequest } from '../middleware/validateRequest.js';

const realFetch = globalThis.fetch;

describe('Express 5 behaviours the API relies on', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    // Same order and settings as app.ts.
    app.set('query parser', 'extended');
    app.use(express.json());
    app.use(bodyDefault);

    app.get('/page', validateRequest({ query: z.object({ limit: z.coerce.number().int().default(10), q: z.string().optional() }) }), (req, res) => {
      res.json({ query: req.query });
    });
    app.post('/start', validateRequest({ body: z.object({ force: z.boolean().optional() }) }), (req, res) => {
      res.json({ body: req.body });
    });
    app.get('/echo-query', (req, res) => {
      res.json({ query: req.query });
    });
    app.get('/item/:id', validateRequest({ params: z.object({ id: z.coerce.number().int().positive() }) }), (req, res) => {
      res.json({ params: req.params });
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('validateRequest hands the handler the parsed query (req.query is read-only in Express 5)', async () => {
    const response = await realFetch(`${base}/page?limit=5&q=shoes`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { query: { limit: 5, q: 'shoes' } });
  });

  it('applies a schema default to a missing query value', async () => {
    const response = await realFetch(`${base}/page`);
    assert.deepEqual(await response.json(), { query: { limit: 10 } });
  });

  it('refuses a query that fails its schema', async () => {
    const response = await realFetch(`${base}/page?limit=abc`);
    assert.equal(response.status, 400); // the validation error carries statusCode 400; this bare app's default handler honours it
  });

  it('coerces route parameters', async () => {
    const response = await realFetch(`${base}/item/42`);
    assert.deepEqual(await response.json(), { params: { id: 42 } });
  });

  it('gives a POST with no body an empty one, as Express 4 did', async () => {
    const response = await realFetch(`${base}/start`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { body: {} });
  });

  it('still reads a JSON body', async () => {
    const response = await realFetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    assert.deepEqual(await response.json(), { body: { force: true } });
  });

  it('parses nested and repeated query values as Express 4 did ("extended" query parser)', async () => {
    const response = await realFetch(`${base}/echo-query?filter[kind]=broken&ids=1&ids=2&tag[]=a&tag[]=b`);
    assert.deepEqual(await response.json(), { query: { filter: { kind: 'broken' }, ids: ['1', '2'], tag: ['a', 'b'] } });
  });
});

describe('the real app', () => {
  it('is configured with the same query parser and body default', async () => {
    const { app } = await import('../app.js');
    assert.equal(app.get('query parser'), 'extended');
  });
});
