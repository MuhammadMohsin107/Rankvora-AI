// ─── wrangler.jsonc and the code agree (npm test) ────────────────────
// The Cloudflare config names things the code relies on — binding names, class names, files, secrets —
// and the code names things the config must provide. Nothing checks that agreement until a deploy
// fails, or worse, deploys and then fails at the first request. This reads wrangler.jsonc, the
// Worker's source and the website's _headers file, and fails as soon as they drift apart.
//
// Why a test and not `wrangler types`: the generated types declare the whole Workers runtime as
// globals, which clash with Node's in this TypeScript project (the same code also runs on Node), while
// what actually goes wrong is a name changed on one side only. That is what this checks.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

const backend = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.resolve(backend, relative), 'utf8');

interface Binding { binding?: string; name?: string; class_name?: string; database_name?: string; database_id?: string; migrations_dir?: string }
interface WorkerConfig {
  name: string;
  vars?: Record<string, string>;
  secrets?: { required?: string[] };
  d1_databases?: Binding[];
  workflows?: Binding[];
  durable_objects?: { bindings?: Binding[] };
}
interface Config extends WorkerConfig {
  main: string;
  alias?: Record<string, string>;
  account_id?: string;
  routes?: Array<{ pattern: string; custom_domain?: boolean }>;
  assets: { directory: string; binding?: string; not_found_handling?: string; run_worker_first?: string[] };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  triggers?: { crons?: string[] };
  limits?: { cpu_ms?: number };
  env: Record<string, WorkerConfig>;
}

// TypeScript's own JSON-with-comments reader, so comments and trailing commas are read exactly as
// Wrangler reads them.
const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', read('wrangler.jsonc'));
if (parsed.error) throw new Error(`wrangler.jsonc does not parse: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`);
const config = parsed.config as Config;
const workerSource = read(config.main);

/** Every place the Worker runs: local development (the top level) and each environment. */
const targets: Array<[string, WorkerConfig]> = [['local (top level)', config], ...Object.entries(config.env)];

/**
 * The variables config/env.ts refuses to start without — the `name: required('X')` entries read when
 * it loads. DATABASE_PATH is not one: only a Node process asks for it (requireDatabasePath), because
 * on Cloudflare the database is the D1 binding rather than a file.
 */
const requiredByApp = [...read('src/config/env.ts').matchAll(/:\s*required\('([A-Z_]+)'\)/g)].map((match) => match[1]!);

