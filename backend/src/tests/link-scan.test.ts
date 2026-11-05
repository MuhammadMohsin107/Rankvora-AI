// ─── The complete link scan (npm test) ───────────────────────────────
// Runs the REAL engine, services and routes against a real (in-memory SQLite) database, and the scan's
// requests go over real HTTP to two servers this file starts: one is "the store" — a sitemap, a robots.txt,
// pages that link to each other, a page only a link reaches, links that are broken, redirected, moved and
// fine — and the other is "another website" that answers the way real ones do (404, a HEAD it refuses, a
// 403 for robots, a 500, a redirect). Nothing is faked: the status codes are real responses.
//
// What it proves:
//   • every page is loaded and every distinct address is asked about once — including pages no sitemap
//     lists, which only a followed link reaches;
//   • each answer is read honestly: 404 is broken; a HEAD a server refuses is retried as GET; 403 is
//     "blocked", never "broken"; a 5xx is retried before it is called broken; a redirect is reported as
//     one; a sitemap-listed address that 404s is found even though no page links to it;
//   • tracking parameters do not make a link a new address; filtered addresses are asked about, not crawled;
//   • the scan is resumable batch by batch, and honest about a ceiling that stopped it;
//   • addresses on a private network are refused (network-guard), and what a store's scan returns, exports
//     and counts belongs to that store alone.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

await import('./helpers/database.js');

const { default: express } = await import('express');
const { eq } = await import('drizzle-orm');
const { env } = await import('../config/env.js');
const { closeDatabase, db } = await import('../db/client.js');
const { insertReturning } = await import('../db/returning.js');
const { linkScans, linkScanUrls, shopifyConnections, stores, users } = await import('../db/schema.js');
const { encryptToken } = await import('../lib/crypto.js');
const { runLinkScanBatch, runLinkScanToEnd } = await import('../link-scan/engine.js');
const { checkAddress } = await import('../link-scan/network-guard.js');
const { classifyFailure, classifyNetworkError, classifyResponse } = await import('../link-scan/outcome.js');
const { hostsOf, isStoreHost, normalizeLink, roleFor } = await import('../link-scan/url.js');
const { errorHandler } = await import('../middleware/error.js');
const { linkScansRouter } = await import('../routes/link-scans.js');
const { failStuckLinkScans, startAutoLinkScan, useLinkScanStarter } = await import('../services/link-scan.service.js');

// ─── The addresses ───────────────────────────────────────────────────

describe('normalizeLink', () => {
  it('drops the fragment and tracking parameters, and nothing else', () => {
    assert.equal(normalizeLink('https://s.example/products/a?utm_source=x&utm_medium=y&variant=12#reviews'), 'https://s.example/products/a');
    assert.equal(normalizeLink('https://s.example/collections/all?page=2&utm_campaign=z&sort_by=price'), 'https://s.example/collections/all?page=2&sort_by=price');
    assert.equal(normalizeLink('https://S.Example/A/?fbclid=1'), 'https://s.example/A/');
  });

  it('leaves the path alone: /a and /a/ are different addresses', () => {
    assert.notEqual(normalizeLink('https://s.example/a'), normalizeLink('https://s.example/a/'));
  });

  it('refuses anything that is not an http(s) address', () => {
    for (const bad of ['mailto:a@b.c', 'tel:123', 'javascript:alert(1)', 'ftp://x.example/', '/relative', 'not a url']) assert.equal(normalizeLink(bad), null, bad);
  });
});

describe('roleFor and hostsOf', () => {
  it('crawls clean addresses on the store, and only asks about files, utility pages and queries', () => {
    for (const page of ['https://s.example/', 'https://s.example/products/a', 'https://s.example/blogs/news/post', 'https://s.example/policies/refund-policy']) assert.equal(roleFor(page), 'page', page);
    for (const target of ['https://s.example/cart', 'https://s.example/account/login', 'https://s.example/search', 'https://s.example/cdn/shop/files/a.jpg', 'https://s.example/files/a.pdf', 'https://s.example/collections/all?page=2', 'https://s.example/apps/wishlist']) {
      assert.equal(roleFor(target), 'target', target);
    }
  });

  it('asks about a product reached through a collection, but loads the product itself once', () => {
    assert.equal(roleFor('https://s.example/collections/summer/products/linen-shirt'), 'target');
    assert.equal(roleFor('https://s.example/products/linen-shirt'), 'page');
    assert.equal(roleFor('https://s.example/collections/summer'), 'page');
  });

  it('counts the www and bare forms of every store host as the store', () => {
    const hosts = hostsOf('www.brand.com', 'brand.myshopify.com', null);
    for (const host of ['brand.com', 'www.brand.com', 'brand.myshopify.com', 'www.brand.myshopify.com']) assert.equal(isStoreHost(hosts, host), true, host);
    assert.equal(isStoreHost(hosts, 'brand.com.evil.example'), false);
    assert.equal(isStoreHost(hosts, 'evilbrand.com'), false);
  });
});

