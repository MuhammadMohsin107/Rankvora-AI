/**
 * Read-only verification of the PageSpeed Insights setup.
 *
 *   npm run verify:pagespeed
 *
 * Why this exists: this connector has no consent screen to fail at, so every one of its failure
 * modes is a quiet one. An API key whose project has not enabled the PageSpeed Insights API is
 * rejected with a 403 that only appears when a merchant presses Run. An anonymous quota that is
 * already spent looks exactly like a slow storefront. A store whose url is still the signup
 * placeholder measures example.com. This script turns each of those into a line of output.
 *
 * It runs in two modes, chosen by what exists:
 *
 *   1. NO STORE YET — checks the server-side configuration and stops. There is nothing public to
 *      measure, and measuring something else to prove the API works would be a lie about which
 *      site was tested.
 *
 *   2. STORE CONNECTED — measures that store's real storefront exactly as the connector does, and
 *      prints what Google actually returned: the performance score, the real-visitor Core Web
 *      Vitals if Google has enough of them, and the lab metrics.
 *
 * It issues READS ONLY against Google. The only rows it touches are the ones the service itself
 * writes — the measurement and its connector bookkeeping — because it calls the same function the
 * button does rather than a parallel copy that could drift from it.
 *
 * The API key is reported as present or absent. Its value is never printed.
 */
import { closeDatabase, db } from '../db/client.js';
import { stores } from '../db/schema.js';
import { env, pagespeedKeyed } from '../config/env.js';
import { getPageSpeedStatus, runPageSpeedMeasurement } from '../services/pagespeed.service.js';
import type { PageSpeedReport } from '../services/pagespeed.service.js';

function reportConfiguration(): void {
  console.log('\nConfiguration');

  if (pagespeedKeyed()) {
    console.log('  present  PAGESPEED_API_KEY — runs use this server’s own Google quota');
    console.log('           Confirm "PageSpeed Insights API" is enabled on the key’s Google Cloud project,');
    console.log('           or every run returns 403 regardless of the key being valid.');
  } else {
    console.log('  absent   PAGESPEED_API_KEY — runs use Google’s shared anonymous quota');
    console.log('           The connector still works. The quota is per-IP and small, so a busy');
    console.log('           server will start seeing rate-limit failures.');
  }
  console.log(`  timeout  ${Math.round(env.pagespeedTimeoutMs / 1000)}s per strategy`);
}

function ms(value: number | null): string {
  if (value === null) return 'not reported';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function reportMeasurement(report: PageSpeedReport): void {
  console.log(`\n  ${report.strategy.toUpperCase()}`);
  console.log(`    measured        ${report.finalUrl ?? report.requestedUrl}`);
  console.log(`    performance     ${report.performanceScore ?? 'not reported'}${report.performanceScore === null ? '' : '/100'}`);

  if (report.field) {
    const scope = report.field.scope === 'origin' ? ' (whole domain — too few visits to this url)' : '';
    console.log(`    real visitors${scope}`);
    console.log(`      LCP           ${report.field.lcp ? `${ms(report.field.lcp.p75)} · ${report.field.lcp.rating}` : 'not reported'}`);
    console.log(`      INP           ${report.field.inp ? `${ms(report.field.inp.p75)} · ${report.field.inp.rating}` : 'not reported'}`);
    console.log(`      CLS           ${report.field.cls ? `${report.field.cls.p75.toFixed(3)} · ${report.field.cls.rating}` : 'not reported'}`);
  } else {
    // A real absence. Google has too few Chrome visits to report anonymously, which is normal for
    // a new or quiet store and is not a measurement of zero.
    console.log('    real visitors   none yet — Google has too few visits to report on this url');
    console.log('                    INP is field-only, so it cannot be shown at all until there are');
  }

  console.log('    lab test');
  console.log(`      LCP           ${ms(report.lab.lcpMs)}`);
  console.log(`      CLS           ${report.lab.cls === null ? 'not reported' : report.lab.cls.toFixed(3)}`);
  console.log(`      blocking time ${ms(report.lab.tbtMs)}  (lab proxy for INP — not INP)`);
  console.log(`      speed index   ${ms(report.lab.speedIndexMs)}`);

  if (report.opportunities.length > 0) {
    console.log('    biggest savings Google costed');
    for (const opportunity of report.opportunities.slice(0, 3)) {
      console.log(`      ${ms(opportunity.savingsMs).padEnd(9)} ${opportunity.title}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('PageSpeed Insights verification');
  reportConfiguration();

  // The first store on the instance, which is what a single-operator deployment has. Nothing is
  // measured that this instance does not already own.
  const [store] = await db.select({ id: stores.id, url: stores.url }).from(stores).orderBy(stores.id).limit(1);

  if (!store) {
    console.log('\nNo store on this instance, so there is no storefront to measure.');
    console.log('Connect a Shopify store first — this connector measures the public storefront.');
    return;
  }

  const before = await getPageSpeedStatus(store.id);
  console.log(`\nStore ${store.id}`);
  console.log(`  storefront      ${before.storefrontUrl ?? 'none — the store record has no usable url'}`);
  console.log(`  last measured   ${before.lastMeasuredAt ?? 'never'}`);
  if (before.lastError) console.log(`  last failure    ${before.lastError}`);

  if (!before.storefrontUrl) {
    console.log('\nNothing to measure. Connect the store to Shopify so its real storefront url is recorded.');
    return;
  }

  console.log('\nRunning a real measurement on both strategies. Google loads the page in a headless');
  console.log('browser on its own hardware, so this takes tens of seconds.');

  try {
    const after = await runPageSpeedMeasurement(store.id);
    for (const report of after.reports) reportMeasurement(report);
    if (after.lastError) {
      // A partial run: one strategy stored, the other not. Both facts are printed.
      console.log(`\n  partial         ${after.lastError}`);
    }
    console.log('\nDone. These are the numbers the Integrations card and the Core Web Vitals audit will show.');
  } catch (error) {
    // The service writes merchant-facing sentences for everything Google refused, so this is the
    // reason itself rather than a stack trace.
    console.log(`\nThe measurement did not complete: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
