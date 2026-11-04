/**
 * ─── What the merchant told us about their business ──────────────────
 *
 * Guided setup collects a brand name, industries, a one-line description and the language content
 * is written in. This is where those answers become part of the prompt that drafts titles and
 * descriptions — which is the only reason to ask for them. Answers that never reached a draft
 * would be a questionnaire.
 *
 * Pure, no database: the caller supplies what the store saved. Every line is OMITTED when its
 * answer is absent, so a store that answered nothing sends exactly the prompt it always did — no
 * placeholder, no "unknown", and no invented language.
 */

export interface BusinessContext {
  brandName: string | null;
  industries: string[];
  sells: string | null;
  /** A locale code ("en", "fr-CA"), exactly as setup stored it. */
  contentLanguage: string | null;
}

export const EMPTY_BUSINESS_CONTEXT: BusinessContext = {
  brandName: null,
  industries: [],
  sells: null,
  contentLanguage: null,
};

/** One line of merchant free text, kept to a single line and a sensible length before it enters a prompt. */
function oneLine(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The language's English name ("French (Canada)") for a locale code, or null when the code is not
 * one Intl knows. A raw code the model might misread is never substituted for a name it could not
 * be given — an unrecognised code simply yields no instruction.
 */
export function languageName(code: string | null | undefined): string | null {
  const locale = oneLine(code, 35);
  if (!locale) return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(locale);
    // Intl echoes an unknown tag back unchanged; that is not a name.
    return name && name.toLowerCase() !== locale.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

/** The prompt lines for what the merchant said about their business. Empty when they said nothing. */
export function businessContextLines(context: BusinessContext | undefined): string[] {
  if (!context) return [];
  const lines: string[] = [];

  const brand = oneLine(context.brandName, 120);
  if (brand) lines.push(`Brand name to use in titles: ${brand}`);

  const industries = context.industries.map((industry) => oneLine(industry, 80)).filter(Boolean);
  if (industries.length > 0) lines.push(`Industry: ${industries.join(', ')}`);

  const sells = oneLine(context.sells, 300);
  if (sells) lines.push(`What the store sells (in the merchant's words): ${sells}`);

  const language = languageName(context.contentLanguage);
  if (language) lines.push(`Write in: ${language}. Every value you return must be written in ${language}.`);

  return lines;
}
