import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pageSettings } from '../db/schema.js';

/**
 * ─── Setup answers that have no column of their own ──────────────────
 *
 * Four answers guided setup collects are stored here rather than on `onboarding_state`: the
 * content language, the products and collections to treat as priorities, the paths Rankvora AI must
 * leave alone, and the hour of day a scheduled analysis may start.
 *
 * WHY HERE. `page_settings` is the per-store, slug-keyed JSON settings table this product already
 * uses for exactly this purpose — the image alt-text template lives in it under its own slug
 * (services/altText.service.ts) rather than in columns of its own. One row per store, cascade
 * deleted with the store, and no migration to deploy. It follows that precedent rather than
 * inventing a second mechanism, and nothing here is written into a column whose name says
 * something else.
 *
 * EVERY READ IS NARROWED, NEVER CAST. The column is `json`, so the driver hands back `unknown`, and
 * a row written by an older build (or by hand) could hold anything. A value that is not the shape
 * expected is treated as absent — the merchant is shown "not set" and asked, which is honest —
 * rather than coerced into something that would quietly become an audit input.
 */

/** The one slug these answers live under. Namespaced, so it cannot collide with a sub-pillar page. */
export const ONBOARDING_PREFERENCES_SLUG = 'onboarding/preferences';

/** A product or collection the merchant marked as a priority, named as their own store names it. */
export interface PriorityResource {
  kind: 'product' | 'collection';
  /** The storefront handle — stable, and what the catalogue pages already key on. */
  handle: string;
  /** The title as it was when chosen, so the list reads as the merchant's own catalogue. */
  title: string;
}

export interface OnboardingPreferences {
  /** The language drafts are written in and content is judged against. A Shopify locale code. */
  contentLanguage: string | null;
  /** Up to PRIORITY_RESOURCE_LIMIT products/collections to weight ahead of the rest. */
  priorityResources: PriorityResource[];
  /** Storefront paths Rankvora AI must never propose or apply a change to. */
  protectedPaths: string[];
  /** Local hour (0–23, the store's own timezone) a scheduled analysis may start in. */
  preferredScanHour: number | null;
}

export const PRIORITY_RESOURCE_LIMIT = 20;
export const PROTECTED_PATH_LIMIT = 20;

/** What a store that has answered none of these has. Never a guess — all four are genuinely unset. */
export const EMPTY_ONBOARDING_PREFERENCES: OnboardingPreferences = {
  contentLanguage: null,
  priorityResources: [],
  protectedPaths: [],
  preferredScanHour: null,
};

function asString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function asStringList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry, itemMax);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function asPriorityResources(value: unknown): PriorityResource[] {
  if (!Array.isArray(value)) return [];
  const out: PriorityResource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const kind = row.kind === 'product' || row.kind === 'collection' ? row.kind : null;
    const handle = asString(row.handle, 255);
    if (!kind || !handle) continue;
    if (out.some((existing) => existing.kind === kind && existing.handle === handle)) continue;
    // A missing title is not fatal: the handle identifies the resource, and the UI shows the handle
    // rather than inventing a name for it.
    out.push({ kind, handle, title: asString(row.title, 255) ?? handle });
    if (out.length >= PRIORITY_RESOURCE_LIMIT) break;
  }
  return out;
}

function asHour(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 0 && value <= 23 ? value : null;
}

/** Narrows whatever the column holds into the shape above. */
export function parseOnboardingPreferences(raw: unknown): OnboardingPreferences {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ONBOARDING_PREFERENCES };
  const values = raw as Record<string, unknown>;
  return {
    contentLanguage: asString(values.contentLanguage, 35),
    priorityResources: asPriorityResources(values.priorityResources),
    protectedPaths: asStringList(values.protectedPaths, PROTECTED_PATH_LIMIT, 512),
    preferredScanHour: asHour(values.preferredScanHour),
  };
}

/** This store's answers. Never throws, and never reports a value the row does not hold. */
export async function readOnboardingPreferences(storeId: number): Promise<OnboardingPreferences> {
  const [row] = await db
    .select({ values: pageSettings.values })
    .from(pageSettings)
    .where(and(eq(pageSettings.storeId, storeId), eq(pageSettings.slug, ONBOARDING_PREFERENCES_SLUG)))
    .limit(1);
  return parseOnboardingPreferences(row?.values);
}

/**
 * Saves the answers in `patch`, leaving the others as they are.
 *
 * A key that is absent from `patch` is untouched; a key present as null (or an empty list) is
 * cleared. That is the same distinction the step endpoint draws everywhere else — "did not touch
 * it" and "cleared it" are different answers, and collapsing them would make clearing impossible.
 */
export async function writeOnboardingPreferences(
  storeId: number,
  patch: Partial<OnboardingPreferences>,
): Promise<OnboardingPreferences> {
  const current = await readOnboardingPreferences(storeId);
  const next = parseOnboardingPreferences({ ...current, ...patch });

  await db
    .insert(pageSettings)
    .values({ storeId, slug: ONBOARDING_PREFERENCES_SLUG, values: next, updatedAt: new Date() })
    // page_settings_store_slug_idx is unique on (store_id, slug), so this is an upsert on the one
    // row this store owns — no read-then-write race that could drop a concurrent answer.
    .onConflictDoUpdate({ target: [pageSettings.storeId, pageSettings.slug], set: { values: next, updatedAt: new Date() } });

  return next;
}

/**
 * Whether a storefront path is one the merchant protected.
 *
 * Matched as a path PREFIX on segment boundaries: "/collections/sale" covers
 * "/collections/sale/products/x" but not "/collections/sale-ends". A bare "*" is not supported and
 * is not needed — a prefix already covers a section of the store, and glob semantics nobody
 * documented would be a rule the merchant could not predict.
 */
/** The protected path that covers `path`, or null. Returned so a refusal can name the rule. */
export function findProtectedRule(protectedPaths: string[], path: string): string | null {
  const target = normalisePath(path);
  if (!target) return null;
  for (const raw of protectedPaths) {
    const prefix = normalisePath(raw);
    if (!prefix) continue;
    // "/" protects the whole store; any other rule covers itself and everything beneath it.
    if (prefix === '/' || target === prefix || target.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/** Lower-cased, leading slash, no trailing slash, query and fragment dropped. */
export function normalisePath(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  // A pasted full URL is a reasonable thing to type into a path field.
  const withoutOrigin = text.replace(/^https?:\/\/[^/]+/, '');
  const path = withoutOrigin.split('?')[0]?.split('#')[0] ?? '';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return trimmed === '/' ? '/' : trimmed || null;
}
