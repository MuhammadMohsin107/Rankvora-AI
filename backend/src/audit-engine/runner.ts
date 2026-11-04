import { eq, sql } from 'drizzle-orm';
import type { SQLiteInsertValue } from 'drizzle-orm/sqlite-core';
import { db } from '../db/client.js';
import { groupForD1 } from '../db/limits.js';
import { auditScores, audits, findings, jobs, stores } from '../db/schema.js';
import { checkRegistry } from './index.js';
import { scoreOverall, scorePillar } from './scoring.js';
import { resolveStoreDataProvider, StoreDataError, type StoreDataProvider, type StoreSnapshot } from './store-data/index.js';
import type { SnapshotProgress, SnapshotStep } from './store-data/types.js';
import { unavailableResult, type AuditCheck, type PillarKey, type SubPillarResult } from './types.js';
import { notifyAnalysisFailed, notifyAuditOutcome, notifyScoreMovement } from '../services/notification.service.js';
import { runPromptSweep } from '../services/prompt-tracking.service.js';
import { applyShopifyFacts, factsFromShop } from '../services/store-profile.service.js';
import { describeError } from '../lib/logger.js';

/** Seams for integration tests to drive the worker without a live Shopify shop.
 * Production always uses the defaults. */
export interface RunnerDeps {
  resolveProvider?: (storeId: number) => Promise<StoreDataProvider>;
  checks?: AuditCheck[];
}

const PILLAR_ORDER: PillarKey[] = ['seo', 'content', 'speed', 'cro', 'ai-discovery'];

/**
 * One audit event: "[scorelo-audit] audit.completed {"jobId":12,"storeId":3,…}". Never includes
 * tokens, secrets or credentials — only ids, counts and describeError text.
 *
 * Failures are written at their level. Every event used to go to stdout as INFO, so "audit.failed"
 * sat in pm2's out log beside the successes and never reached its error log, which is where
 * anyone looking for failures looks. The timestamp is on the line prefix (lib/logger.ts), so the
 * `at` field it replaces is gone.
 */
