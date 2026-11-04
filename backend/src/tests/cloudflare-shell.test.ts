// ─── Serving the site inside the Shopify admin's iframe (npm test) ───
// Shopify shows the app in an iframe, and a browser only allows that when the page's own response
// says who may frame it. src/cloudflare/shell.ts adds that header per request. These tests run the
// real function against a stand-in for the static assets and read back exactly what a browser would be
// handed — and, because the shop comes from the request URL, they try to smuggle other values in.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

const { frameAncestors, isApiPath, serveWebsite, shopFromUrl } = await import('../cloudflare/shell.js');
const { findPlaceholders } = await import('../scripts/wrangler-guard.js');

const SHOP = 'shell-test.myshopify.com';

const page = (headers: Record<string, string> = {}) =>
  new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

/** Serves `response` for whatever is asked, and remembers what was asked. */
function assets(response: () => Response) {
  const seen: string[] = [];
  return { seen, fetch: async (request: Request) => { seen.push(request.url); return response(); } };
}

describe('shopFromUrl', () => {
  it('reads the shop Shopify puts on the page URL', () => {
    assert.equal(shopFromUrl(new URL(`https://app.example/?embedded=1&shop=${SHOP}&host=abc`)), SHOP);
  });

  it('lowercases it, as a shop domain is case-insensitive', () => {
    assert.equal(shopFromUrl(new URL(`https://app.example/?shop=${SHOP.toUpperCase()}`)), SHOP);
  });

  it('ignores a missing shop', () => {
    assert.equal(shopFromUrl(new URL('https://app.example/')), null);
  });

  it('ignores anything that is not a myshopify.com shop — the value goes into a response header', () => {
    for (const shop of [
      'evil.com',
      'evil.com/.myshopify.com',
      `${SHOP}.evil.com`,
      `evil.com?${SHOP}`,
      '.myshopify.com',
      '-bad.myshopify.com',
      `${SHOP}\r\nSet-Cookie: x=1`,
      `${SHOP} https://evil.com`,
      `${SHOP}; script-src *`,
      '*.myshopify.com',
      'https://x.myshopify.com',
    ]) {
      const url = new URL('https://app.example/');
      url.searchParams.set('shop', shop);
      assert.equal(shopFromUrl(url), null, JSON.stringify(shop));
    }
  });
});

describe('frameAncestors', () => {
  it('names exactly the shop and the admin when the shop is known', () => {
    assert.equal(frameAncestors(SHOP), `frame-ancestors https://${SHOP} https://admin.shopify.com;`);
  });

  it('falls back to Shopify’s own domains only — never a wildcard that any site could satisfy', () => {
    const policy = frameAncestors(null);
    assert.equal(policy, 'frame-ancestors https://admin.shopify.com https://*.myshopify.com;');
    // Read the sources one by one: a lone `*` or a bare `https:` scheme would let any site frame the app.
    const sources = policy.replace(/;$/, '').split(/\s+/).slice(1);
    for (const source of sources) {
      assert.match(source, /^https:\/\/[a-z*.]+\.shopify\.com$|^https:\/\/\*\.myshopify\.com$/, source);
      assert.notEqual(source, '*');
      assert.notEqual(source, 'https:');
    }
  });
});

