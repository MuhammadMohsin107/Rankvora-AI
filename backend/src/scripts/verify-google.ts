/**
 * Read-only verification of the Google Search Console setup.
 *
 *   npm run verify:google
 *
 * Why this exists: every failure mode of this integration is silent from the outside. A redirect
 * URI that differs by one character is rejected by GOOGLE, before Rankvora AI is ever called, so
 * nothing appears in the server log. A missing TOKEN_ENCRYPTION_KEY hides the Connect button
 * rather than erroring. A refresh token expired by the 7-day Testing-mode rule fails only on the
 * next background read. This script turns each of those into a line of output.
 *
 * It runs in two modes, chosen by what exists:
 *
 *   1. NO CONNECTION YET — checks the server-side configuration and prints the exact redirect URI
 *      to register in the Google Cloud console. Run this BEFORE pressing Connect; it is the
 *      cheapest way to catch a mismatch.
 *
 *   2. CONNECTED — exercises the real API exactly as an audit would: renews the access token if
 *      needed, lists the properties the account can read, and pulls one performance window.
 *
 * It issues READS ONLY. It requests no writable scope, changes nothing in Search Console, and the
 * only rows it touches are the lastSyncedAt/lastError bookkeeping the service itself performs.
 * No token, encrypted or otherwise, is ever printed.
 */
import { isNull } from 'drizzle-orm';
import { closeDatabase, db } from '../db/client.js';
import { googleConnections } from '../db/schema.js';
import { env, googleConfigured } from '../config/env.js';
import { getSearchConsolePerformance, listSearchConsoleSites } from '../services/search-console.service.js';

/** Reported as present/absent only — never the value. */
const REQUIRED = [
  ['GOOGLE_CLIENT_ID', env.googleClientId],
  ['GOOGLE_CLIENT_SECRET', env.googleClientSecret],
  ['BACKEND_URL', env.backendUrl],
  ['TOKEN_ENCRYPTION_KEY', env.tokenEncryptionKey],
] as const;

function reportConfiguration(): boolean {
  console.log('\nConfiguration');

  let missing = 0;
  for (const [name, value] of REQUIRED) {
    if (value) {
      console.log(`  present  ${name}`);
    } else {
      missing += 1;
      console.log(`  MISSING  ${name}`);
    }
  }

  if (env.backendUrl) {
    // Derived exactly as google-oauth.service.ts derives it, so what is printed here is what
    // Google will be sent — not an approximation of it.
    const redirectUri = `${env.backendUrl.replace(/\/+$/, '')}/api/google/callback`;
    console.log(`\n  Redirect URI to register in Google Cloud, character for character:`);
    console.log(`    ${redirectUri}`);
  }

  if (missing > 0) {
    console.log(
      `\n  ${missing} value(s) missing. googleConfigured() is false, so /api/google/status reports`,
    );
    console.log(`  configured:false and the Integrations page hides Connect. Fill these in first.\n`);
    return false;
  }

  console.log(`\n  googleConfigured(): ${googleConfigured()}\n`);
  return googleConfigured();
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

async function main(): Promise<number> {
  const configured = reportConfiguration();
  if (!configured) return 1;

  const [connection] = await db
    .select()
    .from(googleConnections)
    .where(isNull(googleConnections.disconnectedAt))
    .limit(1);

  if (!connection) {
    console.log('Connection');
    console.log('  No store has connected Google Search Console yet.');
    console.log('  Open the app → Integrations → Google Search Console → Connect, then re-run.\n');
    // Not a failure: the configuration is what this run could check, and it passed.
    return 0;
  }

  console.log('Connection');
  console.log(`  store        : ${connection.storeId}`);
  console.log(`  account      : ${connection.googleEmail ?? '—'}`);
  console.log(`  property     : ${connection.siteUrl ?? 'none selected'}`);
  console.log(`  scope        : ${connection.scope}`);
  console.log(`  last synced  : ${connection.lastSyncedAt?.toISOString() ?? 'never'}`);
  console.log(`  renewable    : ${connection.refreshTokenEncrypted ? 'yes' : 'NO — reconnect required'}`);
  if (connection.lastError) console.log(`  last error   : ${connection.lastError}`);
  console.log('');

  let failures = 0;

  // Also the first call that forces a token renewal, so an expired refresh token surfaces here
  // rather than in a background job days later.
  console.log('Properties readable by this account');
  try {
    const sites = await listSearchConsoleSites(connection.storeId);
    if (sites.length === 0) {
      console.log('  none — the account has no verified property, or only unverified visibility.');
    }
    for (const site of sites) {
      const selected = site.siteUrl === connection.siteUrl ? '  <- selected' : '';
      console.log(`  ${site.permissionLevel.padEnd(18)} ${site.siteUrl}${selected}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  console.log('');

  if (!connection.siteUrl) {
    console.log('Performance');
    console.log('  Skipped — no property selected for this store yet. Choose one on Integrations.\n');
    return failures;
  }

  console.log('Performance (last 28 days, ending 3 days back)');
  try {
    const performance = await getSearchConsolePerformance(connection.storeId, 28);
    const { totals } = performance;
    console.log(`  range        : ${performance.startDate} to ${performance.endDate}`);
    console.log(`  clicks       : ${totals.clicks}`);
    console.log(`  impressions  : ${totals.impressions}`);
    console.log(`  CTR          : ${formatPercent(totals.ctr)}`);
    console.log(`  avg position : ${totals.position > 0 ? totals.position.toFixed(1) : '—'}`);
    console.log(`  top queries  : ${performance.topQueries.length} rows`);
    console.log(`  top pages    : ${performance.topPages.length} rows`);

    if (totals.impressions === 0) {
      // Worth saying outright: a new property with no history is the common case here, and
      // reading zeroes as a broken connection sends people looking for a bug that is not there.
      console.log('\n  All zero. That is a real zero — either the property has no search traffic');
      console.log('  in this window, or it was verified too recently to have finalised data.');
    }
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  console.log(
    failures === 0
      ? '\nSearch Console is connected and returning real data.\n'
      : `\n${failures} check(s) failed. See the messages above.\n`,
  );

  return failures;
}

// Never let an open database keep the process alive after the report is printed.
let exitCode = 1;
try {
  exitCode = (await main()) === 0 ? 0 : 1;
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
} finally {
  closeDatabase();
}
process.exit(exitCode);
