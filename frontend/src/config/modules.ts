/**
 * ─── Module visibility — the ONE switch for what a customer can see ──────────────────────────
 *
 * A module marked `false` here is hidden from the customer-facing app: its navigation, pages,
 * scores, issues, recommendations, filters, report rows, notifications, onboarding options and every
 * piece of text that names it. It is HIDDEN, not locked or greyed out — to a customer the product
 * simply has no such module.
 *
 * Nothing is deleted. The module's pages, components, catalogs, API clients and the backend that
 * measures it all stay in place, and the backend keeps measuring it and storing its results. Only
 * what reaches the customer's screen is filtered, and every filter reads the answer from here:
 *
 *   to HIDE CRO:  cro: false      (current)
 *   to SHOW CRO:  cro: true       — the existing CRO pages, scores and findings come back as they were
 *
 * Nowhere else in the app decides this. Code that lists pillars goes through `data/pillarMeta.ts`
 * (`pillarOrder`, `pillarList`), code that receives rows tagged with a pillar goes through
 * `isPillarVisible`, and code that writes the pillar names into a sentence builds them from
 * `pillarList` and `joinNames`.
 */

export type ModuleKey = 'cro';

export const MODULE_VISIBILITY: Record<ModuleKey, boolean> = {
  cro: false,
};

/** Whether the customer may see this pillar. Anything not listed in MODULE_VISIBILITY is visible. */
export function isPillarVisible(pillar: string): boolean {
  return MODULE_VISIBILITY[pillar as ModuleKey] ?? true;
}

/** The pillars switched off, so a caller can scope a query or a filter to everything else. */
export function hiddenPillarKeys(): ModuleKey[] {
  return (Object.keys(MODULE_VISIBILITY) as ModuleKey[]).filter((key) => !MODULE_VISIBILITY[key]);
}

/**
 * The guided-setup goals that exist for one module and for nothing else. The goal's wording is the
 * server's (it is stored and validated there), so it is named here, against the module it belongs
 * to, to be left out of the choices while that module is hidden.
 */
const MODULE_GOALS: Record<ModuleKey, string[]> = {
  cro: ['Improve conversion rate'],
};

/** Whether a setup goal may be offered to the customer. */
export function isGoalVisible(goal: string): boolean {
  return (Object.keys(MODULE_GOALS) as ModuleKey[]).every((key) => MODULE_VISIBILITY[key] || !MODULE_GOALS[key].includes(goal));
}

/** Whether a check, written "pillar/sub-pillar" ("cro/options"), belongs to a visible pillar. */
export function isCheckVisible(checkKey: string): boolean {
  return isPillarVisible(checkKey.split('/')[0]);
}

/** Rows that carry a `pillar` field, with the hidden pillars' rows left out. */
export function visiblePillarRows<T extends { pillar: string }>(rows: T[]): T[] {
  return rows.filter((row) => isPillarVisible(row.pillar));
}

/** A list of names — "SEO, Content, Speed and AI Discovery" — with the hidden pillars left out. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