describe('serveWebsite', () => {
  it('adds the frame-ancestors policy for the shop named in the URL to a page', async () => {
    const stand = assets(() => page());
    const response = await serveWebsite(new Request(`https://app.example/seo/title-tags?shop=${SHOP}&embedded=1`), stand);
    assert.equal(response.headers.get('Content-Security-Policy'), `frame-ancestors https://${SHOP} https://admin.shopify.com;`);
    assert.equal(await response.text(), '<!doctype html><title>app</title>', 'the page itself is unchanged');
    assert.equal(response.status, 200);
  });

  it('uses the fallback when the URL carries no shop, such as a reload of an in-app route', async () => {
    const response = await serveWebsite(new Request('https://app.example/settings'), assets(() => page()));
    assert.equal(response.headers.get('Content-Security-Policy'), frameAncestors(null));
  });

  it('puts nothing the caller chose into the header unless it is a real shop', async () => {
    const response = await serveWebsite(new Request('https://app.example/?shop=evil.com%0d%0aX-Injected%3A%201'), assets(() => page()));
    assert.equal(response.headers.get('Content-Security-Policy'), frameAncestors(null));
    assert.equal(response.headers.get('X-Injected'), null);
  });

  it('removes X-Frame-Options from a page, since a browser would enforce it alongside the policy', async () => {
    const response = await serveWebsite(new Request(`https://app.example/?shop=${SHOP}`), assets(() => page({ 'X-Frame-Options': 'SAMEORIGIN' })));
    assert.equal(response.headers.get('X-Frame-Options'), null);
  });

  it('keeps the other headers a page came with', async () => {
    const response = await serveWebsite(
      new Request('https://app.example/'),
      assets(() => page({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=0, must-revalidate' })),
    );
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
    assert.match(response.headers.get('Content-Type')!, /text\/html/);
  });

  it('passes a file through untouched — no policy added to a script, a stylesheet or a font', async () => {
    for (const type of ['application/javascript', 'text/css', 'font/woff2', 'image/svg+xml']) {
      const original = new Response('x', { headers: { 'Content-Type': type, 'X-Frame-Options': 'DENY' } });
      const response = await serveWebsite(new Request('https://app.example/assets/file'), assets(() => original));
      assert.equal(response, original, type);
      assert.equal(response.headers.get('Content-Security-Policy'), null, type);
    }
  });

  it('keeps an error page’s status', async () => {
    const response = await serveWebsite(
      new Request('https://app.example/x'),
      assets(() => new Response('<p>no</p>', { status: 404, headers: { 'Content-Type': 'text/html' } })),
    );
    assert.equal(response.status, 404);
    assert.ok(response.headers.get('Content-Security-Policy'));
  });

  it('asks the assets for exactly the page that was requested', async () => {
    const stand = assets(() => page());
    await serveWebsite(new Request(`https://app.example/reports?shop=${SHOP}`), stand);
    assert.deepEqual(stand.seen, [`https://app.example/reports?shop=${SHOP}`]);
  });
});

describe('isApiPath', () => {
  it('sends the API and the local cron hook to the API, and everything else to the website', () => {
    for (const pathname of ['/api', '/api/', '/api/auth/shopify/embedded', '/__scheduled']) assert.equal(isApiPath(pathname), true, pathname);
    for (const pathname of ['/', '/seo', '/seo/title-tags', '/apiary', '/api-docs', '/assets/index.js']) assert.equal(isApiPath(pathname), false, pathname);
  });
});

describe('the Wrangler helper', () => {
  const backend = path.resolve(import.meta.dirname, '../..');
  const wrangler = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/wrangler.ts', ...args], { cwd: backend, encoding: 'utf8' });

  it('finds every placeholder an unfinished environment still holds, once each', () => {
    const unfinished = { account_id: 'REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID', vars: { BACKEND_URL: 'https://REPLACE_WITH_YOUR_DOMAIN', FRONTEND_URL: 'https://REPLACE_WITH_YOUR_DOMAIN' } };
    assert.deepEqual(findPlaceholders(unfinished), ['REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID', 'REPLACE_WITH_YOUR_DOMAIN']);
    assert.deepEqual(findPlaceholders(undefined), []);
  });

  it('finds none in the staging and production environments, so their commands may run', async () => {
    const { default: fs } = await import('node:fs');
    const ts = (await import('typescript')).default;
    const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync(path.join(backend, 'wrangler.jsonc'), 'utf8'));
    const environments = (parsed.config as { env: Record<string, unknown> }).env;
    for (const name of ['staging', 'production']) assert.deepEqual(findPlaceholders(environments[name]), [], name);
  });

  it('refuses an environment that does not exist', () => {
    const result = wrangler('whoami', '--env', 'nowhere');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no environment "nowhere"/);
  });
});
