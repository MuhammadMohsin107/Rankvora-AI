import { z } from 'zod';

/**
 * ─── Validation for stored schema templates ──────────────────────────
 *
 * A template is merchant input that later becomes markup on their storefront, so it is validated
 * on the way IN rather than trusted on the way out. A malformed ValueSource reaching the resolver
 * would surface as a mystery empty property days later, on a live page.
 *
 * The union is closed and recursive. `z.lazy` is required because `object` and `array` sources
 * contain further sources — TypeScript cannot infer a type that references itself mid-definition,
 * so the annotation is explicit.
 */

const SCHEMA_CONTEXTS = ['product', 'collection', 'page', 'article', 'shop'] as const;

export const schemaContextSchema = z.enum(SCHEMA_CONTEXTS);

/** Schema.org type names are letters only in practice (Product, FAQPage, LocalBusiness). Bounding
 * it keeps a stored type name from becoming an injection vector for anything that renders it. */
export const schemaTypeNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, 'Not a Schema.org type name');

/** Shopify metafield namespaces and keys, per Shopify's own rules. */
const metafieldSegment = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Not a valid metafield namespace or key');

export type ValueSourceInput =
  | { kind: 'none' }
  | { kind: 'shopify'; path: string }
  | { kind: 'metafield'; namespace: string; key: string }
  | { kind: 'static'; value: string | number | boolean }
  | { kind: 'object'; type: string; properties: Record<string, ValueSourceInput> }
  | { kind: 'array'; items: ValueSourceInput[] };

export const valueSourceSchema: z.ZodType<ValueSourceInput> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('shopify'), path: z.string().trim().min(1).max(120) }).strict(),
    z.object({ kind: z.literal('metafield'), namespace: metafieldSegment, key: metafieldSegment }).strict(),
    // A static value is the merchant's own assertion. Bounded so a stored template cannot grow
    // without limit, and never an object — nesting goes through `object`, which is checked.
    z.object({ kind: z.literal('static'), value: z.union([z.string().max(5000), z.number(), z.boolean()]) }).strict(),
    z.object({
      kind: z.literal('object'),
      type: schemaTypeNameSchema,
      properties: z.record(z.string().min(1).max(64), valueSourceSchema),
    }).strict(),
    // Bounded: an unbounded list would let one template produce a document large enough to slow
    // every page it renders on.
    z.object({ kind: z.literal('array'), items: z.array(valueSourceSchema).max(50) }).strict(),
  ]),
);

export const upsertSchemaTemplateSchema = z.object({
  enabled: z.boolean(),
  properties: z.record(z.string().min(1).max(64), valueSourceSchema),
}).strict();

export const schemaTemplateParamsSchema = z.object({
  type: schemaTypeNameSchema,
  context: schemaContextSchema,
});

export const schemaPreviewQuerySchema = z.object({
  context: schemaContextSchema,
  storeId: z.coerce.number().int().positive().optional(),
}).strict();

export type UpsertSchemaTemplateInput = z.infer<typeof upsertSchemaTemplateSchema>;
