/**
 * ─── The five stages of an analysis, as the merchant reads them ──────
 *
 * The audit job reports a single 0-100 progress and a stage sentence with the real counts so far
 * ("Reading products — 1,250 of 6,762"). This groups that bar into the five stages a merchant can
 * follow, so a long first analysis reads as five things happening rather than one number climbing.
 *
 * THE BOUNDARIES ARE THE RUNNER'S OWN. They mirror STEP_BANDS and CHECKS_BAND in
 * backend/src/audit-engine/runner.ts — the bar's position for each step of reading the store — so a
 * stage lights up exactly when the work it names is the work being done:
 *
 *   0-52    reading the shop, products, collections, pages, articles and policies   → Reading catalog
 *   52-67   theme, storefront probe, redirects and handles                           → Discovering URLs
 *   67-88   crawling storefront pages                                                → Analyzing pages
 *   88-96   running the checks, which is where connected sources are read            → Collecting measurements
 *   96-100  saving the results                                                       → Preparing findings
 *
 * Nothing here is estimated. A stage is complete when the bar has passed it and active while the bar
 * is inside it; the sentence beside it is the job's own.
 */

export interface AnalysisStage {
  key: string;
  label: string;
  /** The progress value at which this stage starts and ends. */
  from: number;
  to: number;
}

export const ANALYSIS_STAGES: AnalysisStage[] = [
  { key: 'catalog', label: 'Reading catalog', from: 0, to: 52 },
  { key: 'urls', label: 'Discovering URLs', from: 52, to: 67 },
  { key: 'pages', label: 'Analyzing pages', from: 67, to: 88 },
  { key: 'measurements', label: 'Collecting available measurements', from: 88, to: 96 },
  { key: 'findings', label: 'Preparing findings', from: 96, to: 100 },
];

export type StageState = 'done' | 'active' | 'waiting';

/** Where each stage stands at a given progress. */
export function stageStates(progress: number): Array<AnalysisStage & { state: StageState }> {
  const value = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  return ANALYSIS_STAGES.map((stage) => ({
    ...stage,
    state: value >= stage.to ? 'done' : value >= stage.from ? 'active' : 'waiting',
  }));
}
