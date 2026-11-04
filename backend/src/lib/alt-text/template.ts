/**
 * ─── Alt-text template engine ────────────────────────────────────────
 * ONE implementation of "template + real resource → alt text", shared by the preview endpoint and
 * by anything that later generates proposed fixes. Duplicating this in the browser for a "live"
 * preview would mean two engines that drift, and the merchant would be shown a value the server
 * would never produce — so the browser calls this instead of reimplementing it.
 *
 * The pipeline is fixed and ordered, because the order is what makes the output predictable:
 *
 *   template → resolve placeholders → collapse whitespace → de-duplicate words → case format
 *            → character limit → final alt text
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It never writes anything. Generating a value and applying a value are separate acts; this module
 * only ever returns a string.
 *
 * PLACEHOLDERS ARE DERIVED FROM WHAT SHOPIFY ACTUALLY RETURNS. Each one below maps to a field the
 * Admin API query already selects (see audit-engine/store-data/shopify.queries.ts). A field that is
 * not fetched has no placeholder, because a placeholder that can only ever resolve to an empty
 * string is a promise the product cannot keep.
 */

/**
 * Content types with images Rankvora AI can actually read.
 *
 * Products carry `media(first: 20) { ... on MediaImage { alt } }` and articles carry
 * `image { altText }`. Collections have NO image field in the Admin API query, and there is no
 * files/media-library query at all — so neither gets a tab. Adding one would be a control the
 * merchant could configure and Rankvora AI could never act on.
 */
export const ALT_TEXT_CONTENT_TYPES = ['products', 'articles'] as const;
export type AltTextContentType = (typeof ALT_TEXT_CONTENT_TYPES)[number];

export function isAltTextContentType(value: unknown): value is AltTextContentType {
  return typeof value === 'string' && (ALT_TEXT_CONTENT_TYPES as readonly string[]).includes(value);
}

export const AUTO_FORMATS = ['none', 'sentence', 'lower', 'upper'] as const;
export type AutoFormat = (typeof AUTO_FORMATS)[number];

export function isAutoFormat(value: unknown): value is AutoFormat {
  return typeof value === 'string' && (AUTO_FORMATS as readonly string[]).includes(value);
}

/** Shopify stores image alt text as a string capped at 512 characters. */
export const MAX_CHARACTER_LIMIT = 512;
/** Below this an alt text cannot describe anything useful, so it is rejected rather than truncated. */
export const MIN_CHARACTER_LIMIT = 40;
/** Bounds the stored template so an oversized string can never reach the database or a model. */
export const MAX_TEMPLATE_LENGTH = 300;

export interface PlaceholderDefinition {
  /** The token as written in a template, without braces. */
  key: string;
  label: string;
  /** What it resolves to, in the merchant's words. */
  hint: string;
}

/**
 * The placeholder catalogue, per content type.
 *
 * `shop_name` appears in both because the shop record is always part of a snapshot.
 * `image_position` is the image's 1-based index within its own gallery — the one honest way to
 * distinguish "front view" from "back view" without inventing a description of the photo.
 */
export const PLACEHOLDERS: Record<AltTextContentType, PlaceholderDefinition[]> = {
  products: [
    { key: 'product_title', label: 'Product title', hint: "The product's own name" },
    { key: 'product_type', label: 'Product type', hint: 'Shopify product type, when set' },
    { key: 'vendor', label: 'Vendor', hint: 'Shopify vendor / brand, when set' },
    { key: 'shop_name', label: 'Shop name', hint: 'Your store name' },
    { key: 'image_position', label: 'Image number', hint: "The image's position in the gallery" },
  ],
  articles: [
    { key: 'article_title', label: 'Article title', hint: "The article's own title" },
    { key: 'blog_title', label: 'Blog', hint: 'The blog the article belongs to' },
    { key: 'shop_name', label: 'Shop name', hint: 'Your store name' },
  ],
};

export function placeholderKeys(contentType: AltTextContentType): string[] {
  return PLACEHOLDERS[contentType].map((placeholder) => placeholder.key);
}

// ─── Configuration ───────────────────────────────────────────────────

export interface AltTextTypeConfig {
  template: string;
  characterLimit: number;
  autoFormat: AutoFormat;
  skipExisting: boolean;
  removeDuplicateWords: boolean;
  /**
   * Generating alt text on upload, with no merchant in the loop.
   *
   * Still NOT honoured, and the API still rejects `true` rather than storing a setting that would
   * do nothing — but only one of the two original reasons is left. Writing alt text back IS now
   * possible: the audit's evidence names each image, this template renders the value, and
   * fix-apply.service.ts writes it with the `write_products` scope Rankvora AI already holds. What is
   * missing is the trigger — generating on upload needs a products/media webhook subscription and
   * a worker, neither of which exists.
   *
   * The review flow is deliberately not that. A merchant selects images, reads every value and
   * presses Save; nothing is written to a live store without that.
   */
  autoGenerate: boolean;
}

