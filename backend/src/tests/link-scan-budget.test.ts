// ─── How many database queries one batch of a link scan makes (npm test) ──
// A scan on Cloudflare runs one batch per Workflow step, and a step may make 1,000 D1 queries on the Paid plan
// (a db.batch() counts as one there). This counts what a batch really sends, by counting the statements SQLite
// prepares — which counts every statement inside a batch separately, so the figures here can only be higher than
// D1's — for the busiest batches a real scan makes: a full batch of pages that each link to many others, and a full
// batch of link targets. Each must stay well under the limit, at the sizes the scan really uses.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

await import('./helpers/database.js');
const { eq } = await import('drizzle-orm');
const { env } = await import('../config/env.js');
const { closeDatabase, db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { linkScans, linkScanUrls, shopifyConnections, stores, users } = await import('../db/schema.js');
const { encryptToken } = await import('../lib/crypto.js');
const { runLinkScanBatch } = await import('../link-scan/engine.js');

const LIMIT = 1_000;
const HEADROOM = 0.8;

let statements = 0;
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function patched(this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
  statements += 1;
  return originalPrepare.apply(this, args);
};

const PAGES = 130;
const LINKS_PER_PAGE = 60;
let origin = '';
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', origin).pathname;
    res.writeHead(200, { 'Content-Type': path === '/sitemap.xml' ? 'application/xml' : path.endsWith('.txt') ? 'text/plain' : 'text/html' });
    if (req.method === 'HEAD') return void res.end();
    if (path === '/robots.txt') return void res.end('User-agent: *\n');
    if (path === '/sitemap.xml') {
      return void res.end(`<urlset>${Array.from({ length: PAGES }, (_, index) => `<url><loc>${origin}/p/${index}</loc></url>`).join('')}</urlset>`);
    }
    // Page N links to LINKS_PER_PAGE other pages, and to as many filtered addresses that are only asked about.
    const number = Number(path.split('/').pop()) || 0;
    const links = [
      ...Array.from({ length: LINKS_PER_PAGE / 2 }, (_, index) => `<a href="/p/${(number + index + 1) % PAGES}">p</a>`),
      ...Array.from({ length: LINKS_PER_PAGE / 2 }, (_, index) => `<a href="/p/${number}?filter=${index}">f</a>`),
    ];
    res.end(`<html><body>${links.join('')}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

describe('a link scan batch', () => {
  it('stays well inside D1’s 1,000 queries per invocation, at the real batch sizes', async () => {
    const owner = await insertReturning(users, { fullName: 'O', email: 'budget-links@example.com', jobTitle: 'QA' });
    const store = await insertReturning(stores, { ownerId: owner.id, workspaceName: 'w', name: 'n', url: 'https://x.example', platform: 'Shopify', industry: 'i', country: 'c', timezone: 't', currency: 'u' });
    await insertReturning(shopifyConnections, { storeId: store.id, shopDomain: 'budget-links.myshopify.com', accessTokenEncrypted: encryptToken('t'), scope: 'read_products' });
    const scan = await insertReturning(linkScans, { storeId: store.id });
    const deps = { resolveEntry: async () => ({ candidates: [origin], shopHost: null }), allowPrivateNetwork: true };

    const worst = { discover: 0, crawl: 0, check: 0 };
    let calls = 0;
    for (;;) {
      calls += 1;
      const before = (await db.select().from(linkScanUrls).where(eq(linkScanUrls.scanId, scan.id))).length;
      const pending = before === 0 ? 'discover' : null;
      statements = 0;
      const { done } = await runLinkScanBatch(scan.id, deps);
      const used = statements;
      const phase = (await db.select().from(linkScans).where(eq(linkScans.id, scan.id)))[0]!.phase;
      const kind = pending ?? (phase === 'checking' || phase === 'finishing' ? 'check' : 'crawl');
      worst[kind] = Math.max(worst[kind], used);
      if (done || calls > 200) break;
    }

    const [finished] = await db.select().from(linkScans).where(eq(linkScans.id, scan.id));
    assert.equal(finished!.status, 'completed');
    const rows = await db.select().from(linkScanUrls).where(eq(linkScanUrls.scanId, scan.id));
    assert.ok(rows.length >= PAGES * 2, `${rows.length} addresses: the pages and every filtered address`);
    assert.ok(env.linkScanBatchPages >= 40 && env.linkScanBatchChecks >= 120, 'measured at the real batch sizes');

    console.log(`link scan batch cost: discovery ${worst.discover}, a full batch of pages ${worst.crawl}, a full batch of targets ${worst.check} queries (limit ${LIMIT})`);
    for (const [name, queries] of Object.entries(worst)) assert.ok(queries < LIMIT * HEADROOM, `${name} used ${queries} queries`);
  });
});