// ─── The network guard ───────────────────────────────────────────────

describe('checkAddress', () => {
  const refused = [
    'http://localhost/', 'http://localhost:5000/api', 'http://127.0.0.1/', 'http://127.1.2.3/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://[::1]/', 'http://[::]/',
    'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://intranet/', 'http://printer.local/', 'http://db.internal/', 'https://user:pass@example.com/', 'https://example.com:8080/',
    'file:///etc/passwd', 'ftp://example.com/',
  ];
  for (const address of refused) it(`refuses ${address}`, () => assert.equal(checkAddress(address).ok, false));

  for (const address of ['https://example.com/', 'http://example.com/a?b=c', 'https://sub.example.co.uk:443/', 'http://93.184.216.34/', 'https://[2606:4700:4700::1111]/']) {
    it(`allows ${address}`, () => assert.equal(checkAddress(address).ok, true));
  }

  it('can be told to allow a private network, for the tests’ own servers — and still refuses a password in an address', () => {
    assert.equal(checkAddress('http://127.0.0.1:8000/', { allowPrivateNetwork: true }).ok, true);
    assert.equal(checkAddress('http://u:p@127.0.0.1/', { allowPrivateNetwork: true }).ok, false);
  });
});

// ─── What an answer means ────────────────────────────────────────────

describe('outcome', () => {
  const facts = (status: number, internal = false, hops = 0, challenged = false) => classifyResponse({ status, hops, internal, challenged }).outcome;

  it('calls a dead end broken and a refused robot blocked — never the reverse', () => {
    assert.equal(facts(200), 'ok');
    assert.equal(facts(200, false, 2), 'redirect');
    assert.equal(facts(404), 'broken');
    assert.equal(facts(410), 'broken');
    assert.equal(facts(500), 'broken');
    assert.equal(facts(503), 'broken');
    for (const status of [401, 403, 429, 451, 999]) assert.equal(facts(status), 'blocked', String(status));
    assert.equal(facts(403, false, 0, true), 'blocked');
    assert.equal(facts(503, false, 0, true), 'blocked');
  });

  it('reads another website’s odd 4xx as unverified, and the store’s own as broken', () => {
    assert.equal(facts(400, false), 'unverified');
    assert.equal(facts(418, false), 'unverified');
    assert.equal(facts(400, true), 'broken');
    assert.equal(facts(405, true), 'broken');
    assert.equal(facts(408, true), 'unverified');
  });

  it('calls a missing domain, a refused connection and a bad certificate broken, and a timeout only unverified', () => {
    for (const reason of ['dns_failed', 'connection_refused', 'ssl_error', 'redirect_loop', 'too_many_redirects'] as const) assert.equal(classifyFailure(reason).outcome, 'broken', reason);
    for (const reason of ['timed_out', 'connection_lost', 'dns_unavailable', 'network_error'] as const) assert.equal(classifyFailure(reason).outcome, 'unverified', reason);
  });

  it('names a network failure from the error fetch threw', () => {
    const cause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    assert.equal(classifyNetworkError(cause('ENOTFOUND')).reason, 'dns_failed');
    assert.equal(classifyNetworkError(cause('EAI_AGAIN')).reason, 'dns_unavailable');
    assert.equal(classifyNetworkError(cause('ECONNREFUSED')).reason, 'connection_refused');
    assert.equal(classifyNetworkError(cause('ECONNRESET')).reason, 'connection_lost');
    assert.equal(classifyNetworkError(cause('CERT_HAS_EXPIRED')).reason, 'ssl_error');
    assert.equal(classifyNetworkError(cause('UND_ERR_CONNECT_TIMEOUT')).reason, 'timed_out');
    assert.equal(classifyNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })).reason, 'timed_out');
  });
});

// ─── Two real websites ───────────────────────────────────────────────