export type AltTextConfig = Record<AltTextContentType, AltTextTypeConfig>;

/** Defaults use only placeholders that exist for that content type. */
export const DEFAULT_ALT_TEXT_CONFIG: AltTextConfig = {
  products: {
    template: '{{product_title}} - {{shop_name}}',
    characterLimit: 125,
    autoFormat: 'sentence',
    skipExisting: true,
    removeDuplicateWords: true,
    autoGenerate: false,
  },
  articles: {
    template: '{{article_title}} - {{shop_name}}',
    characterLimit: 125,
    autoFormat: 'sentence',
    skipExisting: true,
    removeDuplicateWords: true,
    autoGenerate: false,
  },
};

// ─── Validation ──────────────────────────────────────────────────────

export interface TemplateIssue {
  field: 'template' | 'characterLimit' | 'autoFormat' | 'autoGenerate';
  message: string;
}

/** Matches a well-formed token and captures its name. */
const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * Catches the malformed forms a merchant actually types: a single brace on either side, or an
 * unclosed token. Checked before the well-formed pass so `{{product_title}` is reported as a syntax
 * error rather than silently surviving as literal text.
 */
function findSyntaxError(template: string): string | null {
  const withoutValid = template.replace(TOKEN, '');
  if (withoutValid.includes('{{') || withoutValid.includes('}}')) {
    return 'A placeholder is not closed. Use the exact form {{placeholder}}.';
  }
  if (/(^|[^{])\{[^{]/.test(withoutValid) || /[^}]\}([^}]|$)/.test(withoutValid)) {
    return 'Placeholders need double braces, for example {{product_title}}.';
  }
  return null;
}

/** Every well-formed placeholder name used in a template, in order, with duplicates kept. */
export function extractPlaceholders(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(TOKEN)) found.push(match[1]!.toLowerCase());
  return found;
}

/**
 * Validates one content type's configuration.
 *
 * Runs on the server before anything is persisted (frontend validation is a convenience, never the
 * boundary) and is re-used by the preview endpoint so a merchant cannot preview a configuration
 * that could not be saved.
 */
export function validateTypeConfig(contentType: AltTextContentType, config: AltTextTypeConfig): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const template = config.template ?? '';

  if (!template.trim()) {
    issues.push({ field: 'template', message: 'Enter a template.' });
  } else if (template.length > MAX_TEMPLATE_LENGTH) {
    issues.push({ field: 'template', message: `Templates are limited to ${MAX_TEMPLATE_LENGTH} characters.` });
  } else {
    const syntaxError = findSyntaxError(template);
    if (syntaxError) {
      issues.push({ field: 'template', message: syntaxError });
    } else {
      const allowed = new Set(placeholderKeys(contentType));
      const unknown = [...new Set(extractPlaceholders(template))].filter((key) => !allowed.has(key));
      if (unknown.length > 0) {
        // Named individually: "unknown placeholder" without saying which one leaves the merchant
        // hunting through their own template.
        const known = new Set(
          ALT_TEXT_CONTENT_TYPES.flatMap((type) => (type === contentType ? [] : placeholderKeys(type))),
        );
        const wrongType = unknown.filter((key) => known.has(key));
        const nonexistent = unknown.filter((key) => !known.has(key));
        if (nonexistent.length > 0) {
          issues.push({
            field: 'template',
            message: `Rankvora AI has no data for ${nonexistent.map((key) => `{{${key}}}`).join(', ')}.`,
          });
        }
        if (wrongType.length > 0) {
          issues.push({
            field: 'template',
            message: `${wrongType.map((key) => `{{${key}}}`).join(', ')} is not available for ${contentType}.`,
          });
        }
      }
    }
  }

  if (!Number.isInteger(config.characterLimit) || config.characterLimit < MIN_CHARACTER_LIMIT || config.characterLimit > MAX_CHARACTER_LIMIT) {
    issues.push({
      field: 'characterLimit',
      message: `Character limit must be a whole number between ${MIN_CHARACTER_LIMIT} and ${MAX_CHARACTER_LIMIT}.`,
    });
  }

  if (!isAutoFormat(config.autoFormat)) {
    issues.push({ field: 'autoFormat', message: 'Choose a supported format.' });
  }

  if (config.autoGenerate) {
    // Refused rather than stored: a stored `true` would be a setting the merchant believes is
    // running. See AltTextTypeConfig.autoGenerate.
    issues.push({
      field: 'autoGenerate',
      message: 'Automatic generation needs Shopify media webhooks and write access, which Rankvora AI does not have yet.',
    });
  }

  return issues;
}

