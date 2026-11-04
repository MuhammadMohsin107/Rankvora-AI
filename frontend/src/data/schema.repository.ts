import { api } from '../lib/api';

/**
 * ─── Schema / JSON-LD settings ───────────────────────────────────────
 *
 * Talks to /api/schema, which is the SETTINGS side of structured data: what Rankvora AI would
 * generate from the store's own Shopify records. The schema AUDIT — what the storefront already
 * renders — is a different endpoint and is unchanged.
 */

export type SchemaContextKind = 'product' | 'collection' | 'page' | 'article' | 'shop';

export type ValueSource =
  | { kind: 'none' }
  | { kind: 'shopify'; path: string }
  | { kind: 'metafield'; namespace: string; key: string }
  | { kind: 'static'; value: string | number | boolean }
  | { kind: 'object'; type: string; properties: Record<string, ValueSource> }
  | { kind: 'array'; items: ValueSource[] };

export type PropertyRequirement = 'required' | 'recommended' | 'optional';

export interface SchemaPropertyDefinition {
  name: string;
  expects: string;
  requirement: PropertyRequirement;
  description: string;
  defaultSource: ValueSource | null;
}

export interface SchemaTypeDefinition {
  type: string;
  category: string;
  description: string;
  contexts: SchemaContextKind[];
  builtIn: boolean;
  googleDocs: string | null;
  properties: SchemaPropertyDefinition[];
}

export interface ShopifyFieldOption {
  path: string;
  label: string;
  description: string | null;
}

export interface SchemaCatalog {
  types: SchemaTypeDefinition[];
  fields: ShopifyFieldOption[];
}

export interface SchemaTemplate {
  type: string;
  context: SchemaContextKind;
  enabled: boolean;
  properties: Record<string, ValueSource>;
}

export interface SchemaPreview {
  sample: { kind: SchemaContextKind; title: string; url: string | null } | null;
  jsonLd: Record<string, unknown> | null;
  omissions: Array<{ property: string; reason: string; detail: string }>;
  validation: { valid: boolean; issues: Array<{ property: string; severity: 'error' | 'warning'; message: string }> };
}

export function fetchSchemaCatalog(context: SchemaContextKind): Promise<SchemaCatalog> {
  return api.get<SchemaCatalog>(`/schema/catalog?context=${context}`);
}

/** Every type this store has configured, so the list can show which are switched on. */
export function fetchSchemaTemplates(): Promise<SchemaTemplate[]> {
  return api.get<SchemaTemplate[]>('/schema/templates');
}

export function fetchSchemaTemplate(type: string, context: SchemaContextKind): Promise<SchemaTemplate> {
  return api.get<SchemaTemplate>(`/schema/templates/${encodeURIComponent(type)}/${context}`);
}

export function saveSchemaTemplate(
  type: string,
  context: SchemaContextKind,
  body: { enabled: boolean; properties: Record<string, ValueSource> },
): Promise<SchemaTemplate> {
  return api.put<SchemaTemplate>(`/schema/templates/${encodeURIComponent(type)}/${context}`, body);
}

/**
 * Renders the DRAFT against one real record from the store.
 *
 * The unsaved template is sent deliberately: previewing only what is stored would make a merchant
 * save a configuration to find out what it does.
 */
export function previewSchemaTemplate(
  type: string,
  context: SchemaContextKind,
  draft: { enabled: boolean; properties: Record<string, ValueSource> },
): Promise<SchemaPreview> {
  return api.post<SchemaPreview>(`/schema/templates/${encodeURIComponent(type)}/${context}/preview`, draft);
}
