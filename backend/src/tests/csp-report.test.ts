// ─── The endpoint that collects content-policy reports (npm test) ────
// Open to anyone (a browser sends reports without credentials), so what matters is that it is harmless:
// always the same empty 204, bounded, rate limited, and — above all — that Shopify's session token,
// which rides on the page's address, can never reach the log.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';

const { summariseReport, withoutQuery } = await import('../routes/csp-report.js');
const realFetch = globalThis.fetch;

describe('withoutQuery', () => {
  it('cuts an address down to origin and path, dropping the query and the fragment', () => {
    assert.equal(withoutQuery('https://app.example/seo/title-tags?shop=a.myshopify.com&id_token=SECRET#x'), 'https://app.example/seo/title-tags');
  });

  it('leaves policy keywords alone and treats a missing value as "-"', () => {
    assert.equal(withoutQuery('inline'), 'inline');
    assert.equal(withoutQuery('eval'), 'eval');
    assert.equal(withoutQuery(undefined), '-');
    assert.equal(withoutQuery(''), '-');
  });

  it('keeps a log line to one short line, whatever arrives', () => {
    const cleaned = withoutQuery(`https://x.example/${'a'.repeat(500)}\r\nforged log line`);
    assert.ok(cleaned.length <= 160);
    assert.ok(!/[\r\n]/.test(cleaned));
  });

  it('drops the query even from a value that is not a valid address', () => {
    assert.ok(!withoutQuery('not a url?id_token=SECRET').includes('SECRET'));
  });
});

describe('summariseReport', () => {
  it('reads the legacy report format', () => {
    assert.deepEqual(
      summariseReport({ 'csp-report': { 'violated-directive': "img-src 'self'", 'blocked-uri': 'https://img.example/a.png?x=1', 'document-uri': 'https://app.example/?id_token=SECRET', 'source-file': '' } }),
      { directive: 'img-src', blocked: 'https://img.example/a.png', document: 'https://app.example/', source: '-' },
    );
  });

  it('reads the Reporting API format', () => {
    assert.deepEqual(
      summariseReport({ type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'https://x.example/v1?k=1', documentURL: 'https://app.example/seo', sourceFile: 'https://cdn.shopify.com/a.js' } }),
      { directive: 'connect-src', blocked: 'https://x.example/v1', document: 'https://app.example/seo', source: 'https://cdn.shopify.com/a.js' },
    );
  });

  it('gives up quietly on anything else', () => {
    for (const junk of [null, undefined, 'text', 5, [], {}, { body: 'x' }]) assert.equal(summariseReport(junk), null);
  });
});

describe('POST /api/csp-report', () => {
  let server: Server;
  let base: string;
  const warnings: string[] = [];
  const originalWarn = console.warn;

  before(async () => {
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const { app } = await import('../app.js');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    console.warn = originalWarn;
    await new Promise((resolve) => server.close(resolve));
  });

  const send = (body: string, type = 'application/csp-report') =>
    realFetch(`${base}/api/csp-report`, { method: 'POST', headers: { 'Content-Type': type }, body });

  it('accepts a report with an empty 204 and logs one clean line, with no session token in it', async () => {
    warnings.length = 0;
    const response = await send(JSON.stringify({ 'csp-report': { 'violated-directive': "script-src 'self'", 'blocked-uri': 'https://evil.example/x.js?t=1', 'document-uri': 'https://app.example/?shop=a.myshopify.com&id_token=SECRET.TOKEN' } }));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /would block script-src: https:\/\/evil\.example\/x\.js/);
    assert.ok(!warnings.join('\n').includes('SECRET'));
  });

  it('accepts the Reporting API format, a list of reports', async () => {
    warnings.length = 0;
    const response = await send(JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://i.example/a.png', documentURL: 'https://app.example/' } }]), 'application/reports+json');
    assert.equal(response.status, 204);
    assert.equal(warnings.length, 1);
  });

  it('answers the same 204 to a body that is not JSON, and logs nothing', async () => {
    warnings.length = 0;
    assert.equal((await send('{not json')).status, 204);
    assert.equal(warnings.length, 0);
  });

  it('answers 204 to an oversized body without reading it into the log', async () => {
    warnings.length = 0;
    assert.equal((await send(JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(20_000) } }))).status, 204);
    assert.equal(warnings.length, 0);
  });

  it('answers 204 to an empty body', async () => {
    assert.equal((await realFetch(`${base}/api/csp-report`, { method: 'POST' })).status, 204);
  });

  it('needs no sign-in, because a browser sends none', async () => {
    assert.equal((await send('{}')).status, 204);
  });

  it('is rate limited per caller', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i += 1) if ((await send('{}')).status === 429) limited += 1;
    assert.ok(limited > 0, 'a caller sending 40 reports in a row is refused at some point');
  });
});