interface Hit { method: string; path: string }

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const html = (links: Array<[string, string]>) =>
  `<!doctype html><html><head><title>Page</title></head><body>${links.map(([href, text]) => `<a href="${href}">${text}</a>`).join('\n')}</body></html>`;

const storeHits: Hit[] = [];
const outsideHits: Hit[] = [];
let storeOrigin = '';
let outsideOrigin = '';
let storeServer: http.Server;
let outsideServer: http.Server;

function storeHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', storeOrigin);
  storeHits.push({ method: req.method ?? 'GET', path: url.pathname + url.search });
  const send = (status: number, body = '', type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const page = (links: Array<[string, string]>) => send(200, html(links));

  switch (url.pathname) {
    case '/robots.txt': return send(200, `User-agent: *\nDisallow: /cart\nSitemap: ${storeOrigin}/sitemap.xml\n`, 'text/plain');
    case '/sitemap.xml': return send(200, `<sitemapindex><sitemap><loc>${storeOrigin}/sitemap_pages.xml</loc></sitemap></sitemapindex>`, 'application/xml');
    case '/sitemap_pages.xml':
      return send(200, `<urlset>${['/', '/products/a', '/products/b', '/pages/about', '/products/removed'].map((path) => `<url><loc>${storeOrigin}${path}</loc></url>`).join('')}</urlset>`, 'application/xml');
    case '/':
      return page([
        ['/products/a', 'Product A'],
        ['/products/b?utm_source=newsletter&variant=9', 'Product B'],
        ['/pages/about', 'About'],
        ['/cart', 'Cart'],
        ['/missing-page', 'Gone page'],
        ['/old-url', 'Old address'],
        ['/collections/x?page=2', 'Page two'],
        [`${outsideOrigin}/ok`, 'A partner'],
        [`${outsideOrigin}/gone`, 'A dead partner'],
        [`${outsideOrigin}/head-refused`, 'A site that refuses HEAD'],
        [`${outsideOrigin}/blocked`, 'A site that refuses robots'],
        [`${outsideOrigin}/server-error`, 'A failing site'],
        [`${outsideOrigin}/redirect`, 'A moved page'],
        ['mailto:hello@s.example', 'Email us'],
        ['#top', 'Back to top'],
      ]);
    case '/products/a': return page([['/', 'Home'], ['/products/b', 'B'], ['/missing-page', 'Gone page again'], [`${outsideOrigin}/ok`, 'Partner again']]);
    case '/products/b': return page([['/', 'Home'], ['/products/a', 'A']]);
    case '/pages/about': return page([['/', 'Home'], ['/discovered-only', 'Only a link reaches this'], ['/files/guide.pdf', 'Guide']]);
    case '/discovered-only': return page([['/', 'Home'], ['/deep-broken', 'Deep link that is broken']]);
    case '/old-url': return send(301, '', 'text/html', { Location: '/products/a' });
    case '/cart': return send(200, html([['/should-never-be-crawled', 'x']]));
    case '/collections/x': return send(200, html([['/', 'Home']]));
    case '/files/guide.pdf': return send(200, '%PDF-1.4', 'application/pdf');
    default: return send(404, '<h1>Not found</h1>');
  }
}

function outsideHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', outsideOrigin);
  outsideHits.push({ method: req.method ?? 'GET', path: url.pathname });
  const send = (status: number, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html', ...headers });
    res.end(req.method === 'HEAD' ? undefined : 'x');
  };
  switch (url.pathname) {
    case '/ok': return send(200);
    case '/gone': return send(404);
    case '/head-refused': return send(req.method === 'HEAD' ? 405 : 200);
    case '/blocked': return send(403);
    case '/server-error': return send(500);
    case '/redirect': return send(302, { Location: '/ok' });
    default: return send(404);
  }
}

// ─── A store and its owner ───────────────────────────────────────────

let counter = 0;

async function connectedStore() {
  counter += 1;
  const shop = `links-${process.pid}-${counter}.myshopify.com`;
  const owner = await insertReturning(users, { fullName: 'Owner', email: `owner-links-${process.pid}-${counter}@links.example`, jobTitle: 'QA' });
  const store = await insertReturning(stores, {
    ownerId: owner.id, workspaceName: 'w', name: 'n', url: `https://${shop}`, platform: 'Shopify', industry: 'i', country: 'c', timezone: 't', currency: 'u',
  });
  await insertReturning(shopifyConnections, { storeId: store.id, shopDomain: shop, accessTokenEncrypted: encryptToken('token'), scope: 'read_products' });
  return { shop, owner, store };
}

