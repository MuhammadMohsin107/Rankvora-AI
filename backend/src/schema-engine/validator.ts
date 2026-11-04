import { findSchemaType } from './library.js';
import type { SchemaTypeName, SchemaValidationIssue, SchemaValidationResult } from './types.js';

/**
 * ─── Schema validator ────────────────────────────────────────────────
 *
 * Judges a GENERATED document against the library's requirements before it can be published.
 *
 * This is not a replacement for Google's Rich Results Test, and does not pretend to be: it cannot
 * fetch the page, and Google's eligibility rules change. What it does is catch, at configuration
 * time, the mistakes that would otherwise be discovered weeks later as a rich result that never
 * appeared — a Product with no offers, an Offer with a price but no currency, a FAQPage whose
 * questions have no answers.
 *
 * ERRORS BLOCK, WARNINGS DO NOT. An error means the document asserts something false or is missing
 * what Google documents as required, so publishing it would be worse than publishing nothing. A
 * warning means it is valid but weaker than it could be.
 */

/** Properties whose value must be a number for Schema.org to read it. A price of "Rs 1,499" is
 * the single most common structured-data mistake on a storefront. */
const NUMERIC_PROPERTIES = new Set(['price', 'lowPrice', 'highPrice', 'ratingValue', 'reviewCount', 'ratingCount', 'bestRating', 'worstRating', 'latitude', 'longitude', 'merchantReturnDays', 'offerCount']);

/** Properties that must be an absolute URL. A relative path resolves differently for every
 * consumer and is treated as absent by most. */
const URL_PROPERTIES = new Set(['url', 'image', 'logo', 'thumbnailUrl', 'contentUrl', 'embedUrl', 'sameAs', 'mainEntityOfPage']);

function typeNameOf(node: Record<string, unknown>): SchemaTypeName | null {
  const type = node['@type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && typeof type[0] === 'string') return type[0];
  return null;
}

function isAbsoluteUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateNode(
  node: Record<string, unknown>,
  path: string,
  issues: SchemaValidationIssue[],
  depth: number,
): void {
  if (depth > 12) return;

  const typeName = typeNameOf(node);
  if (!typeName) {
    issues.push({ property: path || '@type', severity: 'error', message: 'This object has no @type, so no consumer can tell what it describes.' });
    return;
  }

  const definition = findSchemaType(typeName);
  // An unknown type is not an error: the custom builder can emit any Schema.org type, and the
  // library is a curated subset rather than the whole vocabulary. It simply cannot be checked
  // against requirements, and saying so is more useful than inventing a verdict.
  if (definition) {
    for (const property of definition.properties) {
      const present = node[property.name] !== undefined;
      if (present) continue;
      if (property.requirement === 'required') {
        issues.push({
          property: path ? `${path}.${property.name}` : property.name,
          severity: 'error',
          message: `${typeName} requires ${property.name} — ${property.description}`,
        });
      } else if (property.requirement === 'recommended') {
        issues.push({
          property: path ? `${path}.${property.name}` : property.name,
          severity: 'warning',
          message: `${property.name} is recommended for ${typeName} and is missing.`,
        });
      }
    }
  }

  for (const [name, value] of Object.entries(node)) {
    if (name.startsWith('@')) continue;
    const propertyPath = path ? `${path}.${name}` : name;

    if (NUMERIC_PROPERTIES.has(name) && typeof value !== 'number') {
      issues.push({
        property: propertyPath,
        severity: 'error',
        message: `${name} must be a number. "${String(value)}" is text, and consumers discard a price or rating they cannot parse.`,
      });
    }

    if (URL_PROPERTIES.has(name)) {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        // An object here is a nested ImageObject etc., checked on its own below.
        if (entry !== null && typeof entry === 'object') continue;
        if (!isAbsoluteUrl(entry)) {
          issues.push({
            property: propertyPath,
            severity: 'error',
            message: `${name} must be a full https:// URL. "${String(entry)}" is not one.`,
          });
        }
      }
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          validateNode(entry as Record<string, unknown>, `${propertyPath}[${index}]`, issues, depth + 1);
        }
      });
    } else if (value !== null && typeof value === 'object') {
      validateNode(value as Record<string, unknown>, propertyPath, issues, depth + 1);
    }
  }
}

export function validateSchema(jsonLd: Record<string, unknown> | null): SchemaValidationResult {
  if (!jsonLd) {
    return {
      valid: false,
      issues: [{ property: '', severity: 'error', message: 'Nothing resolved for this template, so there is no schema to publish.' }],
    };
  }

  const issues: SchemaValidationIssue[] = [];

  if (jsonLd['@context'] !== 'https://schema.org') {
    issues.push({ property: '@context', severity: 'error', message: '@context must be https://schema.org.' });
  }

  validateNode(jsonLd, '', issues, 0);

  return { valid: !issues.some((issue) => issue.severity === 'error'), issues };
}