// ─── Generation ──────────────────────────────────────────────────────

/** The real resource values a template resolves against. Every field is optional because Shopify
 * genuinely leaves vendor and product type blank on many catalogues. */
export interface AltTextContext {
  product_title?: string | null;
  product_type?: string | null;
  vendor?: string | null;
  article_title?: string | null;
  blog_title?: string | null;
  shop_name?: string | null;
  image_position?: number | null;
}

/**
 * Removes a word that repeats one it has already seen.
 *
 * DELIBERATELY CONSERVATIVE. "Red Red Cotton Shirt Shirt" should become "Red Cotton Shirt", but
 * "Salt and Pepper Grinder" must not lose a word, and "Bag in Bag Organiser" is a real product
 * name. So: comparison is case-insensitive on letters and digits only; short connective words are
 * never removed; and a repeat is dropped only when the same word has already appeared, keeping the
 * first occurrence and the original casing.
 */
const KEEP_ALWAYS = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'for', 'to', 'by', 'with', 'or', '-', '|']);

export function removeDuplicateWords(value: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const word of value.split(' ')) {
    const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized || KEEP_ALWAYS.has(normalized) || KEEP_ALWAYS.has(word)) {
      kept.push(word);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(word);
  }
  return kept.join(' ');
}

function applyFormat(value: string, format: AutoFormat): string {
  switch (format) {
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'sentence': {
      // Only the first letter is forced; the rest is left alone so "iPhone 15" and "SPF 50" keep
      // the casing the merchant's own catalogue uses.
      const lowerRest = value.charAt(0).toUpperCase() + value.slice(1);
      return lowerRest;
    }
    default:
      return value;
  }
}

/**
 * Truncates on a word boundary and never mid-word, so a limit produces a shorter description
 * rather than a broken one. No ellipsis: alt text is read aloud, and "…" is noise to a screen
 * reader.
 */
function limit(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Tidies the text left after a placeholder resolved to nothing.
 *
 * A product with no vendor turns "{{product_title}} by {{vendor}}" into "Shirt by ", and shipping
 * that to a screen reader would be worse than the missing alt text it replaced. Dangling
 * separators and the connecting words in front of them are removed with the empty value.
 */
function tidySeparators(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)(by|from|for|in|at|with)\s*([-–—|,:]|$)/gi, '$3')
    .replace(/\s*([-–—|,:])\s*(?=[-–—|,:]|$)/g, '')
    .replace(/^[\s\-–—|,:]+/, '')
    .replace(/[\s\-–—|,:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GeneratedAltText {
  /** The final value, after the whole pipeline. Empty when the template resolved to nothing. */
  value: string;
  /** True when `skipExisting` was on and the image already had alt text — nothing was generated. */
  skipped: boolean;
  /** The alt text already on the image, exactly as Shopify returned it. */
  existing: string | null;
  /** True when the value was shortened to fit the character limit. */
  truncated: boolean;
}

/**
 * Runs the whole pipeline for one image.
 *
 * `existingAlt` is the image's real Shopify alt text: `null` when the attribute is absent, `''`
 * when it is present but empty. Both count as "no alt text" for skip purposes — an empty string
 * marks a decorative image, and a product photo is not decorative.
 */
export function generateAltText(
  template: string,
  context: AltTextContext,
  config: Pick<AltTextTypeConfig, 'characterLimit' | 'autoFormat' | 'skipExisting' | 'removeDuplicateWords'>,
  existingAlt: string | null = null,
): GeneratedAltText {
  const hasExisting = typeof existingAlt === 'string' && existingAlt.trim().length > 0;
  if (config.skipExisting && hasExisting) {
    return { value: existingAlt as string, skipped: true, existing: existingAlt, truncated: false };
  }

  const resolved = template.replace(TOKEN, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase() as keyof AltTextContext;
    const value = context[key];
    if (value === null || value === undefined) return '';
    return String(value).trim();
  });

  let value = tidySeparators(resolved);
  if (config.removeDuplicateWords) {
    // Tidied AGAIN afterwards: removing a duplicate can itself strip the last word of a segment,
    // and "{{product_title}} - {{vendor}}" on an Acme-branded Acme product then ended in a bare
    // " -". Caught by alt-text-template.test.ts rather than by a merchant.
    value = tidySeparators(removeDuplicateWords(value));
  }
  value = applyFormat(value, config.autoFormat);

  const truncated = value.length > config.characterLimit;
  value = limit(value, config.characterLimit);

  return { value, skipped: false, existing: hasExisting ? existingAlt : null, truncated };
}
