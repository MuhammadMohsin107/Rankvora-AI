// ─── The content policy the page is sent with (npm test) ─────────────
// The page carries a Content-Security-Policy-Report-Only header (src/cloudflare/shell.ts): the browser
// reports what the policy would block and blocks nothing, until the reports are quiet enough to enforce.
// These tests hold the policy's shape and the way the page's own inline script is named in it.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

const { contentSecurityPolicy, frameAncestors, inlineScriptHashes, serveWebsite } = await import('../cloudflare/shell.js');

const SHOP = 'csp-test.myshopify.com';
const sha256 = (text: string) => createHash('sha256').update(text).digest('base64');
const INLINE = "(function () { document.documentElement.setAttribute('data-theme', 'light'); })();";

const withScripts = () =>
  new Response(
    `<!doctype html><head><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><script>${INLINE}</script></head><body></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

function assets(response: () => Response) {
  return { fetch: async () => response() };
}

describe('inlineScriptHashes', () => {
  it('hashes each inline script and skips external ones', async () => {
    assert.deepEqual(await inlineScriptHashes(await withScripts().text()), [sha256(INLINE)]);
  });

  it('hashes the exact text between the tags, so a changed script gets a different hash', async () => {
    const [a] = await inlineScriptHashes('<script>one()</script>');
    const [b] = await inlineScriptHashes('<script>one() </script>');
    assert.notEqual(a, b);
  });

  it('finds nothing in a page without inline script, and lists a repeated script once', async () => {
    assert.deepEqual(await inlineScriptHashes('<script src="/a.js"></script><p>hi</p>'), []);
    assert.equal((await inlineScriptHashes('<script>x()</script><script>x()</script>')).length, 1);
  });

  it('ignores a <script> mentioned inside an HTML comment, as index.html does in its own comments', async () => {
    const html = '<!-- it MUST be the first <script> on the page -->\n<script src="/a.js"></script><script>real()</script>';
    assert.deepEqual(await inlineScriptHashes(html), [sha256('real()')]);
  });

  it('does not mistake a tag that merely starts with "script" for a script', async () => {
    assert.deepEqual(await inlineScriptHashes('<scripted>not a script</scripted>'), []);
  });
});

describe('contentSecurityPolicy', () => {
  const directive = (policy: string, name: string) => policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

  it('lets scripts run only from this site, Shopify’s CDN and the named inline script', () => {
    assert.equal(directive(contentSecurityPolicy(['abc123=']), 'script-src'), "script-src 'self' https://cdn.shopify.com 'sha256-abc123='");
  });

  it('never allows inline or eval scripts, or a wildcard source, for scripts', () => {
    const scripts = `${directive(contentSecurityPolicy([]), 'script-src')} `;
    for (const banned of ["'unsafe-inline'", "'unsafe-eval'", ' * ', ' https: ', ' http: ']) assert.ok(!scripts.includes(banned), banned);
  });

  it('closes object, base and form targets, and says where to report', () => {
    const policy = contentSecurityPolicy([]);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /base-uri 'self'/);
    assert.match(policy, /form-action 'self'/);
    assert.match(policy, /report-uri \/api\/csp-report/);
  });

  it('is one header line a browser can read: no line break and no empty directive', () => {
    const policy = contentSecurityPolicy(['x=']);
    assert.ok(!/[\r\n]/.test(policy));
    for (const part of policy.split('; ')) assert.ok(part.trim() !== '');
  });
});

describe('serveWebsite, report-only policy', () => {
  it('adds the report-only policy next to the framing header, never in its place', async () => {
    const response = await serveWebsite(new Request(`https://app.example/?shop=${SHOP}`), assets(withScripts));
    assert.equal(response.headers.get('Content-Security-Policy'), frameAncestors(SHOP));
    const reportOnly = response.headers.get('Content-Security-Policy-Report-Only');
    assert.ok(reportOnly, 'a report-only policy is sent');
    assert.ok(!reportOnly.includes('frame-ancestors'), 'framing stays in the enforced header');
  });

  it('names the page’s own inline script by hash, so that script is not reported', async () => {
    const response = await serveWebsite(new Request('https://app.example/'), assets(withScripts));
    assert.ok(response.headers.get('Content-Security-Policy-Report-Only')!.includes(`'sha256-${sha256(INLINE)}'`));
  });

  it('still sends the page byte for byte', async () => {
    const original = await withScripts().text();
    const response = await serveWebsite(new Request('https://app.example/'), assets(withScripts));
    assert.equal(await response.text(), original);
  });

  it('enforces nothing beyond framing: the only enforced policy is frame-ancestors', async () => {
    const response = await serveWebsite(new Request('https://app.example/'), assets(withScripts));
    assert.ok(!response.headers.get('Content-Security-Policy')!.includes('script-src'));
  });

  it('serves the page with only the framing header if the policy cannot be built', async () => {
    const broken = new Response('<p>x</p>', { headers: { 'Content-Type': 'text/html' } });
    Object.defineProperty(broken, 'clone', { value: () => { throw new Error('cannot clone'); } });
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const response = await serveWebsite(new Request('https://app.example/'), assets(() => broken));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Security-Policy'), frameAncestors(null));
      assert.equal(response.headers.get('Content-Security-Policy-Report-Only'), null);
      assert.equal(logged.length, 1);
    } finally {
      console.error = original;
    }
  });

  it('adds no policy to a file', async () => {
    const file = new Response('x', { headers: { 'Content-Type': 'application/javascript' } });
    const response = await serveWebsite(new Request('https://app.example/assets/a.js'), assets(() => file));
    assert.equal(response.headers.get('Content-Security-Policy-Report-Only'), null);
  });
});
