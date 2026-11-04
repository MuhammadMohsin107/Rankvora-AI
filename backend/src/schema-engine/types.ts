/**
 * ─── Rankvora AI Schema Engine · contracts ───────────────────────────────
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * The SEO schema AUDIT (audit-engine/checks/seo/schema.ts) answers "what structured data does the
 * storefront actually render?" by reading crawled HTML. It stays exactly as it is.
 *
 * This engine answers a different question: "what structured data SHOULD Rankvora AI generate for this
 * store, from its real Shopify data?" The two meet later — once generated schema is published, the
 * existing audit is what proves it reached the page. Neither replaces the other, and this file
 * deliberately imports nothing from the audit so the two cannot grow into one tangled thing.
 *
 * NOTHING HERE INVENTS DATA. A template declares WHERE each property's value comes from; the
 * resolver reads that place in a real StoreSnapshot. When a source holds nothing, the property is
 * omitted and the reason is recorded — a schema that quietly ships a placeholder price or an
 * invented GTIN is worse than no schema, because a merchant cannot see that it is wrong and
 * Google's rich-result eligibility turns on exactly those fields being true.
 */

/** The Schema.org types this engine can emit. Widened as the library grows; see library.ts. */
export type SchemaTypeName = string;

/**
 * Which Shopify record a template is rendered against.
 *
 * A template is written once and applied to every record of its context — one Product template
 * serves the whole catalogue, exactly as a theme's Liquid does.
 */
export type SchemaContextKind = 'product' | 'collection' | 'page' | 'article' | 'shop';

/**
 * ─── Where a property's value comes from ─────────────────────────────
 *
 * Deliberately a closed union rather than a free-text expression language. A merchant picking
 * from a list of real, named Shopify fields cannot write a mapping that silently resolves to
 * nothing — and Rankvora AI can tell them, before publishing, which properties will actually be
 * populated for their catalogue.
 */
export type ValueSource =
  /** Omit this property entirely. The explicit default, so nothing is emitted by accident. */
  | { kind: 'none' }
  /** A named field of the record being rendered. `path` must exist in the field catalog. */
  | { kind: 'shopify'; path: string }
  /** A metafield on the record, by namespace and key — the merchant's own structured data. */
  | { kind: 'metafield'; namespace: string; key: string }
  /** A fixed value the merchant typed. Used where Shopify holds nothing, e.g. a returns window. */
  | { kind: 'static'; value: string | number | boolean }
  /** A nested Schema.org object, e.g. Product.offers -> Offer. */
  | { kind: 'object'; type: SchemaTypeName; properties: Record<string, ValueSource> }
  /** A list. Either repeated per item of a Shopify collection field, or a fixed set of entries. */
  | { kind: 'array'; items: ValueSource[] };

/** One store's configuration for one Schema.org type. */
export interface SchemaTemplate {
  type: SchemaTypeName;
  context: SchemaContextKind;
  /** Off by default. Nothing is published for a type the merchant has not switched on. */
  enabled: boolean;
  properties: Record<string, ValueSource>;
}

/**
 * Why a property produced nothing.
 *
 * Kept per property rather than collapsed into one "incomplete" flag, because the merchant's next
 * action differs entirely: `empty` means fill the field in Shopify, `unsupported_source` means the
 * mapping points at something this engine cannot read yet, and `missing_source` means they never
 * chose one.
 */
export type OmissionReason =
  | 'not_configured'
  | 'empty'
  | 'unknown_field'
  | 'metafield_values_unavailable'
  | 'metafield_not_found';

export interface PropertyOmission {
  /** Dotted path within the generated object, e.g. "offers.price". */
  property: string;
  reason: OmissionReason;
  /** What the merchant can do about it, in their own terms. */
  detail: string;
}

export interface ResolvedSchema {
  /** The JSON-LD object, ready to serialise. Null when nothing resolved at all. */
  jsonLd: Record<string, unknown> | null;
  /** Every property that was configured but produced no value, and why. */
  omissions: PropertyOmission[];
}

/** A problem with the generated document, judged against the type definition and Google's
 * documented requirements for rich results. */
export interface SchemaValidationIssue {
  property: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  issues: SchemaValidationIssue[];
}
