import { api } from '../../lib/api';

/**
 * ─── Image alt-text template configuration ───────────────────────────
 * Talks to the existing page-settings API (store-scoped, authenticated). Configuration only: this
 * saves and loads one JSON document and never reaches Shopify.
 */

export const ALT_TEXT_CONTENT_TYPES = ['products', 'articles'] as const;
export type AltTextContentType = (typeof ALT_TEXT_CONTENT_TYPES)[number];

export const AUTO_FORMATS = ['none', 'sentence', 'lower', 'upper'] as const;
export type AutoFormat = (typeof AUTO_FORMATS)[number];

export const AUTO_FORMAT_LABELS: Record<AutoFormat, string> = {
  none: 'None',
  sentence: 'Sentence case',
  lower: 'Lowercase',
  upper: 'Uppercase',
};

export const CONTENT_TYPE_LABELS: Record<AltTextContentType, string> = {
  products: 'Products',
  articles: 'Articles',
};

export const MIN_CHARACTER_LIMIT = 40;
export const MAX_CHARACTER_LIMIT = 512;
export const MAX_TEMPLATE_LENGTH = 300;

export interface AltTextTypeConfig {
  template: string;
  characterLimit: number;
  autoFormat: AutoFormat;
  skipExisting: boolean;
  removeDuplicateWords: boolean;
  autoGenerate: boolean;
}

export type AltTextConfig = Record<AltTextContentType, AltTextTypeConfig>;

export interface AltTextConfigResponse {
  config: AltTextConfig;
  isDefault: boolean;
  updatedAt: string | null;
}

export interface PlaceholderDefinition {
  key: string;
  label: string;
  hint: string;
}

/**
 * Mirrors the server catalogue in lib/alt-text/template.ts.
 *
 * Kept in step by the server, not by hope: an unknown placeholder is rejected by validation on
 * save, so a stale entry here surfaces as an error rather than as a value the merchant believes
 * will resolve.
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

export function fetchAltTextConfig(): Promise<AltTextConfigResponse> {
  return api.get<AltTextConfigResponse>('/page-settings/image-alt-text/template');
}

export function saveAltTextConfig(config: AltTextConfig): Promise<AltTextConfigResponse> {
  return api.put<AltTextConfigResponse>('/page-settings/image-alt-text/template', { config });
}

// ─── Client-side validation ──────────────────────────────────────────
// For immediacy while typing. The server runs the same rules and is the actual boundary.

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export function templateError(template: string, contentType: AltTextContentType): string | null {
  if (!template.trim()) return 'Enter a template.';
  if (template.length > MAX_TEMPLATE_LENGTH) return `Templates are limited to ${MAX_TEMPLATE_LENGTH} characters.`;

  const withoutValid = template.replace(TOKEN, '');
  if (withoutValid.includes('{{') || withoutValid.includes('}}')) return 'A placeholder is not closed. Use the exact form {{placeholder}}.';
  if (/(^|[^{])\{[^{]/.test(withoutValid) || /[^}]\}([^}]|$)/.test(withoutValid)) {
    return 'Placeholders need double braces, for example {{product_title}}.';
  }

  const allowed = new Set(PLACEHOLDERS[contentType].map((placeholder) => placeholder.key));
  const others = new Set(
    ALT_TEXT_CONTENT_TYPES.flatMap((type) => (type === contentType ? [] : PLACEHOLDERS[type].map((placeholder) => placeholder.key))),
  );
  const used = [...new Set([...template.matchAll(TOKEN)].map((match) => match[1]!.toLowerCase()))];
  const unknown = used.filter((key) => !allowed.has(key));
  if (unknown.length === 0) return null;

  const wrongType = unknown.filter((key) => others.has(key));
  if (wrongType.length > 0) {
    return `${wrongType.map((key) => `{{${key}}}`).join(', ')} is not available for ${CONTENT_TYPE_LABELS[contentType].toLowerCase()}.`;
  }
  return `Rankvora AI has no data for ${unknown.map((key) => `{{${key}}}`).join(', ')}.`;
}

export function characterLimitError(value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_CHARACTER_LIMIT || value > MAX_CHARACTER_LIMIT) {
    return `Use a whole number between ${MIN_CHARACTER_LIMIT} and ${MAX_CHARACTER_LIMIT}.`;
  }
  return null;
}