function log(event: string, fields: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  const line = `[scorelo-audit] ${event} ${JSON.stringify(fields)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Where each step of reading the store sits on the job's 0–100 progress bar.
 *
 * The positions are a fixed scale — a bar needs one — weighted towards the steps that take the
 * time: reading products and loading storefront pages. What is NOT fixed is movement along it.
 * The bar only moves when the provider reports work that has actually happened, and within a step
 * only by a real fraction (products read of the count Shopify reported, pages loaded of pages
 * chosen). A step with no known total sits at its start until it finishes. The stage text beside
 * the bar carries the real counts, so nothing shown is estimated.
 */
const STEP_BANDS: Record<SnapshotStep, [number, number]> = {
  shop: [0, 2],
  products: [2, 40],
  collections: [40, 45],
  pages: [45, 48],
  articles: [48, 51],
  policies: [51, 52],
  theme: [52, 55],
  storefront: [55, 57],
  redirects: [57, 62],
  handles: [62, 67],
  crawl: [67, 88],
};
/** Running the checks, then saving. 100 is written only with status 'succeeded'. */
const CHECKS_BAND: [number, number] = [88, 96];
const SAVING_AT = 97;

/**
 * Writes the job's progress and stage, never moving the bar backwards and skipping writes that
 * would change nothing. Capped at 99: only a finished, saved audit is 100.
 */
function progressWriter(jobId: number) {
  let lastProgress = 0;
  let lastStage = '';
  return async (progress: number, stage: string) => {
    const value = Math.max(lastProgress, Math.min(99, Math.round(progress)));
    const text = stage.slice(0, 191);
    if (value === lastProgress && text === lastStage) return;
    lastProgress = value;
    lastStage = text;
    await db.update(jobs).set({ progress: value, stage: text }).where(eq(jobs.id, jobId));
  };
}

interface PillarOutcome {
  pillar: PillarKey;
  subPillarResults: SubPillarResult[];
  failedChecks: string[];
}

/**
 * Executes every registered check against one shared snapshot.
 *
 * Failure isolation (master prompt C5): a check that throws is recorded as an `unavailable`
 * result for its own sub-pillar and the run continues. One broken check can never discard an
 * entire audit, and its failure is surfaced honestly rather than scored as a zero.
 */
async function runChecks(
  snapshot: StoreSnapshot,
  jobId: number,
  checks: AuditCheck[],
  onProgress: (done: number, total: number) => Promise<void>,
): Promise<PillarOutcome[]> {
  const byPillar = new Map<PillarKey, PillarOutcome>();
  for (const pillar of PILLAR_ORDER) {
    byPillar.set(pillar, { pillar, subPillarResults: [], failedChecks: [] });
  }

  let done = 0;
  for (const check of checks) {
    const outcome = byPillar.get(check.pillar);
    if (!outcome) continue;

    try {
      outcome.subPillarResults.push(await check.execute(snapshot));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown check failure';
      log('audit.check_failed', { jobId, checkId: check.id, error: describeError(error) }, 'warn');
      outcome.failedChecks.push(check.id);
      outcome.subPillarResults.push(unavailableResult(check.subPillar, `This check could not complete: ${message}`));
    }

    done += 1;
    await onProgress(done, checks.length);
  }

  // Only pillars that actually produced results are persisted — an unimplemented pillar is
  // absent rather than present-with-a-zero, so the UI can show "not yet available".
  return [...byPillar.values()].filter((outcome) => outcome.subPillarResults.length > 0);
}

async function persistAudit(storeId: number, outcomes: PillarOutcome[], snapshot: StoreSnapshot, checkCount: number): Promise<number> {
  const pillarScores = outcomes.map((outcome) => scorePillar(outcome.subPillarResults));
  const overall = scoreOverall(pillarScores);

  // The new audit's id, found in SQL. Every score and finding row below is written in the SAME batch
  // as the audit row and refers to it through this: the newest audit of this store, which inside the
  // batch is the row its first statement just wrote. (A batch cannot hand one statement's result to
  // the next in code; and only one audit per store runs at a time — jobs_store_active_unique_idx.)
  const auditId = sql<number>`(SELECT MAX(${audits.id}) FROM ${audits} WHERE ${audits.storeId} = ${storeId})`;

  const scoreRows: SQLiteInsertValue<typeof auditScores>[] = [];
  const findingRows: SQLiteInsertValue<typeof findings>[] = [];

  for (const [index, outcome] of outcomes.entries()) {
    const pillarScore = pillarScores[index];
    const measured = outcome.subPillarResults.filter((result) => result.status === 'ok');

    scoreRows.push({
      auditId,
      pillar: outcome.pillar,
      subPillar: null,
      score: pillarScore ?? 0,
      checksTotal: measured.reduce((sum, result) => sum + result.analyzedCount, 0),
      checksPassed: measured.reduce((sum, result) => sum + result.healthyCount, 0),
      details: { status: pillarScore === null ? 'unavailable' : 'ok' },
    });

    for (const result of outcome.subPillarResults) {
      scoreRows.push({
        auditId,
        pillar: outcome.pillar,
        subPillar: result.subPillar,
        score: result.score,
        analyzedCount: result.analyzedCount,
        healthyCount: result.healthyCount,
        details: result.details,
      });

      for (const finding of result.findings) {
        findingRows.push({
          auditId,
          pillar: outcome.pillar,
          subPillar: result.subPillar,
          title: finding.title,
          severity: finding.severity,
          resolutionType: finding.resolutionType ?? null,
          affectedCount: finding.affectedCount,
          affectedLabel: finding.affectedLabel,
          // `impact` is not written: no check measures one. See the column in db/schema.ts.
          scoreLift: finding.scoreLift,
          why: finding.why,
          recommendation: finding.recommendation,
          problem: finding.problem,
          evidence: finding.evidence,
          evidenceRows: finding.evidenceRows ?? null,
          details: finding.details,
        });
      }
    }
  }

  // ONE BATCH — D1's transaction: the audit and everything in it are saved together, or nothing is,
  // so a half-written audit can never become the store's latest. Scores and findings go in groups
  // that stay within D1's 100-values-per-statement limit (db/limits.ts), measured from the real
  // statements, rather than one statement per row.
  const scoreGroups = groupForD1(scoreRows, (row) => db.insert(auditScores).values(row).toSQL().params.length);
  const findingGroups = groupForD1(findingRows, (row) => db.insert(findings).values(row).toSQL().params.length);

  const [inserted] = await db.batch([
    db
      .insert(audits)
      .values({
        storeId,
        // audits.overall_score is NOT NULL; when nothing was measurable we store 0 but record
        // overallAvailable:false so consumers can render "unavailable" instead of a fake zero.
        overallScore: overall ?? 0,
        source: 'engine',
        metadata: {
          overallAvailable: overall !== null,
          provider: 'shopify',
          shopDomain: snapshot.shop.domain,
          capturedAt: snapshot.capturedAt.toISOString(),
          coverage: snapshot.coverage,
          scope: snapshot.scope,
          resourceCounts: {
            products: snapshot.products.length,
            collections: snapshot.collections.length,
            pages: snapshot.pages.length,
            articles: snapshot.articles.length,
            policies: snapshot.policies.length,
          },
          // Analysed-vs-available, so a partially-scanned catalogue is never presented as a full
          // scan. `exact: false` means Shopify reported the total as AT_LEAST, not a firm number.
          // `available: null` means the total could not be read — which is "unknown", not "equal
          // to analysed", and the UI must not infer 100% coverage from it.
          coverageDetail: {
            products: {
              analyzed: snapshot.products.length,
              available: snapshot.scope.productsAvailable?.count ?? null,
              exact: snapshot.scope.productsAvailable?.exact ?? null,
              truncated: snapshot.scope.productsTruncated,
            },
            collections: {
              analyzed: snapshot.collections.length,
              available: snapshot.scope.collectionsAvailable?.count ?? null,
              exact: snapshot.scope.collectionsAvailable?.exact ?? null,
              truncated: snapshot.scope.collectionsTruncated,
            },
          },
          snapshotWarnings: snapshot.warnings,
          failedChecks: outcomes.flatMap((outcome) => outcome.failedChecks),
          checksRegistered: checkCount,
        },
      })
      .returning({ id: audits.id }),
    ...scoreGroups.map((group) => db.insert(auditScores).values(group)),
    ...findingGroups.map((group) => db.insert(findings).values(group)),
  ]);

  const audit = inserted[0];
  if (!audit) throw new Error('Failed to create audit record');
  return audit.id;
}

/**
 * Runs one audit job end to end and owns its lifecycle (running -> succeeded/failed).
 * Fire-and-forget from job.service.ts, so it must never throw: every exit path writes a
 * terminal job status, ensuring a job is never left stuck in `running`.
 */
export async function runAuditJob(jobId: number, deps: RunnerDeps = {}): Promise<void> {
  const checks = deps.checks ?? checkRegistry;
  const resolveProvider = deps.resolveProvider ?? resolveStoreDataProvider;

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return;

  try {
    await db.update(jobs).set({ status: 'running', startedAt: new Date(), progress: 0, stage: 'Starting' }).where(eq(jobs.id, jobId));
    const writeProgress = progressWriter(jobId);
    log('audit.started', { jobId, storeId: job.storeId });

    const [store] = await db.select().from(stores).where(eq(stores.id, job.storeId)).limit(1);
    if (!store) throw new Error('Store not found');

    // ── Prompt tracking sample ──
    // One assistant answer per tracked question, recorded BEFORE the snapshot is built so this
    // run's observation is included in what the checks read.
    //
    // WHY IT BELONGS IN THE AUDIT: a mention rate needs several real samples before it means
    // anything (see MIN_SAMPLES), and a merchant is not going to press a button five times.
    // Accruing one sample per audit is what turns the feature from a manual curiosity into a
    // trend, at a cost bounded by the tracked-question cap and the store's own audit frequency.
    //
    // It only ever runs when the merchant has added questions, so the cost is opted into by the
    // act of configuring it. Failure is swallowed into a warning: no assistant being reachable
    // must not cost the merchant their entire audit, and nothing is recorded for a failed call.
    let promptWarning: string | null = null;
    try {
      const sweep = await runPromptSweep(job.storeId);
      if (sweep.checked > 0 || sweep.failures.length > 0) {
        log('audit.prompt_sweep', { jobId, storeId: job.storeId, checked: sweep.checked, mentioned: sweep.mentioned, failed: sweep.failures.length });
      }
      if (sweep.failures.length > 0) {
        promptWarning = `prompt tracking: ${sweep.failures.length} question(s) could not be asked and were not recorded.`;
      }
    } catch (error) {
      // Thrown only when no AI provider is configured, which the check reports on its own.
      promptWarning = `prompt tracking: ${error instanceof Error ? error.message : 'the sweep did not run'}`;
    }

    // Fetch once, normalize once, reuse across every check (master prompt: PERFORMANCE).
    const provider = await resolveProvider(job.storeId);
    const snapshot = await provider.buildSnapshot(async (update: SnapshotProgress) => {
      const [start, end] = STEP_BANDS[update.step];
      await writeProgress(start + (end - start) * (update.fraction ?? 0), update.label);
    });
    // Surfaced in audit metadata beside every other non-fatal problem, rather than disappearing.
    if (promptWarning) snapshot.warnings.push(promptWarning);

    // The audit just read the shop's identity, so the workspace is kept current from it — never
    // overwriting a value the merchant edited. Best-effort: a failed write here must not cost the
    // merchant the audit they asked for.
    if (snapshot.shop.domain) {
      try {
        await applyShopifyFacts(job.storeId, factsFromShop({
          shopDomain: snapshot.shop.domain,
          name: snapshot.shop.name,
          primaryUrl: snapshot.shop.primaryUrl,
          country: snapshot.shop.country,
          currency: snapshot.shop.currency,
          timezone: snapshot.shop.timezone,
        }, snapshot.capturedAt));
      } catch (error) {
        log('audit.store_profile_failed', { jobId, storeId: job.storeId, error: describeError(error) }, 'warn');
      }
    }
    log('audit.snapshot_built', {
      jobId,
      storeId: job.storeId,
      products: snapshot.products.length,
      collections: snapshot.collections.length,
      pages: snapshot.pages.length,
      articles: snapshot.articles.length,
      warnings: snapshot.warnings.length,
    });

    const [checksStart, checksEnd] = CHECKS_BAND;
    const outcomes = await runChecks(snapshot, jobId, checks, async (done, total) => {
      await writeProgress(checksStart + (checksEnd - checksStart) * (total === 0 ? 1 : done / total), `Running checks — ${done} of ${total}`);
    });

    await writeProgress(SAVING_AT, 'Saving results');
    const auditId = await persistAudit(job.storeId, outcomes, snapshot, checks.length);
    await db.update(jobs).set({ status: 'succeeded', progress: 100, stage: 'Complete', auditId, finishedAt: new Date() }).where(eq(jobs.id, jobId));
    log('audit.completed', { jobId, storeId: job.storeId, auditId, pillars: outcomes.length });

    // An audit runs in the background and can take minutes; the merchant has usually navigated
    // away by the time it lands. Counts are taken from what was just persisted, so the message
    // states a real result rather than "an audit finished".
    //
    // notifyAuditOutcome keeps ONE live notice per kind: re-running an audit on an unchanged store
    // updates the unread notices already in the bell instead of stacking identical ones, and
    // critical issues are announced only when they are new since the previous audit.
    const allFindings = outcomes.flatMap((outcome) => outcome.subPillarResults.flatMap((result) => result.findings));
    const critical = outcomes.flatMap((outcome) =>
      outcome.subPillarResults.flatMap((result) =>
        result.findings
          .filter((finding) => finding.severity === 'critical')
          .map((finding) => ({ pillar: outcome.pillar, subPillar: result.subPillar, title: finding.title })),
      ),
    );

    await notifyAuditOutcome(job.storeId, {
      auditId,
      pillarCount: outcomes.length,
      findingCount: allFindings.length,
      critical,
    });

    // Compares this audit against the previous one and reports the largest pillar move. Gated by
    // `notifyScoreChanges`. Silent when no pillar moved, so an unchanged store adds nothing here.
    await notifyScoreMovement(job.storeId, auditId);
  } catch (error) {
    // "CODE: message" for a StoreDataError as before, and for a database failure the SQL and the
    // driver's reason rather than drizzle's message with every bound value in it.
    const message = describeError(error);
    await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId));
    log('audit.failed', { jobId, storeId: job.storeId, error: message }, 'error');

    // A failed audit is silent otherwise: the job row records it, and nothing surfaces that until
    // somebody wonders why their scores never updated. Two causes, two notices — a store-data
    // failure is a connection problem, anything else leaves the previous results standing. See
    // analysisFailedNotice for which type, wording and destination each one gets.
    await notifyAnalysisFailed(job.storeId, error instanceof StoreDataError ? 'store-data' : 'other');
  }
}
