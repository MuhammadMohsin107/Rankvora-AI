import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schemaTemplates } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { getCurrentStoreId } from './store.service.js';
import { resolveStoreDataProvider } from '../audit-engine/store-data/index.js';
import { ShopifyStoreDataProvider } from '../audit-engine/store-data/shopify.provider.js';
import { SCHEMA_LIBRARY, defaultTemplateFor, findSchemaType } from '../schema-engine/library.js';
import { fieldsForContext, type ResolutionContext } from '../schema-engine/fields.js';
import { resolveTemplate } from '../schema-engine/resolver.js';
import { validateSchema } from '../schema-engine/validator.js';
import type { SchemaContextKind, SchemaTemplate, ValueSource } from '../schema-engine/types.js';
import type { UpsertSchemaTemplateInput } from '../schemas/schemaTemplate.schema.js';

/**
 * ─── Schema templates: storage, preview, validation ──────────────────
 *
 * The seam between the stored configuration and the engine. It holds no schema knowledge of its
 * own — types come from the library, values from the resolver, verdicts from the validator — so
 * there is exactly one place that knows how a template becomes JSON-LD.
 */

/** What the settings page needs to render the picker for one context. */
export function getSchemaCatalog(context?: SchemaContextKind) {
  const types = SCHEMA_LIBRARY
    .filter((definition) => !context || definition.contexts.includes(context))
    .map((definition) => ({
      type: definition.type,
      category: definition.category,
      description: definition.description,
      contexts: definition.contexts,
      builtIn: definition.builtIn,
      googleDocs: definition.googleDocs ?? null,
      properties: definition.properties.map((property) => ({
        name: property.name,
        expects: property.expects,
        requirement: property.requirement,
        description: property.description,
        defaultSource: property.defaultSource ?? null,
      })),
    }));

  return {
    types,
    // The field picker's options, with the same labels the resolver reads by.
    fields: (context ? fieldsForContext(context) : []).map((field) => ({
      path: field.path,
      label: field.label,
      description: field.description ?? null,
    })),
  };
}

function toTemplate(row: typeof schemaTemplates.$inferSelect): SchemaTemplate {
  return {
    type: row.schemaType,
    context: row.context as SchemaContextKind,
    enabled: row.enabled,
    properties: (row.properties ?? {}) as Record<string, ValueSource>,
  };
}

/** Every template the store has configured, whether or not it is switched on. */
export async function listSchemaTemplates(userId: number, storeId?: number): Promise<SchemaTemplate[]> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const rows = await db
    .select()
    .from(schemaTemplates)
    .where(eq(schemaTemplates.storeId, resolvedStoreId))
    .orderBy(asc(schemaTemplates.schemaType));
  return rows.map(toTemplate);
}

/**
 * One template, falling back to the library's preconfigured defaults.
 *
 * A type the merchant has never opened returns its default mapping rather than an empty object, so
 * the settings page shows what enabling it WOULD produce instead of a blank form they must fill in
 * before they can see anything.
 */
export async function getSchemaTemplate(
  userId: number,
  type: string,
  context: SchemaContextKind,
  storeId?: number,
): Promise<SchemaTemplate> {
  const definition = findSchemaType(type);
  if (!definition) throw new ApiError(404, `Rankvora AI has no definition for ${type}`, 'SCHEMA_TYPE_NOT_FOUND');
  if (!definition.contexts.includes(context)) {
    throw new ApiError(400, `${type} cannot be rendered on a ${context}`, 'SCHEMA_CONTEXT_INVALID');
  }

  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const [row] = await db
    .select()
    .from(schemaTemplates)
    .where(and(
      eq(schemaTemplates.storeId, resolvedStoreId),
      eq(schemaTemplates.schemaType, type),
      eq(schemaTemplates.context, context),
    ))
    .limit(1);

  if (row) return toTemplate(row);
  return defaultTemplateFor(type, context) as SchemaTemplate;
}