/** Where the scan finds the store: the real servers above, not a Shopify address. */
const deps = (extra: Record<string, unknown> = {}) => ({
  resolveEntry: async () => ({ candidates: [storeOrigin], shopHost: null }),
  allowPrivateNetwork: true,
  ...extra,
});

const rows = async (scanId: number) => db.select().from(linkScanUrls).where(eq(linkScanUrls.scanId, scanId));
const at = (all: Awaited<ReturnType<typeof rows>>, address: string) => all.find((row) => row.url === address);

let base = '';
let api: http.Server;

function idTokenFor(shop: string) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: env.shopifyApiKey, sub: '1', exp: now + 60, nbf: now - 5, iat: now - 5, jti: `j-${Math.random()}` },
    env.shopifyApiSecret!,
    { algorithm: 'HS256' },
  );
}
const call = (path: string, shop: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${idTokenFor(shop)}`, ...(init.headers ?? {}) } });

before(async () => {
  ({ server: outsideServer, origin: outsideOrigin } = await listen(outsideHandler));
  ({ server: storeServer, origin: storeOrigin } = await listen(storeHandler));
  const app = express();
  app.use(express.json());
  app.use('/api/link-scans', linkScansRouter);
  app.use(errorHandler);
  api = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // Starting a scan over HTTP creates it and leaves the running to the tests, which drive the engine themselves.
  useLinkScanStarter(async () => undefined);
});

after(async () => {
  for (const server of [api, storeServer, outsideServer]) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

// ─── The scan ────────────────────────────────────────────────────────

describe('a complete scan of a store', () => {
  let scanId = 0;
  let all: Awaited<ReturnType<typeof rows>> = [];

  before(async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    scanId = scan.id;
    await runLinkScanToEnd(scanId, deps());
    all = await rows(scanId);
  });

  it('completes, and says where it looked', async () => {
    const [scan] = await db.select().from(linkScans).where(eq(linkScans.id, scanId));
    assert.equal(scan!.status, 'completed');
    assert.equal(scan!.progress, 100);
    assert.equal(scan!.origin, storeOrigin);
    assert.equal(scan!.limitReached, null);
    assert.ok(scan!.finishedAt);
  });

  it('loads every page — the sitemap’s, and the one only a link reaches', () => {
    for (const path of ['/', '/products/a', '/products/b', '/pages/about', '/products/removed', '/discovered-only']) {
      const row = at(all, `${storeOrigin}${path}`);
      assert.ok(row, `${path} was never queued`);
      assert.equal(row.state, 'done', path);
      assert.equal(row.role, 'page', path);
    }
    // /deep-broken is only linked from /discovered-only, which itself was only found through a link.
    assert.equal(at(all, `${storeOrigin}/deep-broken`)?.outcome, 'broken');
  });

  it('finds a broken internal link, and counts how many pages link to it', () => {
    const row = at(all, `${storeOrigin}/missing-page`)!;
    assert.equal(row.outcome, 'broken');
    assert.equal(row.reason, 'not_found');
    assert.equal(row.status, 404);
    assert.equal(row.sourceCount, 2, 'the homepage and /products/a both link to it');
    assert.equal(row.internal, true);
  });

  it('finds an address the sitemap lists that answers 404, though no page links to it', () => {
    const row = at(all, `${storeOrigin}/products/removed`)!;
    assert.equal(row.outcome, 'broken');
    assert.equal(row.inSitemap, true);
    assert.equal(row.sourceCount ?? 0, 0);
  });

  it('reports a redirecting internal link as a redirect, not as broken', () => {
    const row = at(all, `${storeOrigin}/old-url`)!;
    assert.equal(row.outcome, 'redirect');
    assert.equal(row.hops, 1);
    assert.equal(row.finalUrl, `${storeOrigin}/products/a`);
  });

  it('reads another website honestly', () => {
    const outcome = (path: string) => at(all, `${outsideOrigin}${path}`)?.outcome;
    assert.equal(outcome('/ok'), 'ok');
    assert.equal(outcome('/gone'), 'broken');
    assert.equal(outcome('/head-refused'), 'ok', 'a site that refuses HEAD is asked again with GET');
    assert.equal(outcome('/blocked'), 'blocked', 'a 403 is a robot being refused, not a dead link');
    assert.equal(outcome('/server-error'), 'broken');
    assert.equal(outcome('/redirect'), 'redirect');
    for (const path of ['/ok', '/gone', '/blocked']) assert.equal(at(all, `${outsideOrigin}${path}`)!.internal, false, path);
  });

  it('retries a failing server before calling it broken, and asks about each address once otherwise', () => {
    assert.ok(outsideHits.filter((hit) => hit.path === '/server-error').length >= 2, 'a 500 is repeated');
    // Linked from two pages, /ok is asked about once for its own row; /redirect's own check then follows it there once more.
    assert.equal(outsideHits.filter((hit) => hit.path === '/ok' && hit.method === 'HEAD').length, 2);
    assert.equal(outsideHits.filter((hit) => hit.path === '/gone').length, 2, 'HEAD then GET, once each');
  });

  it('treats tracking parameters as the same address, and a filtered address as something to ask about, not crawl', () => {
    assert.equal(all.filter((row) => row.url.startsWith(`${storeOrigin}/products/b`)).length, 1);
    const filtered = at(all, `${storeOrigin}/collections/x?page=2`)!;
    assert.equal(filtered.role, 'target');
    assert.equal(filtered.outcome, 'ok');
    assert.equal(filtered.outlinks, null);
  });

  it('asks about pages robots.txt fences off and files, but never loads them', () => {
    const cart = at(all, `${storeOrigin}/cart`)!;
    assert.equal(cart.role, 'target');
    assert.equal(cart.outcome, 'ok');
    assert.equal(at(all, `${storeOrigin}/should-never-be-crawled`), undefined);
    assert.equal(at(all, `${storeOrigin}/files/guide.pdf`)?.role, 'target');
    assert.equal(storeHits.some((hit) => hit.path === '/cart' && hit.method === 'GET'), false, 'the cart page was never downloaded');
  });

  it('never queues an address that is not a web page', () => {
    assert.equal(all.some((row) => row.url.startsWith('mailto:') || row.url.includes('#')), false);
  });

  it('totals what it found', async () => {
    const [scan] = await db.select().from(linkScans).where(eq(linkScans.id, scanId));
    const summary = scan!.summary as { internal: Record<string, number>; external: Record<string, number>; pagesCrawled: number; linksFound: number; urlsFound: number; urlsChecked: number };
    assert.equal(summary.urlsFound, all.length);
    assert.equal(summary.urlsChecked, all.length, 'nothing is left pending');
    assert.equal(summary.internal.broken, 3, '/missing-page, /products/removed, /deep-broken');
    assert.equal(summary.external.broken, 2, '/gone and /server-error');
    assert.equal(summary.external.blocked, 1);
    assert.equal(summary.external.redirect, 1);
    assert.equal(summary.internal.redirect, 1);
    assert.ok(summary.linksFound > 20);
    assert.ok(summary.pagesCrawled >= 7);
  });

  it('keeps the links of each page, so the pages that contain a broken link can be listed', async () => {
    const home = at(all, `${storeOrigin}/`)!;
    const links = JSON.parse(home.outlinks!) as Array<[string, string]>;
    assert.ok(links.some(([address, anchor]) => address === `${storeOrigin}/missing-page` && anchor === 'Gone page'));
    assert.equal(links.some(([address]) => address.includes('utm_')), false);
  });
});

// ─── Batches, resuming and ceilings ──────────────────────────────────

describe('batches', () => {
  it('give the same answers when the scan is run a few requests at a time and picked up again, and every batch is bounded', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    const limits = { crawlBatch: 2, checkBatch: 3 };

    let batches = 0;
    // "Another process": every batch is a fresh call that holds nothing in memory between them.
    while (batches < 400) {
      batches += 1;
      const { done } = await runLinkScanBatch(scan.id, deps({ limits }));
      if (done) break;
    }
    const resumed = await rows(scan.id);
    assert.ok(batches > 5, 'the work really was split across batches');
    assert.ok(resumed.every((row) => row.state === 'done'), 'nothing is left pending');

    const other = await connectedStore();
    const whole = await insertReturning(linkScans, { storeId: other.store.id });
    await runLinkScanToEnd(whole.id, deps());
    const full = await rows(whole.id);

    const answers = (list: typeof resumed) => list.map((row) => `${row.url} ${row.outcome} ${row.status ?? ''} ${row.sourceCount ?? 0}`).sort();
    assert.deepEqual(answers(resumed), answers(full));
  });

  it('says so when a ceiling stopped it covering everything, and still finishes', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    await runLinkScanToEnd(scan.id, deps({ limits: { maxUrls: 8 } }));
    const [done] = await db.select().from(linkScans).where(eq(linkScans.id, scan.id));
    assert.equal(done!.status, 'completed');
    assert.equal(done!.limitReached, 'urls');
    assert.ok((await rows(scan.id)).length <= 8);
  });

  it('keeps a page full of very long links within what the database accepts, and still finishes', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    // 900 links of ~1,800 characters: 1.6 MB of addresses, more than a row may hold.
    const farm = await listen((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      res.writeHead(path === '/robots.txt' || path === '/sitemap.xml' ? 404 : 200, { 'Content-Type': 'text/html' });
      if (req.method === 'HEAD') return void res.end();
      res.end(path === '/' ? `<html><body>${Array.from({ length: 900 }, (_, index) => `<a href="/filtered/${index}?q=${'x'.repeat(1_800)}">l</a>`).join('')}</body></html>` : '<html></html>');
    });
    try {
      await runLinkScanToEnd(scan.id, deps({ resolveEntry: async () => ({ candidates: [farm.origin], shopHost: null }) }));
    } finally {
      await new Promise<void>((resolve) => farm.server.close(() => resolve()));
    }
    const [done] = await db.select().from(linkScans).where(eq(linkScans.id, scan.id));
    assert.equal(done!.status, 'completed', done!.error ?? '');
    const home = (await rows(scan.id)).find((row) => row.url === `${farm.origin}/`)!;
    assert.ok(home.outlinks!.length < 1_000_000, `${home.outlinks!.length} characters saved`);
    assert.ok((JSON.parse(home.outlinks!) as unknown[]).length > 100, 'the links that fit are kept');
  });

  it('can be cancelled, and then does nothing more', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    await db.update(linkScans).set({ status: 'cancelled' }).where(eq(linkScans.id, scan.id));
    assert.deepEqual(await runLinkScanBatch(scan.id, deps()), { done: true });
    assert.equal((await rows(scan.id)).length, 0);
  });

  it('fails with a reason, not silence, when the storefront cannot be opened', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    const dead = await listen((_req, res) => res.end());
    const origin = dead.origin;
    await new Promise<void>((resolve) => dead.server.close(() => resolve()));
    await runLinkScanToEnd(scan.id, deps({ resolveEntry: async () => ({ candidates: [origin], shopHost: null }) }));
    const [failed] = await db.select().from(linkScans).where(eq(linkScans.id, scan.id));
    assert.equal(failed!.status, 'failed');
    assert.match(failed!.error ?? '', /could not open your storefront/);
  });

  it('refuses to scan a store that is a password page, and says what to do', async () => {
    const { store } = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: store.id });
    const gated = await listen((req, res) => {
      if (req.url === '/password') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<form>password</form>'); return; }
      res.writeHead(302, { Location: '/password' });
      res.end();
    });
    try {
      await runLinkScanToEnd(scan.id, deps({ resolveEntry: async () => ({ candidates: [gated.origin], shopHost: null }) }));
    } finally {
      await new Promise<void>((resolve) => gated.server.close(() => resolve()));
    }
    const [failed] = await db.select().from(linkScans).where(eq(linkScans.id, scan.id));
    assert.equal(failed!.status, 'failed');
    assert.match(failed!.error ?? '', /password protected/);
    assert.match(failed!.error ?? '', /Online Store → Preferences/);
  });

  it('is not started by itself in the tests, and is closed out when its heartbeat stops', async () => {
    const { store } = await connectedStore();
    assert.equal(await startAutoLinkScan(store.id), false, 'LINK_SCAN_AUTO is off for the tests');

    const stale = await insertReturning(linkScans, { storeId: store.id, status: 'running', updatedAt: new Date(Date.now() - env.linkScanStuckMs - 60_000) });
    const live = (await connectedStore()).store;
    const fresh = await insertReturning(linkScans, { storeId: live.id, status: 'running' });
    assert.equal(await failStuckLinkScans(new Date()), 1);
    assert.equal((await db.select().from(linkScans).where(eq(linkScans.id, stale.id)))[0]!.status, 'failed');
    assert.equal((await db.select().from(linkScans).where(eq(linkScans.id, fresh.id)))[0]!.status, 'running');
  });
});

// ─── The API ─────────────────────────────────────────────────────────

describe('the link scan API', () => {
  let shop = '';
  let scanId = 0;
  let otherShop = '';

  before(async () => {
    const mine = await connectedStore();
    const theirs = await connectedStore();
    shop = mine.shop;
    otherShop = theirs.shop;
    const scan = await insertReturning(linkScans, { storeId: mine.store.id, shopDomain: mine.shop });
    scanId = scan.id;
    await runLinkScanToEnd(scanId, deps());
  });

  const read = async (path: string, who = shop) => {
    const response = await call(path, who);
    return { status: response.status, body: (await response.json()) as { data?: any; error?: string; code?: string } };
  };

  it('needs a signed-in store', async () => {
    assert.equal((await fetch(`${base}/api/link-scans/latest`)).status, 401);
  });

  it('shows the newest scan, and is empty — not an error — for a store never scanned', async () => {
    const { status, body } = await read('/api/link-scans/latest');
    assert.equal(status, 200);
    assert.equal(body.data.latest.id, scanId);
    assert.equal(body.data.latest.status, 'completed');
    assert.equal(body.data.lastCompleted.id, scanId);
    assert.equal('hosts' in body.data.latest, false, 'the scan’s working state is not sent');
    assert.equal('robots' in body.data.latest, false);

    const never = (await connectedStore()).shop;
    assert.deepEqual((await read('/api/link-scans/latest', never)).body.data, { latest: null, lastCompleted: null });
  });

  it('does not show the scans of a shop that is no longer the one connected', async () => {
    const reconnected = await connectedStore();
    const scan = await insertReturning(linkScans, { storeId: reconnected.store.id, shopDomain: reconnected.shop, status: 'completed' });
    assert.equal((await read('/api/link-scans/latest', reconnected.shop)).body.data.latest.id, scan.id);
    // The store is connected to a different shop: the previous shop's results are not this shop's.
    const other = `other-${reconnected.shop}`;
    await db.update(shopifyConnections).set({ shopDomain: other }).where(eq(shopifyConnections.storeId, reconnected.store.id));
    assert.deepEqual((await read('/api/link-scans/latest', other)).body.data, { latest: null, lastCompleted: null });
  });

  it('records which shop a scan started over HTTP is of', async () => {
    const fresh = await connectedStore();
    const started = (await (await call('/api/link-scans', fresh.shop, { method: 'POST' })).json()) as { data: { id: number } };
    const [row] = await db.select().from(linkScans).where(eq(linkScans.id, started.data.id));
    assert.equal(row!.shopDomain, fresh.shop);
  });

  it('lists broken links, internal and external, with the most-linked first', async () => {
    const { body } = await read(`/api/link-scans/${scanId}/links?view=broken`);
    const urls = body.data.items.map((item: { url: string }) => item.url);
    assert.ok(urls.includes(`${storeOrigin}/missing-page`));
    assert.ok(urls.includes(`${outsideOrigin}/gone`));
    assert.equal(urls[0], `${storeOrigin}/missing-page`, 'the address two pages link to comes first');
    assert.ok(body.data.items.every((item: { outcome: string }) => item.outcome === 'broken'));
    assert.equal(body.data.pagination.total, 5);
  });

  it('filters by where the link points, by kind of answer, and by search', async () => {
    const internal = (await read(`/api/link-scans/${scanId}/links?view=broken&scope=internal`)).body.data.items;
    assert.ok(internal.length > 0 && internal.every((item: { internal: boolean }) => item.internal));
    const external = (await read(`/api/link-scans/${scanId}/links?view=broken&scope=external`)).body.data.items;
    assert.ok(external.length > 0 && external.every((item: { internal: boolean }) => !item.internal));

    const unverified = (await read(`/api/link-scans/${scanId}/links?view=unverified`)).body.data.items;
    assert.deepEqual(unverified.map((item: { url: string }) => item.url), [`${outsideOrigin}/blocked`]);
    const redirects = (await read(`/api/link-scans/${scanId}/links?view=redirect`)).body.data.items.map((item: { url: string }) => item.url).sort();
    assert.deepEqual(redirects, [`${outsideOrigin}/redirect`, `${storeOrigin}/old-url`].sort());

    const found = (await read(`/api/link-scans/${scanId}/links?view=all&q=missing-page`)).body.data.items;
    assert.equal(found.length, 1);
    // LIKE's own wildcards are searched for, not obeyed.
    assert.equal((await read(`/api/link-scans/${scanId}/links?view=all&q=%25`)).body.data.items.length, 0);
  });

  it('pages through results', async () => {
    const first = (await read(`/api/link-scans/${scanId}/links?view=all&limit=3&page=1`)).body.data;
    const second = (await read(`/api/link-scans/${scanId}/links?view=all&limit=3&page=2`)).body.data;
    assert.equal(first.items.length, 3);
    assert.ok(first.pagination.totalPages > 1);
    assert.equal(first.items.some((item: { id: number }) => second.items.some((other: { id: number }) => other.id === item.id)), false);
  });

  it('names the pages that contain a broken link, with the link’s text', async () => {
    const broken = (await read(`/api/link-scans/${scanId}/links?view=broken&q=missing-page`)).body.data.items[0];
    const { status, body } = await read(`/api/link-scans/${scanId}/links/${broken.id}/sources`);
    assert.equal(status, 200);
    assert.equal(body.data.total, 2);
    assert.deepEqual(body.data.sources.map((source: { page: string }) => source.page).sort(), [`${storeOrigin}/`, `${storeOrigin}/products/a`].sort());
    assert.equal(body.data.sources.find((source: { page: string }) => source.page === `${storeOrigin}/`).anchor, 'Gone page');

    const removed = (await read(`/api/link-scans/${scanId}/links?view=broken&q=products/removed`)).body.data.items[0];
    const listed = (await read(`/api/link-scans/${scanId}/links/${removed.id}/sources`)).body.data;
    assert.equal(listed.inSitemap, true);
    assert.deepEqual(listed.sources, []);
  });

  it('exports every address with a problem, as a spreadsheet', async () => {
    const response = await call(`/api/link-scans/${scanId}/export`, shop);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="rankvora-ai-link-scan-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = (await response.text()).replace(/^﻿/, '');
    const lines = csv.split('\r\n');
    assert.match(lines[0]!, /^Result,Points to,Link,/);
    const missing = lines.find((line) => line.includes(`${storeOrigin}/missing-page`))!;
    assert.match(missing, /^Broken,Your store,/);
    // The pages that contain it, with the link's text (a quote inside a CSV cell is doubled).
    assert.ok(missing.includes(`${storeOrigin}/ (""Gone page"") | ${storeOrigin}/products/a (""Gone page again"")`), missing);
    assert.ok(lines.some((line) => line.startsWith('Blocked') && line.includes('/blocked')));
    assert.ok(lines.some((line) => line.startsWith('Redirects') && line.includes('/old-url')));
    assert.equal(lines.some((line) => line.startsWith('Works')), false, 'only problems are exported');
  });

  it('is one store’s own: another store’s scan is a 404, whatever the id', async () => {
    assert.equal((await read(`/api/link-scans/${scanId}`, otherShop)).status, 404);
    assert.equal((await read(`/api/link-scans/${scanId}/links`, otherShop)).status, 404);
    const broken = (await read(`/api/link-scans/${scanId}/links?view=broken`)).body.data.items[0];
    assert.equal((await read(`/api/link-scans/${scanId}/links/${broken.id}/sources`, otherShop)).status, 404);
    assert.equal((await call(`/api/link-scans/${scanId}/export`, otherShop)).status, 404);
    assert.equal((await call(`/api/link-scans/${scanId}/cancel`, otherShop, { method: 'POST' })).status, 404);
  });

  it('starts one scan at a time, and a scan can be cancelled', async () => {
    const started = await call('/api/link-scans', shop, { method: 'POST' });
    assert.equal(started.status, 202);
    const scan = ((await started.json()) as { data: { id: number; status: string } }).data;
    assert.equal(scan.status, 'queued');
    const second = await call('/api/link-scans', shop, { method: 'POST' });
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code: string }).code, 'LINK_SCAN_IN_PROGRESS');

    const cancelled = await call(`/api/link-scans/${scan.id}/cancel`, shop, { method: 'POST' });
    assert.equal(((await cancelled.json()) as { data: { status: string } }).data.status, 'cancelled');
    // After it is cancelled the next can start.
    assert.equal((await call('/api/link-scans', shop, { method: 'POST' })).status, 202);
  });

  it('rejects parameters it does not know', async () => {
    assert.equal((await read(`/api/link-scans/${scanId}/links?view=everything`)).status, 400);
    assert.equal((await read(`/api/link-scans/${scanId}/links?surprise=1`)).status, 400);
    assert.equal((await read('/api/link-scans/abc')).status, 400);
  });
});
