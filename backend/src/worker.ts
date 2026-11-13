import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { httpServerHandler } from 'cloudflare:node';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { app } from './app.js';
import { runAuditJob } from './audit-engine/runner.js';
import { drizzle, type AnyD1Database } from 'drizzle-orm/d1';
import { runWithDatabase, type Database } from './db/client.js';
import * as schema from './db/schema.js';
import { isApiPath, serveWebsite } from './cloudflare/shell.js';
import { useCloudflareEdge } from './middleware/cloudflareEdge.js';
import { useSharedRateLimitStore } from './middleware/rateLimit.js';
import { useAuditRunStarter } from './services/job.service.js';
import { useLinkScanStarter } from './services/link-scan.service.js';
import { runLinkScanBatch } from './link-scan/engine.js';
import { runScheduledWork } from './services/scheduled-work.service.js';

// Durable Object classes must be exported by the Worker's main module (wrangler.jsonc binds them).
export { RateLimiter } from './cloudflare/rate-limiter.js';

/**
 * ─── The Cloudflare Workers entry point ──────────────────────────────
 *
 * Runs the SAME Express application as server.ts (see app.ts), handed to Workers through its Node
 * HTTP-server support. There is no port, no listener and no process here: Cloudflare starts the
 * Worker, sends it requests, and stops it, and many copies can be running at once.
 *
 * So nothing that belongs to "the one running process" may be started from this file or from
 * anything it imports at load time — no `setInterval`, no boot-time sweep, no log patching. The
 * scheduled sweeps and the audit runs are driven by Cloudflare (a cron trigger and a Workflow).
 *
 * THE DATABASE. Cloudflare D1, through the `DB` binding. Every request, workflow step and cron tick
 * runs inside runWithDatabase(), so `db` everywhere in the app is this D1 database (db/client.ts).
 * A D1 binding is not a connection: there is nothing to open per request and nothing to close.
 *
 * AUDIT RUNS. A run takes minutes; a Worker lives as long as one request. So a run is handed to
 * AuditWorkflow below — Cloudflare's own long-running job — instead of being left running in the
 * background, where it would be cut off along with its database connection.
 *
 * SCHEDULED WORK. The 30-minute timers server.ts starts become a Cloudflare cron trigger calling
 * `scheduled` below: auto-analysis, weekly summaries and the stuck-job sweep
 * (services/scheduled-work.service.ts).
 *
 * RATE LIMITS. Counted in the RateLimiter Durable Object (cloudflare/rate-limiter.ts) rather than in
 * memory, because the many copies of a Worker do not share memory.
 *
 * THE CALLER'S ADDRESS AND SECURITY HEADERS. There is no nginx in front of a Worker, so
 * middleware/cloudflareEdge.ts takes the caller's address from Cloudflare's CF-Connecting-IP header
 * (which the rate limits key on) and adds the five security headers nginx adds on the server.
 *
 * CONFIGURED IN wrangler.jsonc (bindings, cron, the website, limits). Before the first deploy the
 * staging database must exist and its id be added there, and the required secrets be set.
 *
 * Excluded from the Node build (tsconfig.build.json): `dist/` must stay exactly what deploy.sh has
 * always shipped, and `cloudflare:*` modules do not exist outside Workers.
 */

/** A Workflow binding: the one call made on it here. */
interface WorkflowBinding<Params> {
  create(options: { id?: string; params?: Params }): Promise<unknown>;
}

/**
 * What a Workflow instance is started with: an audit run (`jobId`) or a link scan (`linkScanId`). Both run in
 * the one Workflow class below — a scan is long and steps through batches, an audit is one step — so there is a
 * single Workflow binding to configure.
 */
type AuditRunParams = { jobId: number; linkScanId?: undefined } | { linkScanId: number; jobId?: undefined };

/** The RateLimiter Durable Object binding: the calls made on it here. */
interface RateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { hit(windowMs: number): Promise<{ count: number; resetAt: number }> };
}

