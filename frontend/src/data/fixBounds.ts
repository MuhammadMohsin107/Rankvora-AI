/**
 * ─── The range an SEO title FIELD must fall in, given the store's theme ──────────────────────
 *
 * The title-tags check scores the RENDERED title — what the merchant writes in Shopify plus the
 * suffix their theme appends (usually " | Store name") — against 30-60 characters. So the field's
 * own range is that range less the suffix: a 30-character suffix leaves 10-30 for the field, with a
 * floor of 10 so a fix still names the page. This is the browser's copy of titleFieldRule in
 * backend/src/lib/ai/fix-policy.ts, which the server judges every value by; it is only here so an
 * editor can show the range and not offer Apply for a value the server is certain to refuse.
 */

export const TITLE_FIELD_FLOOR = 10;

export function titleFieldBounds(minLength: number, maxLength: number, suffixLength: number): { minLength: number; maxLength: number } {
  if (suffixLength <= 0) return { minLength, maxLength };
  const fieldMax = maxLength - suffixLength;
  // The theme's own text fills the whole title: no field value can fix that, and the server keeps
  // the plain range too.
  if (fieldMax < 1) return { minLength, maxLength };
  // The floor never takes more than half the room left, so the range never closes to one length.
  return { minLength: Math.max(1, minLength - suffixLength, Math.min(TITLE_FIELD_FLOOR, Math.floor(fieldMax / 2))), maxLength: fieldMax };
}
