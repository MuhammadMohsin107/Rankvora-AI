// ─── Row status vocabulary ───────────────────────────────────────────
// The CRO and AI Discovery evidence tables both declare the same three statuses and filter
// buttons (croTables.ts / aiTables.ts: filters ['All', 'Critical', 'Needs Work', 'Healthy']).
// A check emitting anything else produces rows that no filter can select and that render with
// no status colour, so the vocabulary lives here rather than being retyped in five files.

export const HEALTHY = 'Healthy';
export const NEEDS_WORK = 'Needs Work';
export const CRITICAL = 'Critical';

export type RowStatus = typeof HEALTHY | typeof NEEDS_WORK | typeof CRITICAL;

/** Percentage of a whole, rounded, with the 0-of-0 case defined as 100 rather than NaN. */
export function coveragePct(part: number, whole: number): number {
  if (whole <= 0) return 100;
  return Math.round((part / whole) * 100);
}

/** Shopify gives every single-variant product one synthetic option named `Title` whose only
 * value is `Default Title`. It is not something the merchant configured, and treating it as a
 * real option would report every simple product as having a one-value dropdown. */
export function isDefaultOption(option: { name: string; values: string[] }): boolean {
  return option.name.trim().toLowerCase() === 'title'
    && option.values.length <= 1
    && (option.values[0] ?? '').trim().toLowerCase() === 'default title';
}