interface WorkerEnv {
  /** The website's static files (wrangler.jsonc `assets.binding`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The D1 database (wrangler.jsonc `d1_databases`). */
  DB: AnyD1Database;
  AUDIT_WORKFLOW: WorkflowBinding<AuditRunParams>;
  RATE_LIMITER: RateLimiterNamespace;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What a cron trigger is called with: when this tick was due, and which schedule fired. */
interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

/** The app's D1 database through Drizzle, with the app's schema — the same `Database` db/client.ts serves. */
function openDatabase(env: WorkerEnv): Database {
  return drizzle(env.DB, { schema }) as unknown as Database;
}

/**
 * Points the shared services at this Worker's Cloudflare bindings. `env` is the same object for
 * every request this Worker serves, so setting it again is harmless.
 */
function useCloudflareServices(env: WorkerEnv): void {
  useCloudflareEdge(true);

  useAuditRunStarter(async (job) => {
    // The job id first, so an instance can be found from the job row. The suffix keeps the id
    // unique when job ids repeat — a database restored or rebuilt while an older instance with the
    // same job id is still within Cloudflare's retention would otherwise refuse the new run.
    await env.AUDIT_WORKFLOW.create({
      id: `audit-${job.id}-${randomUUID().slice(0, 8)}`,
      params: { jobId: job.id },
    });
  });

  useLinkScanStarter(async (scan) => {
    await env.AUDIT_WORKFLOW.create({
      id: `links-${scan.id}-${randomUUID().slice(0, 8)}`,
      params: { linkScanId: scan.id },
    });
  });

  useSharedRateLimitStore({
    hit(name, key, windowMs) {
      // One counter per limiter and key. Hashed, so the object's name carries no IP address or
      // email — keys are built from both — while the same pair still always reaches the same counter.
      const counter = env.RATE_LIMITER.idFromName(createHash('sha256').update(`${name}|${key}`).digest('hex'));
      return env.RATE_LIMITER.get(counter).hit(windowMs);
    },
  });
}

const handler = httpServerHandler(http.createServer(app));

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    // A page request: serve the website, with the framing policy the Shopify admin needs. Static
    // files never reach here — wrangler.jsonc `run_worker_first` keeps them off the Worker.
    if (!isApiPath(new URL(request.url).pathname)) return serveWebsite(request, env.ASSETS);

    useCloudflareServices(env);
    return runWithDatabase(openDatabase(env), () => handler.fetch(request, env, ctx));
  },

  /**
   * The cron trigger (wrangler.jsonc `triggers.crons`). Judged against the time the tick was DUE,
   * not when it happened to start, so a delayed tick decides "is it due?" exactly as an on-time one
   * would. Audits it queues are started as Workflows, through the same starter requests use.
   */
  async scheduled(controller: ScheduledController, env: WorkerEnv, _ctx: WorkerContext): Promise<void> {
    useCloudflareServices(env);
    await runWithDatabase(openDatabase(env), () => runScheduledWork(new Date(controller.scheduledTime)));
  },
};

/**
 * One audit run, as a Cloudflare Workflow.
 *
 * A single step that runs the same runAuditJob the Node server runs — reading Shopify, crawling the
 * storefront, scoring, saving, notifying — against the same D1 database.
 *
 * NO AUTOMATIC RETRY. runAuditJob is not safe to repeat: a second attempt after a failure late in
 * the run would save a second audit for the same job. It already records every failure on the job
 * row itself ('failed', with the reason), which is what the merchant sees; a retry would add nothing
 * but a duplicate. A run that dies without reaching that code — the Worker running out of memory,
 * say — leaves the job 'running', and the stuck-job sweep closes it out.
 */
export class AuditWorkflow extends WorkflowEntrypoint<WorkerEnv, AuditRunParams> {
  async run(event: WorkflowEvent<AuditRunParams>, step: WorkflowStep): Promise<void> {
    if (event.payload.linkScanId !== undefined) {
      await this.runLinkScan(event.payload.linkScanId, step);
      return;
    }
    const { jobId } = event.payload as { jobId: number };
    await step.do('run audit', { retries: { limit: 0, delay: '1 second' }, timeout: AUDIT_STEP_TIMEOUT }, async () => {
      useCloudflareServices(this.env);
      await runWithDatabase(openDatabase(this.env), () => runAuditJob(jobId));
      return { jobId };
    });
  }

  /**
   * One link scan: a step per batch. Each step is its own invocation with its own request and query
   * budget, which is what lets a store with thousands of pages be scanned completely on Workers. A batch
   * repeats nothing it already recorded (link-scan/engine.ts), so a step that fails is retried.
   */
  private async runLinkScan(scanId: number, step: WorkflowStep): Promise<void> {
    // 40 pages or 120 targets a step: 1,000 steps cover 40,000 pages. The ceiling is a runaway guard, not a limit anyone meets.
    for (let batch = 1; batch <= MAX_LINK_SCAN_STEPS; batch += 1) {
      const { done } = await step.do(`links batch ${batch}`, { retries: { limit: 2, delay: '5 seconds' }, timeout: '10 minutes' }, async () => {
        useCloudflareServices(this.env);
        return runWithDatabase(openDatabase(this.env), () => runLinkScanBatch(scanId));
      });
      if (done) return;
    }
  }
}

const MAX_LINK_SCAN_STEPS = 1_000;

/**
 * The longest one audit run may take. An analysis of even a very large catalogue is a matter of minutes
 * (services/job.service.ts failStuckJobs closes a run that outlasts this by a margin), and a run that
 * has not finished in half an hour is not slow, it is dead — with the old hour, and a sweep that waited
 * another half hour on top of it, a merchant whose run died could not start another for ninety minutes.
 */
const AUDIT_STEP_TIMEOUT = '30 minutes';
