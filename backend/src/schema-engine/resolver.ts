import { findField, type FieldValue, type ResolutionContext } from './fields.js';
import type {
  OmissionReason,
  PropertyOmission,
  ResolvedSchema,
  SchemaTemplate,
  ValueSource,
} from './types.js';

/**
 * ─── The dynamic variable resolver ───────────────────────────────────
 *
 * Turns a template plus ONE real Shopify record into a JSON-LD object.
 *
 * THE ONE RULE: a property is emitted only when a real value was found for it. There is no default
 * value anywhere in this file, no placeholder, and no "" fallback. A schema that ships an invented
 * GTIN or a zero price is not a lesser version of a correct one — it is a false statement about
 * the merchant's product, made to Google, in a format built to be trusted. Absence is reported to
 * the merchant instead, with the reason, so they can fix the data at its source.
 *
 * Every omission is recorded rather than swallowed, which is what lets the Settings page answer
 * "what will actually be published for MY catalogue?" before anything is published.
 */

/** Guards a template that nests itself, directly or through a cycle. */
const MAX_DEPTH = 12;

function omission(property: string, reason: OmissionReason, detail: string): PropertyOmission {
  return { property, reason, detail };
}

/** A value Shopify holds but that carries no information. Emitting these is the failure mode this
 * engine exists to avoid: `""` asserts an empty SKU, `[]` asserts a product with no images. */
function isEmpty(value: FieldValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

interface ResolveState {
  context: ResolutionContext;
  omissions: PropertyOmission[];
}

/** Resolves one source. Returns `undefined` when nothing should be emitted. */
function resolveSource(source: ValueSource, path: string, state: ResolveState, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    state.omissions.push(omission(path, 'unknown_field', 'This mapping nests too deeply to resolve.'));
    return undefined;
  }

  switch (source.kind) {
    case 'none':
      return undefined;

    case 'static':
      // A merchant typing a value is asserting it themselves, so it is taken at face value — but
      // an empty box is still an empty box.
      if (typeof source.value === 'string' && source.value.trim() === '') {
        state.omissions.push(omission(path, 'empty', 'The fixed value for this property is blank.'));
        return undefined;
      }
      return source.value;

    case 'shopify': {
      const field = findField(source.path);
      if (!field) {
        state.omissions.push(omission(
          path,
          'unknown_field',
          `"${source.path}" is not a Shopify field Rankvora AI can read. Choose another source for this property.`,
        ));
        return undefined;
      }
      if (!field.contexts.includes(state.context.kind)) {
        state.omissions.push(omission(
          path,
          'unknown_field',
          `${field.label} does not exist on a ${state.context.kind}, so it cannot fill this property here.`,
        ));
        return undefined;
      }
      const value = field.read(state.context);
      if (isEmpty(value)) {
        state.omissions.push(omission(path, 'empty', `${field.label} is empty for this record in Shopify.`));
        return undefined;
      }
      return value;
    }

    case 'metafield': {
      // Metafield VALUES are not in the snapshot yet — the provider reads namespace/key/type and
      // whether a value exists, but not the value itself. Reported as its own reason rather than
      // as "empty", because the merchant's data may be perfectly fine and nothing they do in
      // Shopify would change this outcome.
      const record = metafieldOwner(state.context);
      if (!record) {
        state.omissions.push(omission(
          path,
          'metafield_not_found',
          `A ${state.context.kind} has no metafields Rankvora AI can read.`,
        ));
        return undefined;
      }
      const declared = record.metafields.find(
        (entry) => entry.namespace === source.namespace && entry.key === source.key,
      );
      if (!record.metafieldsAvailable) {
        state.omissions.push(omission(
          path,
          'metafield_values_unavailable',
          'Rankvora AI could not read metafields for this record, so this mapping cannot be resolved.',
        ));
        return undefined;
      }
      if (!declared) {
        state.omissions.push(omission(
          path,
          'metafield_not_found',
          `No metafield ${source.namespace}.${source.key} exists on this record.`,
        ));
        return undefined;
      }
      state.omissions.push(omission(
        path,
        'metafield_values_unavailable',
        `${source.namespace}.${source.key} exists${declared.hasValue ? ' and has a value' : ' but is empty'}, `
        + 'but Rankvora AI does not yet read metafield values. This property will be left out until it does.',
      ));
      return undefined;
    }

    case 'object': {
      const nested = resolveProperties(source.properties, path, state, depth + 1);
      // An object whose every property resolved to nothing is not an empty object worth emitting:
      // `"brand": {"@type": "Brand"}` tells a consumer nothing and can fail validation.
      if (Object.keys(nested).length === 0) return undefined;
      return { '@type': source.type, ...nested };
    }

    case 'array': {
      const values = source.items
        .map((item, index) => resolveSource(item, `${path}[${index}]`, state, depth + 1))
        .filter((value) => value !== undefined);
      if (values.length === 0) return undefined;
      // A single-entry list is flattened: Schema.org treats a value and a one-item list alike, and
      // the flat form is what Google's own examples show.
      return values.length === 1 ? values[0] : values;
    }

    default:
      return undefined;
  }
}

/** The record metafields hang off, for the current context. */
function metafieldOwner(context: ResolutionContext) {
  // Only products carry metafields in the snapshot today. Pages and articles have them too, but
  // the provider reads those solely to recover global.title_tag, and does not keep the list.
  return context.kind === 'product' ? context.product : undefined;
}

function resolveProperties(
  properties: Record<string, ValueSource>,
  prefix: string,
  state: ResolveState,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (source.kind === 'none') {
      // Not an omission worth reporting: the merchant explicitly chose to leave it out.
      continue;
    }
    const value = resolveSource(source, path, state, depth);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Builds the JSON-LD for one record.
 *
 * Returns `jsonLd: null` when nothing resolved — a document of `@context` and `@type` alone
 * describes nothing, and publishing it would put an empty assertion on the page.
 */
export function resolveTemplate(template: SchemaTemplate, context: ResolutionContext): ResolvedSchema {
  const state: ResolveState = { context, omissions: [] };
  const properties = resolveProperties(template.properties, '', state, 0);

  if (Object.keys(properties).length === 0) {
    return { jsonLd: null, omissions: state.omissions };
  }

  return {
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': template.type,
      ...properties,
    },
    omissions: state.omissions,
  };
}
