import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pageSettings } from '../db/schema.js';
import { insertReturning, updateReturning } from '../db/returning.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import {
  ALT_TEXT_CONTENT_TYPES,
  DEFAULT_ALT_TEXT_CONFIG,
  isAutoFormat,
  validateTypeConfig,
  type AltTextConfig,
  type AltTextContentType,
  type AltTextTypeConfig,
  type TemplateIssue,
} from '../lib/alt-text/template.js';

/**
 * ─── Image alt-text template configuration ───────────────────────────
 *
 * Persistence reuses `page_settings` — the same store-scoped JSON store every other sub-pillar
 * settings panel writes to — under its OWN slug. A separate slug rather than extra keys inside
 * `image-alt-text`, because that slug is owned by the sub-pillar settings drawer, whose save
 * REPLACES the whole `values` object; sharing it would mean either panel silently wiping the
 * other's configuration.
 *
 * No new table, no new migration: the requirement is a per-store JSON document keyed by a slug,
 * which is precisely what this table already is.
 *
 * NOTHING HERE TOUCHES SHOPIFY AT ALL. This file reads and writes one JSON document; the live
 * preview that used to make Shopify reads from it was removed -- see AltTextTemplateBuilder.tsx.
 */

export const ALT_TEXT_SETTINGS_SLUG = 'image-alt-text.template';

export interface AltTextConfigResponse {
  config: AltTextConfig;
  /** True when the store has no saved configuration yet and these are the defaults. */
  isDefault: boolean;
  updatedAt: string | null;
}

function coerceTypeConfig(raw: unknown, fallback: AltTextTypeConfig): AltTextTypeConfig {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const value = raw as Record<string, unknown>;
  return {
    template: typeof value.template === 'string' ? value.template : fallback.template,
    characterLimit: Number.isInteger(value.characterLimit) ? (value.characterLimit as number) : fallback.characterLimit,
    autoFormat: isAutoFormat(value.autoFormat) ? value.autoFormat : fallback.autoFormat,
    skipExisting: typeof value.skipExisting === 'boolean' ? value.skipExisting : fallback.skipExisting,
    removeDuplicateWords: typeof value.removeDuplicateWords === 'boolean' ? value.removeDuplicateWords : fallback.removeDuplicateWords,
    autoGenerate: typeof value.autoGenerate === 'boolean' ? value.autoGenerate : fallback.autoGenerate,
  };
}

/** Stored JSON merged over the defaults, so a config written before a field existed still loads. */
function coerceConfig(raw: unknown): AltTextConfig {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    products: coerceTypeConfig(stored.products, DEFAULT_ALT_TEXT_CONFIG.products),
    articles: coerceTypeConfig(stored.articles, DEFAULT_ALT_TEXT_CONFIG.articles),
  };
}

export async function getAltTextConfig(userId: number, storeId?: number): Promise<AltTextConfigResponse> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);

  const [row] = await db
    .select()
    .from(pageSettings)
    .where(and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, ALT_TEXT_SETTINGS_SLUG)))
    .limit(1);

  if (!row) return { config: DEFAULT_ALT_TEXT_CONFIG, isDefault: true, updatedAt: null };

  return {
    config: coerceConfig(row.values),
    isDefault: false,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export interface AltTextValidationError {
  contentType: AltTextContentType;
  issues: TemplateIssue[];
}

/** Server-side validation. The browser validates too, for immediacy — but this is the boundary. */
function validateConfig(config: AltTextConfig): AltTextValidationError[] {
  const errors: AltTextValidationError[] = [];
  for (const contentType of ALT_TEXT_CONTENT_TYPES) {
    const issues = validateTypeConfig(contentType, config[contentType]);
    if (issues.length > 0) errors.push({ contentType, issues });
  }
  return errors;
}

/**
 * Saves the whole configuration.
 *
 * Every content type is written together and each one is validated, so a valid Products template
 * can never be persisted alongside an Articles template that would fail — and changing one content
 * type leaves the others exactly as they were, because the caller sends the merged document it
 * loaded.
 */
export async function saveAltTextConfig(userId: number, raw: unknown, storeId?: number): Promise<AltTextConfigResponse> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const config = coerceConfig(raw);

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ApiError(
      422,
      errors[0]!.issues[0]!.message,
      'ALT_TEXT_CONFIG_INVALID',
    );
  }

  const [existing] = await db
    .select({ id: pageSettings.id })
    .from(pageSettings)
    .where(and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, ALT_TEXT_SETTINGS_SLUG)))
    .limit(1);

  const updatedAt = new Date();

  if (existing) {
    const [updated] = await updateReturning(
      pageSettings,
      { values: config, updatedAt },
      and(eq(pageSettings.storeId, resolvedStoreId), eq(pageSettings.slug, ALT_TEXT_SETTINGS_SLUG)),
    );
    if (!updated) throw new ApiError(500, 'Unable to save alt-text settings', 'ALT_TEXT_CONFIG_SAVE_FAILED');
    return { config: coerceConfig(updated.values), isDefault: false, updatedAt: updatedAt.toISOString() };
  }

  const created = await insertReturning(pageSettings, {
    storeId: resolvedStoreId,
    slug: ALT_TEXT_SETTINGS_SLUG,
    values: config,
    updatedAt,
  });
  if (!created) throw new ApiError(500, 'Unable to save alt-text settings', 'ALT_TEXT_CONFIG_SAVE_FAILED');

  return { config: coerceConfig(created.values), isDefault: false, updatedAt: updatedAt.toISOString() };
}