describe('wrangler.jsonc', () => {
  it('parses, and points at files that exist', () => {
    assert.ok(fs.existsSync(path.resolve(backend, config.main)), `main: ${config.main}`);
    for (const [name, file] of Object.entries(config.alias ?? {})) {
      assert.ok(fs.existsSync(path.resolve(backend, file)), `alias ${name} → ${file}`);
    }
    assert.equal(config.assets.directory, '../frontend/dist');
  });

  it('pins a Cloudflare account at the top level and in every environment', () => {
    // Wrangler does not carry the top-level account_id into an environment for every command, so
    // each environment names it too; otherwise a login holding two accounts is asked to choose.
    //
    // WHICH account is not asserted: the app is deployed to whichever account its owner points an
    // environment at. What is asserted is that none is left to Wrangler's choice, and that an
    // account is either a real id (32 hex characters) or the explicit placeholder of an environment
    // that has not been pointed anywhere yet — never an empty or half-typed value.
    const accountShape = /^([0-9a-f]{32}|REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID)$/;
    assert.match(config.account_id ?? '', accountShape, 'top level');
    for (const [name, environment] of Object.entries(config.env)) {
      assert.match((environment as { account_id?: string }).account_id ?? '', accountShape, `env.${name}`);
    }
  });

  for (const [where, target] of targets) {
    describe(where, () => {
      it('provides every binding the Worker reads, under the name it reads', () => {
        // worker.ts WorkerEnv: DB, AUDIT_WORKFLOW, RATE_LIMITER.
        for (const binding of ['DB', 'AUDIT_WORKFLOW', 'RATE_LIMITER']) {
          assert.match(workerSource, new RegExp(`\\b${binding}:`), `worker.ts no longer reads ${binding}`);
        }
        assert.equal(target.d1_databases?.[0]?.binding, 'DB');
        assert.equal(target.workflows?.[0]?.binding, 'AUDIT_WORKFLOW');
        assert.equal(target.durable_objects?.bindings?.[0]?.name, 'RATE_LIMITER');
      });

      it('names classes the Worker actually exports', () => {
        const workflowClass = target.workflows?.[0]?.class_name;
        const limiterClass = target.durable_objects?.bindings?.[0]?.class_name;
        assert.match(workerSource, new RegExp(`export class ${workflowClass}\\b`), `worker.ts does not export ${workflowClass}`);
        assert.match(workerSource, new RegExp(`export \\{ ${limiterClass} \\}`), `worker.ts does not export ${limiterClass}`);
      });

      it('reads its D1 migrations from the folder drizzle-kit writes to', () => {
        const folder = target.d1_databases?.[0]?.migrations_dir;
        assert.equal(folder, 'drizzle-d1');
        assert.ok(fs.readdirSync(path.resolve(backend, folder!)).some((file) => file.endsWith('.sql')));
      });

      it('requires every secret the app cannot start without', () => {
        for (const name of requiredByApp) {
          assert.ok(target.secrets?.required?.includes(name), `${name} is required by config/env.ts but not by ${where}`);
        }
      });

      it('keeps secrets out of plain variables', () => {
        for (const name of Object.keys(target.vars ?? {})) {
          assert.doesNotMatch(name, /SECRET|TOKEN|PASSWORD|_KEY$/, `${name} looks like a secret; set it with wrangler secret put`);
        }
      });
    });
  }

  it('gives each environment its own Worker and Workflow name', () => {
    const names = targets.map(([, target]) => target.name);
    const workflows = targets.map(([, target]) => target.workflows?.[0]?.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(workflows).size, workflows.length);
  });

  it('staging requires everything Shopify sign-in needs, and runs in production mode on its own address', () => {
    const staging = config.env.staging!;
    for (const name of ['TOKEN_ENCRYPTION_KEY', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET']) {
      assert.ok(staging.secrets?.required?.includes(name), name);
    }
    assert.equal(staging.vars?.NODE_ENV, 'production', 'NODE_ENV=development would allow MOCK_AUTH');
    // Shopify sends a merchant back to BACKEND_URL after sign-in, so it must be an address this Worker
    // answers on: the test address on workers.dev until go-live, the real domain after it. Anything
    // else — a typo, localhost — would send merchants somewhere the app is not.
    const addresses = ['https://rankvora-staging.cp-chahmad.workers.dev', 'https://scorelo-staging.tlxapps.com'];
    assert.ok(addresses.includes(staging.vars?.BACKEND_URL ?? ''), `BACKEND_URL is ${staging.vars?.BACKEND_URL}`);
    assert.equal(staging.vars?.FRONTEND_URL, staging.vars?.BACKEND_URL, 'the site and the API share one origin');
  });

  it('every npm script that touches a Cloudflare environment pins the account through src/scripts/wrangler.ts', () => {
    // `wrangler d1 migrations` ignores the config's account_id and asks which account to use; the
    // helper sets CLOUDFLARE_ACCOUNT_ID from the config, which every Wrangler command honours. Dry
    // runs upload nothing and need no account.
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    const remote = Object.entries(scripts).filter(([, command]) => /--env\s+\w+/.test(command) && !command.includes('--dry-run'));
    assert.ok(remote.length >= 4, 'expected the staging scripts');
    for (const [name, command] of remote) {
      assert.match(command, /tsx src\/scripts\/wrangler\.ts /, `${name} runs wrangler directly`);
      assert.doesNotMatch(command.replace(/tsx src\/scripts\/wrangler\.ts /g, ''), /\bwrangler /, `${name} runs wrangler directly`);
    }
  });

  it('production is the public app: production mode, one origin, and the same host in the Worker and in shopify.app.toml', () => {
    const production = config.env.production as WorkerConfig & {
      account_id: string;
      workers_dev?: boolean;
      routes?: Array<{ pattern: string; custom_domain?: boolean }>;
    };
    assert.ok(production, 'env.production exists');
    for (const name of ['TOKEN_ENCRYPTION_KEY', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET']) {
      assert.ok(production.secrets?.required?.includes(name), name);
    }
    assert.equal(production.vars?.NODE_ENV, 'production', 'NODE_ENV=development would allow MOCK_AUTH');
    assert.equal(production.vars?.FRONTEND_URL, production.vars?.BACKEND_URL, 'the site and the API share one origin');

    // Shopify's app URL, redirect URLs and webhooks all point at BACKEND_URL, and the Worker must answer
    // there. It answers either on its workers.dev address or on a custom-domain route — never on both,
    // and never somewhere else than the origin it announces.
    const origin = new URL(production.vars!.BACKEND_URL!);
    assert.equal(origin.protocol, 'https:');
    if (production.routes?.length) {
      assert.equal(production.routes.length, 1);
      assert.equal(production.routes[0]!.custom_domain, true, 'a custom domain, not a path on another host');
      assert.equal(production.routes[0]!.pattern.toLowerCase(), origin.hostname);
      assert.equal(production.workers_dev, false, 'a Worker on a custom domain is not also served from workers.dev');
    } else {
      assert.equal(production.workers_dev, true, 'with no route the Worker is reachable only through workers.dev');
      assert.match(origin.hostname, new RegExp(`^${production.name}\\.[a-z0-9-]+\\.workers\\.dev$`), 'the workers.dev address is <worker name>.<account subdomain>.workers.dev');
    }
    // Shopify rejects an app URL that mentions itself or the example domain.
    assert.doesNotMatch(origin.hostname, /shopify|example/i);
  });

  it('shopify.app.toml announces the same address the production Worker answers on', () => {
    const toml = fs.readFileSync(path.resolve(backend, '../shopify.app.toml'), 'utf8');
    const production = config.env.production as WorkerConfig;
    const origin = new URL(production.vars!.BACKEND_URL!).origin;
    const urls = [...toml.matchAll(/"(https?:\/\/[^"]+)"/g)].map((match) => match[1]!);
    assert.ok(urls.length >= 5, 'application_url, the redirect URL and the three privacy URLs');
    for (const url of urls) assert.equal(new URL(url).origin, origin, `${url} is not on ${origin}`);
    assert.doesNotMatch(toml, /REPLACE_WITH_/);
  });

  it('local development cannot be deployed by mistake', () => {
    assert.equal(config.d1_databases?.[0]?.database_id, '00000000-0000-0000-0000-000000000000');
  });

  it('runs the Worker for every page and for the API, and lets only the built files bypass it', () => {
    // Inside the Shopify admin the site runs in an iframe, which needs a per-shop frame-ancestors
    // header on each page response. A static file cannot hold one, so the Worker (src/cloudflare/
    // shell.ts) must see every request for a page — and must not see the built files, which would
    // only add a Worker invocation to every script, stylesheet and font.
    const first = config.assets.run_worker_first ?? [];
    assert.ok(first.includes('/*'), 'pages must reach the Worker');
    const bypass = first.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
    assert.ok(bypass.includes('/assets/*'), 'the hashed build files bypass the Worker');
    // Every bypass names something that really is a static file — a typo here would silently send a
    // file through the Worker, or stop a real one being served.
    const pub = path.resolve(backend, '../frontend/public');
    for (const pattern of bypass.filter((pattern) => pattern !== '/assets/*')) {
      const file = path.join(pub, pattern.replace(/\/\*$/, '').slice(1));
      assert.ok(fs.existsSync(file), `${pattern} names ${file}, which does not exist`);
    }
    assert.equal(config.assets.not_found_handling, 'single-page-application');
  });

  it('gives the Worker the ASSETS binding it serves pages through, under the name it reads', () => {
    assert.equal(config.assets.binding, 'ASSETS');
    assert.match(workerSource, /\bASSETS:/, 'worker.ts no longer reads ASSETS');
    assert.match(workerSource, /serveWebsite\(request, env\.ASSETS\)/);
  });

  it('declares the rate limiter’s storage and the 30-minute cron', () => {
    assert.ok(config.migrations?.some((migration) => migration.new_sqlite_classes?.includes('RateLimiter')));
    assert.deepEqual(config.triggers?.crons, ['*/30 * * * *']);
  });

  it('raises the CPU limit to 5 minutes, or has it off ONLY on purpose while the account is on the Free plan', () => {
    // An audit needs far more than Free's 10 ms of CPU, so the real app needs the 5-minute limit — which
    // Cloudflare accepts only on the Workers Paid plan. While the account is on Free the line is
    // commented out, and the comment says so; this fails if it goes missing without that note, so it
    // cannot be forgotten, and it demands the real value as soon as the line is back.
    if (config.limits?.cpu_ms !== undefined) {
      assert.equal(config.limits.cpu_ms, 300_000);
      assert.doesNotMatch(read('wrangler.jsonc'), /FREE MODE/, 'the limit is on, so the Free-mode note must be deleted with it');
    } else {
      assert.match(read('wrangler.jsonc'), /PAID ONLY/, 'cpu_ms is off without the PAID ONLY note');
      assert.match(read('wrangler.jsonc'), /\/\/ "limits": \{ "cpu_ms": 300000 \},/, 'the line to re-enable is missing');
    }
  });
});

describe('the website’s _headers', () => {
  // Read with either line ending: a Windows checkout may hand back CRLF.
  const headersFile = fs.readFileSync(path.resolve(backend, '../frontend/public/_headers'), 'utf8').replace(/\r\n/g, '\n');

  it('sends the same security headers, with the same values, as the API does — except X-Frame-Options', () => {
    const fromApi = [...read('src/middleware/cloudflareEdge.ts').matchAll(/'([A-Za-z-]+)': '([^']+)'/g)]
      .map((match) => [match[1]!, match[2]!] as const)
      .filter(([name]) => /^(X-|Referrer-Policy)/.test(name));
    assert.equal(fromApi.length, 5, 'expected five headers in cloudflareEdge.ts');
    for (const [name, value] of fromApi.filter(([name]) => name !== 'X-Frame-Options')) {
      assert.match(headersFile, new RegExp(`^  ${name}: ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${name}: ${value}`);
    }
  });

  it('leaves X-Frame-Options to the Worker, because SAMEORIGIN would refuse the Shopify admin’s iframe', () => {
    // A page carrying both X-Frame-Options and a frame-ancestors policy is held to BOTH, so the one
    // header that cannot name a shop would defeat the one that can.
    assert.doesNotMatch(headersFile, /^\s*X-Frame-Options:/im);
    // Comments may explain the policy; only a real header line would set it.
    const headerLines = headersFile.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    assert.doesNotMatch(headerLines.join('\n'), /frame-ancestors/i, 'the policy differs per shop and is set by the Worker');
  });

  it('caches the content-hashed build files for a year, and nothing else', () => {
    assert.match(headersFile, /^\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable$/m);
    assert.equal(headersFile.match(/Cache-Control/g)?.length, 1);
  });
});
