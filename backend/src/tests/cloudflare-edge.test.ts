// ─── The caller's address and security headers on Cloudflare (npm test) ─
// middleware/cloudflareEdge.ts stands in for nginx when the API runs as a Worker. These tests run a
// real Express server and send real requests. The only inputs are headers the test writes itself:
// CF-Connecting-IP plays Cloudflare, X-Forwarded-For plays a caller trying to choose their own address.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import express from 'express';
import { cloudflareEdge, EDGE_SECURITY_HEADERS, useCloudflareEdge } from '../middleware/cloudflareEdge.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requestMetadata } from '../lib/requestMetadata.js';

/** The same order as app.ts: trust proxy, then the edge middleware, then routes. */
async function serve() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(cloudflareEdge);
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, metadataIp: requestMetadata(req).ipAddress });
  });
  app.post('/limited', rateLimit({ name: 'test:edge', windowMs: 60_000, max: 1 }), (_req, res) => res.json({ ok: true }));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ refused: true });
  });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

after(() => useCloudflareEdge(false));

describe('cloudflareEdge, switched off (Node)', () => {
  it('changes nothing: no headers added, and CF-Connecting-IP is not believed', async () => {
    useCloudflareEdge(false);
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/whoami`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
      const body = (await response.json()) as { ip: string };
      assert.equal(body.ip, '127.0.0.1', 'the socket address, as before');
      for (const name of Object.keys(EDGE_SECURITY_HEADERS)) assert.equal(response.headers.get(name), null, `${name} not added`);
    } finally {
      await close();
    }
  });
});

describe('cloudflareEdge, switched on (Cloudflare)', () => {
  it('takes the caller from CF-Connecting-IP and ignores an X-Forwarded-For the caller sent', async () => {
    useCloudflareEdge(true);
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/whoami`, {
        headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '6.6.6.6' },
      });
      const body = (await response.json()) as { ip: string; metadataIp: string | null };
      assert.equal(body.ip, '203.0.113.9', 'what the rate limits key on');
      assert.equal(body.metadataIp, '203.0.113.9', 'what a session records');
    } finally {
      await close();
    }
  });

  it('sends the five headers nginx sends, with the same values', async () => {
    useCloudflareEdge(true);
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/whoami`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
      assert.deepEqual(Object.keys(EDGE_SECURITY_HEADERS).sort(), [
        'Referrer-Policy',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'X-Permitted-Cross-Domain-Policies',
        'X-XSS-Protection',
      ]);
      for (const [name, value] of Object.entries(EDGE_SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, name);
    } finally {
      await close();
    }
  });

  it('gives each caller their own allowance, and a forged X-Forwarded-For buys none', async () => {
    useCloudflareEdge(true);
    const { base, close } = await serve();
    const post = (cfIp: string, forged?: string) =>
      fetch(`${base}/limited`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': cfIp, ...(forged ? { 'X-Forwarded-For': forged } : {}) },
      }).then((response) => response.status);
    try {
      assert.equal(await post('203.0.113.9'), 200);
      assert.equal(await post('203.0.113.9', '1.2.3.4'), 429, 'same caller, new forged header: still counted as them');
      assert.equal(await post('198.51.100.4'), 200, 'a different caller is not blocked by the first');
    } finally {
      await close();
    }
  });

  it('leaves a request without CF-Connecting-IP as it arrived, but still adds the headers', async () => {
    useCloudflareEdge(true);
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/whoami`);
      const body = (await response.json()) as { ip: string };
      assert.equal(body.ip, '127.0.0.1');
      assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    } finally {
      await close();
    }
  });
});
