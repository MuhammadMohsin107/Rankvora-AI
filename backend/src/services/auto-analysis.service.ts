import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { audits, stores } from '../db/schema.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { createAuditJob } from './job.service.js';
import { hasStoreDataSource } from '../audit-engine/store-data/index.js';
import { describeError } from '../lib/logger.js';
import { FREQUENCY_DAYS, isAnalysisDue, type ScanWindow } from '../lib/analysisSchedule.js';
import { readOnboardingPreferences } from './onboarding-preferences.service.js';

/**
 * Re-exported so the sweep and everything that reports a schedule share ONE rule. The arithmetic
 * itself lives in lib/analysisSchedule.ts, which has no database of its own — the setup snapshot
 * and the dashboard both need the same answer, and a second copy would be a second schedule.
 */
export { FREQUENCY_DAYS, isAnalysisDue, nextScheduledScanAt, type ScanWindow } from '../lib/analysisSchedule.js';

/**
 * ─── Scheduled re-analysis ───────────────────────────────────────────
 *
 * Runs a store's audit again once its chosen interval has elapsed.
 *
 * THE SETTING ALREADY EXISTED. `stores.auto_analysis` and `stores.analysis_frequency` have been
 * columns since the schema was written, Settings → Analysis has offered the toggle and the
 * frequency dropdown the whole time, and the API has persisted both. Nothing anywhere read them:
 * there was no scheduler, no cron and no interval in the process, so the switch did nothing in
 * either position and "Weekly" described an analysis that never happened. This is what makes it a
 * setting rather than decoration.
 *
 * DUE-NESS IS DERIVED, NOT TRACKED. There is no "last auto-run" column and none is needed — the
 * newest `audits.runAt` for the store IS when it was last analysed, whoever triggered it. So a
 * merchant who presses Refresh on Monday does not also get an automatic run on Tuesday; the clock
 * restarts from the real analysis, not from a separate schedule ticking alongside it.
 *
 * IT REUSES createAuditJob RATHER THAN RUNNING AUDITS ITSELF. That one function already refuses a
 * store with no live Shopify connection, already refuses a second concurrent run, and is already
 * backed by a partial unique index that makes "at most one active job per store" atomic. A
 * scheduler with its own copy of those rules would be a second place for them to drift — and the
 * index means that even two schedulers (a future cluster deployment) cannot double-run a store.
 * Its `userId` argument is the tenancy seam, so the store's own owner is passed: the scheduler
 * gets exactly the access that merchant has, and no more.
 */

export interface AutoAnalysisSweep {
  /** Stores with auto-analysis switched on. */
  considered: number;
  /** Runs actually queued this sweep. */
  started: number;
  /** Due, but skipped — no connection, a run already in flight, or the per-sweep cap. */
  skipped: number;
}

/**
 * Queues a run for every store whose interval has elapsed.
 *
 * NEVER THROWS. It is called from a timer with no caller to return an error to, and one store's
 * problem must not stop the rest of the sweep or kill the interval.
 */