export async function saveSchemaTemplate(
  userId: number,
  type: string,
  context: SchemaContextKind,
  input: UpsertSchemaTemplateInput,
  storeId?: number,
): Promise<SchemaTemplate> {
  const definition = findSchemaType(type);
  if (!definition) throw new ApiError(404, `Rankvora AI has no definition for ${type}`, 'SCHEMA_TYPE_NOT_FOUND');
  if (!definition.contexts.includes(context)) {
    throw new ApiError(400, `${type} cannot be rendered on a ${context}`, 'SCHEMA_CONTEXT_INVALID');
  }

  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const properties = input.properties as Record<string, ValueSource>;

  await db
    .insert(schemaTemplates)
    .values({ storeId: resolvedStoreId, schemaType: type, context, enabled: input.enabled, properties })
    .onConflictDoUpdate({ target: [schemaTemplates.storeId, schemaTemplates.schemaType, schemaTemplates.context], set: { enabled: input.enabled, properties, updatedAt: new Date() } });

  return { type, context, enabled: input.enabled, properties };
}

/**
 * ─── Preview against the merchant's real store ───────────────────────
 *
 * Reads ONE real record of the requested kind and renders the template against it.
 *
 * It is a real Shopify read, not a stored sample and not an example product: the only question
 * worth answering here is "what will this produce for MY catalogue?", and a fabricated record
 * would answer a different one — convincingly, and wrongly. The provider's `sampleRecords` reads a
 * single record through the same code path an audit uses, so a preview cannot diverge from what
 * publishing would later generate.
 */
export interface SchemaPreview {
  /** The record the preview was rendered against, so the merchant can see which one it is. */
  sample: { kind: SchemaContextKind; title: string; url: string | null } | null;
  jsonLd: Record<string, unknown> | null;
  omissions: Array<{ property: string; reason: string; detail: string }>;
  validation: ReturnType<typeof validateSchema>;
}

async function buildPreviewContext(storeId: number, context: SchemaContextKind): Promise<ResolutionContext | null> {
  const provider = await resolveStoreDataProvider(storeId);
  // The sample read lives on the Shopify provider. Another platform would supply its own, and
  // until one exists this says so rather than pretending the capability is generic.
  if (!(provider instanceof ShopifyStoreDataProvider)) return null;

  const sample = await provider.sampleRecords();
  const base = { kind: context, shop: sample.shop };

  switch (context) {
    case 'product':
      return sample.products[0] ? { ...base, product: sample.products[0] } : null;
    case 'collection':
      return sample.collections[0] ? { ...base, collection: sample.collections[0] } : null;
    case 'page':
      return sample.pages[0] ? { ...base, page: sample.pages[0] } : null;
    case 'article':
      return sample.articles[0] ? { ...base, article: sample.articles[0] } : null;
    case 'shop':
      return base;
    default:
      return null;
  }
}

function describeSample(context: ResolutionContext): SchemaPreview['sample'] {
  switch (context.kind) {
    case 'product':
      return { kind: 'product', title: context.product?.title ?? '', url: context.product?.url ?? null };
    case 'collection':
      return { kind: 'collection', title: context.collection?.title ?? '', url: context.collection?.url ?? null };
    case 'page':
      return { kind: 'page', title: context.page?.title ?? '', url: context.page?.url ?? null };
    case 'article':
      return { kind: 'article', title: context.article?.title ?? '', url: context.article?.url ?? null };
    case 'shop':
      return { kind: 'shop', title: context.shop.name, url: context.shop.primaryUrl };
    default:
      return null;
  }
}

export async function previewSchemaTemplate(
  userId: number,
  type: string,
  context: SchemaContextKind,
  /** The unsaved template from the editor, so a merchant sees the effect before committing. Falls
   * back to what is stored when absent. */
  draft: UpsertSchemaTemplateInput | undefined,
  storeId?: number,
): Promise<SchemaPreview> {
  const resolvedStoreId = await getCurrentStoreId(userId, storeId);
  const template: SchemaTemplate = draft
    ? { type, context, enabled: draft.enabled, properties: draft.properties as Record<string, ValueSource> }
    : await getSchemaTemplate(userId, type, context, storeId);

  const resolutionContext = await buildPreviewContext(resolvedStoreId, context);
  if (!resolutionContext) {
    throw new ApiError(
      400,
      `This store has no ${context} Rankvora AI could read, so there is nothing to preview this template against.`,
      'SCHEMA_PREVIEW_NO_SAMPLE',
    );
  }

  const { jsonLd, omissions } = resolveTemplate(template, resolutionContext);
  return {
    sample: describeSample(resolutionContext),
    jsonLd,
    omissions,
    validation: validateSchema(jsonLd),
  };
}
