import { env } from '../config/env.js';
import { describeError } from '../lib/logger.js';
import { runDueAutoAnalyses, type AutoAnalysisSweep } from './auto-analysis.service.js';
import { failStuckJobs } from './job.service.js';
import { failStuckLinkScans } from './link-scan.service.js';
import { runWeeklySummaries, type WeeklySummarySweep } from './weekly-summary.service.js';

/**
 * ─── The scheduled sweep (Cloudflare cron) ───────────────────────────
 *
 * On Node, two `setInterval` timers run the auto-analysis and weekly-summary sweeps, and interrupted
 * jobs are closed out once at start-up. A Worker has no long-lived process for any of that, so
 * Cloudflare calls this on a cron schedule instead (worker.ts `scheduled`, every 30 minutes — the
 * same interval the timers use).
 *
 * It calls the SAME sweep functions the timers call, so what is due, what is skipped and how a store
 * is analysed are decided in one place for both runtimes. The operator switches still apply:
 * AUTO_ANALYSIS_ENABLED=false and WEEKLY_SUMMARY_ENABLED=false stop their part here too.
 *
 * Order matters: stuck jobs are closed first, so a store whose last run died is free to be queued
 * again by the auto-analysis sweep in the same pass.
 */

export interface ScheduledWorkResult {
  /** Jobs closed out as stuck, or null if that sweep failed. */
  stuckJobsClosed: number | null;
  /** Null when switched off or when the sweep failed. */
  autoAnalysis: AutoAnalysisSweep | null;
  weeklySummary: WeeklySummarySweep | null;
  /** One line per part that threw. */
  failures: string[];
}

/** The three sweeps, injectable so tests can drive this without a database. */
export interface ScheduledWorkTasks {
  failStuckJobs: (now: Date) => Promise<number>;
  /** Optional so a test of the other sweeps need not supply it. */
  failStuckLinkScans?: (now: Date) => Promise<number>;
  runDueAutoAnalyses: (now: Date) => Promise<AutoAnalysisSweep>;
  runWeeklySummaries: (now: Date) => Promise<WeeklySummarySweep>;
}

const defaultTasks: ScheduledWorkTasks = { failStuckJobs, failStuckLinkScans, runDueAutoAnalyses, runWeeklySummaries };

/**
 * Runs every part, each on its own: one part failing is logged and the others still run.
 * NEVER THROWS — there is no caller to hand an error to, only the next tick.
 */
export async function runScheduledWork(now: Date = new Date(), tasks: ScheduledWorkTasks = defaultTasks): Promise<ScheduledWorkResult> {
  const result: ScheduledWorkResult = { stuckJobsClosed: null, autoAnalysis: null, weeklySummary: null, failures: [] };

  try {
    result.stuckJobsClosed = await tasks.failStuckJobs(now);
    if (result.stuckJobsClosed > 0) {
      console.warn(`[scorelo-cron] closed out ${result.stuckJobsClosed} stuck audit job(s)`);
    }
  } catch (error) {
    result.failures.push(`stuck jobs: ${describeError(error)}`);
  }

  try {
    const closed = (await tasks.failStuckLinkScans?.(now)) ?? 0;
    if (closed > 0) console.warn(`[scorelo-cron] closed out ${closed} stuck link scan(s)`);
  } catch (error) {
    result.failures.push(`stuck link scans: ${describeError(error)}`);
  }

  if (env.autoAnalysisEnabled) {
    try {
      result.autoAnalysis = await tasks.runDueAutoAnalyses(now);
      if (result.autoAnalysis.started > 0) {
        console.log(`[scorelo-cron] queued ${result.autoAnalysis.started} scheduled re-analysis run(s) across ${result.autoAnalysis.considered} store(s)`);
      }
    } catch (error) {
      result.failures.push(`auto-analysis: ${describeError(error)}`);
    }
  }

  if (env.weeklySummaryEnabled) {
    try {
      result.weeklySummary = await tasks.runWeeklySummaries(now);
      if (result.weeklySummary.written > 0) {
        console.log(`[scorelo-cron] wrote ${result.weeklySummary.written} weekly summary(ies) across ${result.weeklySummary.considered} store(s)`);
      }
    } catch (error) {
      result.failures.push(`weekly summary: ${describeError(error)}`);
    }
  }

  for (const failure of result.failures) console.warn(`[scorelo-cron] sweep failed — ${failure}`);
  return result;
}