export async function runDueAutoAnalyses(now: Date = new Date()): Promise<AutoAnalysisSweep> {
  const sweep: AutoAnalysisSweep = { considered: 0, started: 0, skipped: 0 };

  let candidates: Array<typeof stores.$inferSelect>;
  try {
    candidates = await db.select().from(stores).where(eq(stores.autoAnalysis, true));
  } catch (error) {
    console.warn(`[scorelo-auto] could not read stores: ${describeError(error)}`);
    return sweep;
  }

  sweep.considered = candidates.length;

  for (const store of candidates) {
    try {
      if (!FREQUENCY_DAYS[store.analysisFrequency]) {
        console.warn(`[scorelo-auto] store ${store.id} has an unknown analysis frequency "${store.analysisFrequency}" — skipped`);
        sweep.skipped += 1;
        continue;
      }

      // Checked before reading audits: a disconnected store can never produce one, and asking
      // would only queue a job the worker is guaranteed to fail.
      if (!(await hasStoreDataSource(store.id))) {
        sweep.skipped += 1;
        continue;
      }

      // 'engine' only. A seeded development fixture is not an analysis of this store, and letting
      // one count would hold off the real audit the merchant is waiting for.
      const [latest] = await db
        .select({ runAt: audits.runAt })
        .from(audits)
        .where(and(eq(audits.storeId, store.id), eq(audits.source, 'engine')))
        .orderBy(desc(audits.runAt))
        .limit(1);

      /**
       * The merchant's chosen scan hour, in their store's own timezone.
       *
       * Read per store rather than joined, because it lives in the per-store settings row
       * (services/onboarding-preferences.service.ts) — one small indexed read per candidate, and
       * only for stores that already have scheduling switched on. A store that chose no hour gets
       * exactly the behaviour it had before: due is due.
       */
      const preferences = await readOnboardingPreferences(store.id);
      const window: ScanWindow = {
        // 'Unspecified' is what the schema holds when Shopify never reported a zone; UTC is then
        // the honest basis rather than the server's own local time.
        timeZone: store.timezone && store.timezone !== 'Unspecified' ? store.timezone : null,
        preferredHour: preferences.preferredScanHour,
      };

      if (!isAnalysisDue(latest?.runAt ?? null, store.analysisFrequency, now, window)) continue;

      // Counted only against stores that are actually DUE, so the cap throttles real work rather
      // than being spent on stores that needed nothing. Whatever it defers stays due and is
      // picked up by the next sweep.
      if (sweep.started >= env.autoAnalysisMaxPerSweep) {
        sweep.skipped += 1;
        continue;
      }

      await createAuditJob(store.ownerId, store.id);
      sweep.started += 1;
      console.log(
        `[scorelo-auto] queued ${store.analysisFrequency.toLowerCase()} re-analysis for store ${store.id} `
        + `(last analysed ${latest ? latest.runAt.toISOString() : 'never'}`
        + `${window.preferredHour !== null ? `, preferred hour ${window.preferredHour} ${window.timeZone ?? 'UTC'}` : ''})`,
      );
    } catch (error) {
      // AUDIT_RUN_IN_PROGRESS is the expected case when a merchant pressed Refresh moments ago,
      // or a previous sweep's run is still going. Not a fault, and not worth a warning.
      if (error instanceof ApiError && error.code === 'AUDIT_RUN_IN_PROGRESS') {
        sweep.skipped += 1;
        continue;
      }
      sweep.skipped += 1;
      console.warn(`[scorelo-auto] store ${store.id} skipped: ${describeError(error)}`);
    }
  }

  return sweep;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the sweep timer. Safe to call once at boot; calling it twice is a no-op.
 *
 * The first sweep is deliberately delayed rather than run at startup. A deploy restarts the
 * process, and a restart is not a reason to analyse every store — without the delay, redeploying
 * three times in an afternoon would trigger three rounds of audits.
 */
export function startAutoAnalysisScheduler(): void {
  if (!env.autoAnalysisEnabled) {
    console.log('[scorelo-auto] scheduled re-analysis is disabled (AUTO_ANALYSIS_ENABLED=false)');
    return;
  }
  if (timer) return;

  const sweep = () => {
    void runDueAutoAnalyses()
      .then((result) => {
        // Logged only when it did something. A quiet scheduler should be quiet in the logs.
        if (result.started > 0) {
          console.log(`[scorelo-auto] sweep queued ${result.started} run(s) across ${result.considered} store(s)`);
        }
      })
      .catch((error) => console.warn(`[scorelo-auto] sweep failed: ${describeError(error)}`));
  };

  setTimeout(sweep, env.autoAnalysisStartDelayMs);
  timer = setInterval(sweep, env.autoAnalysisIntervalMs);
  // Never hold the process open for a timer. Without this a shutdown waits on the next sweep.
  timer.unref();

  console.log(
    `[scorelo-auto] scheduled re-analysis active — sweeping every ${Math.round(env.autoAnalysisIntervalMs / 60_000)} min, `
    + `max ${env.autoAnalysisMaxPerSweep} run(s) per sweep`,
  );
}
