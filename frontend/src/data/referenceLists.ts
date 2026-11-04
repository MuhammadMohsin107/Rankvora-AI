// ─── Standard reference lists ────────────────────────────────────────
// Every timezone and every currency, from the browser's own standard data — never a hand-picked
// handful. The Workspace page used to offer 6 timezones, 5 currencies and 7 countries, so most
// real stores could not even be represented, and a value outside the list displayed as the first
// entry instead. These come from Intl (IANA zones, ISO 4217 codes), the same data the browser uses
// to format dates and prices.

import { countryNames } from './onboarding.repository';

/** The one country list, shared with guided setup rather than kept twice. */
export { countryNames };

/** Intl.supportedValuesOf is ES2022; this build targets ES2020, so it is read defensively. */
function supported(key: 'timeZone' | 'currency'): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.(key) ?? [];
  } catch {
    // An engine without the list offers only the stored and Shopify values — never an invented set.
    return [];
  }
}

let timeZoneCache: string[] | null = null;
let currencyCache: string[] | null = null;

/** Every IANA timezone the browser knows, e.g. "Asia/Karachi". */
export function timeZoneNames(): string[] {
  timeZoneCache ??= supported('timeZone');
  return timeZoneCache;
}

/** Every ISO 4217 currency code the browser knows, e.g. "PKR". */
export function currencyCodes(): string[] {
  currencyCache ??= supported('currency');
  return currencyCache;
}

/** "PKR — Pakistani Rupee" for "PKR"; any other stored value is shown as it is. */
export function currencyLabel(code: string): string {
  if (!/^[A-Z]{3}$/.test(code)) return code;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'currency' }).of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}
