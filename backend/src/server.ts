import { aiConfigured, crawlConfigured, env, googleConfigured, requireDatabasePath, shopifyConfigured } from './config/env.js';
import { describeErrorWithStack, installLogFormat } from './lib/logger.js';
import { app } from './app.js';
import { startAutoAnalysisScheduler } from './services/auto-analysis.service.js';
import { startWeeklySummaryScheduler } from './services/weekly-summary.service.js';
import { failInterruptedJobs } from './services/job.service.js';
import { failInterruptedLinkScans } from './services/link-scan.service.js';

/**
 * ─── The Node entry point ────────────────────────────────────────────
 *
 * Binds a port and does the work that belongs to ONE long-lived process: the log format, the
 * crash monitor, the two schedulers and the boot-time close-out of interrupted audit jobs. The HTTP
 * application itself lives in app.ts, shared with the Cloudflare Workers entry (worker.ts), which
 * has no port and no process of its own and must not do any of the above.
 */

// Fail at start-up, by name, when there is no database file — as the API always has. The database is
// opened on first use, so without this a missing DATABASE_PATH would not show until the first query,
// with the server already listening.
requireDatabasePath();

// Timestamp and level on every line from here on — see lib/logger.ts.
installLogFormat();

// A crash that takes the process down is written with a timestamp before Node exits. A MONITOR,
// not a handler: it observes without changing what happens next, so an uncaught exception or an
// unhandled rejection still ends the process (and pm2 still restarts it) exactly as before.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.error(`[scorelo-api] fatal ${origin === 'unhandledRejection' ? 'unhandled promise rejection' : 'uncaught exception'} — the process will exit: ${describeErrorWithStack(error)}`);
});

function listen() {
  app.listen(env.port, () => {
    console.log(`[scorelo-api] listening on http://localhost:${env.port} (${env.nodeEnv})`);
    // What this process can actually do, read from its configuration — so a log shows at a glance
    // why, say, no AI rewrite came back: "ai=off". Names and on/off only; never a value.
    const on = (value: boolean) => (value ? 'on' : 'off');
    console.log(
      `[scorelo-api] integrations: shopify=${on(shopifyConfigured())} google=${on(googleConfigured())} `
      + `ai=${aiConfigured() ? env.aiProvider : 'off'} crawl=${on(crawlConfigured())}`,
    );
    if (env.mockAuthEnabled) {
      console.warn('[scorelo-api] MOCK_AUTH is on — every request is signed in as user 1. Development only; deploy.sh refuses it.');
    }
    // Started after the server is accepting requests, not before: a sweep queues audits that run
    // in this same process, and the API must be answering first.
    startAutoAnalysisScheduler();
    startWeeklySummaryScheduler();
  });
}

// Jobs the previous process was running died with it (they run in-process), so their rows are
// closed out BEFORE this one accepts a request — afterwards, a job a merchant had just started could
// be mistaken for a leftover. A failure here is logged and startup continues: a stuck row costs
// that one store its next run, while refusing to start would cost every store the whole API.
//
// Skipped with FAIL_INTERRUPTED_JOBS=false: once Cloudflare runs the audits, active jobs belong to
// its Workflows, not to a process that just restarted, and failing them here would be wrong.
if (env.failInterruptedJobsOnStart) {
  failInterruptedJobs()
    .then((closed) => {
      if (closed > 0) console.warn(`[scorelo-api] marked ${closed} interrupted audit job(s) as failed — they were running when the previous process stopped`);
    })
    .catch((error) => console.error(`[scorelo-api] could not close interrupted audit jobs — ${describeErrorWithStack(error)}`))
    // Link scans run in this process too, so the ones a previous process left running are closed out the same way.
    .then(() => failInterruptedLinkScans())
    .then((closed) => {
      if (closed > 0) console.warn(`[scorelo-api] marked ${closed} interrupted link scan(s) as failed — they were running when the previous process stopped`);
    })
    .catch((error) => console.error(`[scorelo-api] could not close interrupted link scans — ${describeErrorWithStack(error)}`))
    .finally(listen);
} else {
  console.log('[scorelo-api] not closing out interrupted audit jobs (FAIL_INTERRUPTED_JOBS=false)');
  listen();
}
