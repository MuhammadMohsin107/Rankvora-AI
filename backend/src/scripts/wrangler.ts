/**
 * Runs Wrangler against exactly one Cloudflare account — the one wrangler.jsonc names for the
 * environment — and says which, before anything happens.
 *
 *   tsx src/scripts/wrangler.ts d1 migrations apply rankvora-staging --env staging --remote
 *
 * Why this exists: the login on this machine can reach two accounts (the company one and a personal
 * one). wrangler.jsonc pins the company account, but not every Wrangler command reads that pin:
 * `wrangler d1 migrations` with --env ignores it and, in a terminal, asks which account to use — one
 * wrong pick and the change lands on the wrong account. Wrangler always honours the
 * CLOUDFLARE_ACCOUNT_ID variable, so this sets it from the config and then runs the command
 * unchanged. The npm scripts that touch Cloudflare go through here (package.json `cf:*`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const backend = path.resolve(import.meta.dirname, '../..');

const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', fs.readFileSync(path.join(backend, 'wrangler.jsonc'), 'utf8'));
if (parsed.error) {
  console.error('wrangler.jsonc could not be read:', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  process.exit(1);
}
const config = parsed.config as { account_id?: string; env?: Record<string, { name?: string; account_id?: string }> };

// --env staging, -e staging, or --env=staging
const envIndex = args.findIndex((arg) => arg === '--env' || arg === '-e');
const envName = envIndex >= 0 ? args[envIndex + 1] : args.find((arg) => arg.startsWith('--env='))?.slice('--env='.length);
const environment = envName ? config.env?.[envName] : undefined;
if (envName && !environment) {
  console.error(`wrangler.jsonc has no environment "${envName}".`);
  process.exit(1);
}

// An environment that has not been pointed at a real account, domain and database yet carries
// REPLACE_WITH_… placeholders (wrangler.jsonc, env.production). Running anything against it would
// reach whatever those words happen to resolve to, so it stops here and says what is missing.
const placeholders = [...new Set(JSON.stringify(environment ?? {}).match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? [])];
if (placeholders.length > 0) {
  console.error(`wrangler.jsonc environment "${envName}" is not filled in yet. Replace: ${placeholders.join(', ')}`);
  process.exit(1);
}

const accountId = environment?.account_id ?? config.account_id;
if (!accountId) {
  console.error('wrangler.jsonc names no account_id for this command; refusing to let Wrangler choose one.');
  process.exit(1);
}

console.log(`Cloudflare account: ${accountId}${envName ? `  ·  environment: ${envName} (Worker "${environment?.name}")` : ''}`);

// Wrangler's package does not export its bin path, so it is found where npm installs it.
const wrangler = path.join(backend, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!fs.existsSync(wrangler)) {
  console.error('Wrangler is not installed in backend/node_modules — run npm ci in backend.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [wrangler, ...args], {
  cwd: backend,
  stdio: 'inherit',
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
});
process.exit(result.status ?? 1);
