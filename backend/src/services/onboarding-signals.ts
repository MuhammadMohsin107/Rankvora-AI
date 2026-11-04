import type { CatalogSignals } from '../audit-engine/store-data/shopify.queries.js';

/**
 * ─── Deriving setup answers from a merchant's own catalogue ──────────
 *
 * Everything in this file turns REAL data the merchant already has — their collection names,
 * product types, vendors and tags — into a pre-filled answer they can accept or correct.
 *
 * NOTHING HERE INVENTS CONTENT. There are no example keywords, no specimen industries, no
 * placeholder brand names. When a store's catalogue carries no usable signal, every function
 * returns null or an empty list, and the UI renders an empty field rather than a guess wearing
 * the merchant's name. A wrong pre-fill a merchant accepts without reading is worse than no
 * pre-fill at all, because it silently becomes the input to every generated title tag.
 *
 * The lists below are VOCABULARY, not data: the industry taxonomy is the set of answers on offer,
 * and the match terms are how catalogue words map onto them. That is classifier logic, the same
 * kind of thing as a stop-word list — it describes no store, and it is never returned as though
 * a store had produced it.
 */

/** Confidence in a derived answer. `low` is still shown, but the UI must not pre-select it. */
export type SignalConfidence = 'high' | 'medium' | 'low';

export interface DerivedAnswer<T> {
  value: T;
  confidence: SignalConfidence;
  /** Plain-language statement of what in the merchant's store produced this, shown under the
   * field. A pre-fill the merchant cannot trace is a pre-fill they cannot sensibly correct. */
  basis: string;
}

// ─── Industry taxonomy ───────────────────────────────────────────────
// The answers on offer in step 2. Chosen to span Shopify's actual merchant base and, more
// importantly, to separate stores whose audits genuinely differ: a supplements store has
// regulated-claims and review-schema concerns a furniture store does not.
//
// `terms` are lowercase substrings matched against catalogue words. They are intentionally
// specific — "tea" would match "steamer", so multi-word and bounded terms are preferred.
interface IndustryRule {
  label: string;
  terms: string[];
}

const INDUSTRY_RULES: IndustryRule[] = [
  { label: 'Apparel & fashion', terms: ['apparel', 'clothing', 'dress', 'shirt', 'tshirt', 't-shirt', 'hoodie', 'jacket', 'trouser', 'jeans', 'skirt', 'knitwear', 'outerwear', 'swimwear', 'lingerie', 'activewear', 'footwear', 'sneaker', 'shoes', 'boots', 'merino', 'base layer'] },
  { label: 'Jewellery & accessories', terms: ['jewellery', 'jewelry', 'necklace', 'bracelet', 'earring', 'ring', 'pendant', 'watch', 'handbag', 'wallet', 'scarf', 'sunglasses'] },
  { label: 'Beauty & personal care', terms: ['beauty', 'skincare', 'skin care', 'cosmetic', 'makeup', 'fragrance', 'perfume', 'haircare', 'hair care', 'shampoo', 'serum', 'moisturiser', 'moisturizer', 'grooming'] },
  { label: 'Health & supplements', terms: ['supplement', 'vitamin', 'protein', 'wellness', 'nutrition', 'probiotic', 'collagen', 'herbal remedy', 'medical'] },
  { label: 'Food & beverage', terms: ['food', 'beverage', 'coffee', 'espresso', 'cold brew', 'tea blend', 'snack', 'chocolate', 'bakery', 'sauce', 'spice', 'gourmet', 'wine', 'beer', 'spirits', 'brewing'] },
  { label: 'Home & furniture', terms: ['furniture', 'home decor', 'homeware', 'kitchenware', 'bedding', 'mattress', 'cushion', 'lighting', 'rug', 'sofa', 'table', 'chair', 'storage', 'interior'] },
  { label: 'Electronics & gadgets', terms: ['electronic', 'gadget', 'headphone', 'earbud', 'speaker', 'charger', 'laptop', 'phone case', 'camera', 'drone', 'smart home', 'audio'] },
  { label: 'Sports & outdoors', terms: ['sport', 'outdoor', 'fitness', 'gym', 'cycling', 'bike', 'camping', 'hiking', 'fishing', 'yoga', 'running', 'climbing', 'ski', 'surf'] },
  { label: 'Toys, games & hobbies', terms: ['toy', 'game', 'puzzle', 'board game', 'figurine', 'model kit', 'lego', 'hobby', 'collectible', 'trading card'] },
  { label: 'Baby & kids', terms: ['baby', 'infant', 'toddler', 'nursery', 'pram', 'stroller', 'kids', 'children'] },
  { label: 'Pet supplies', terms: ['pet', 'dog', 'cat', 'puppy', 'kitten', 'aquarium', 'reptile', 'bird cage', 'kennel', 'leash'] },
  { label: 'Arts, crafts & stationery', terms: ['art print', 'craft', 'stationery', 'notebook', 'journal', 'planner', 'pen', 'paint', 'yarn', 'fabric', 'sewing', 'scrapbook', 'calligraphy'] },
  { label: 'Automotive & parts', terms: ['automotive', 'car part', 'motorcycle', 'vehicle', 'tyre', 'tire', 'brake', 'exhaust', 'wheel', 'garage'] },
  { label: 'Tools, industrial & DIY', terms: ['tool', 'hardware', 'industrial', 'machinery', 'drill', 'saw', 'welding', 'workshop', 'safety equipment', 'diy'] },
  { label: 'Books, media & music', terms: ['book', 'vinyl', 'record', 'magazine', 'instrument', 'guitar', 'piano', 'sheet music', 'film', 'dvd'] },
  { label: 'Digital products & downloads', terms: ['digital download', 'ebook', 'preset', 'template', 'course', 'software', 'licence', 'license key', 'printable'] },
  { label: 'Gifts & occasions', terms: ['gift', 'hamper', 'wedding', 'birthday', 'christmas', 'party', 'greeting card', 'occasion'] },
  { label: 'Garden & plants', terms: ['garden', 'plant', 'seed', 'succulent', 'planter', 'horticulture', 'landscaping', 'greenhouse'] },
  { label: 'Cannabis & CBD', terms: ['cbd', 'cannabis', 'hemp', 'vape', 'smoking accessor'] },
  { label: 'Adult', terms: ['adult toy', 'intimate', 'adult novelty'] },
];

/** Offered in step 2 when nothing matched, and as the full list behind any derived answer. */
export const INDUSTRY_OPTIONS: string[] = [...INDUSTRY_RULES.map((rule) => rule.label), 'Other'];

// ─── Generic collection names ────────────────────────────────────────
// Shopify creates some of these automatically and merchants name others out of habit. They are
// real collections, but they carry no search intent — "Home page" is not a keyword anyone types.
// Excluding them is the difference between seeding "merino base layers" and seeding "Frontpage".
const NON_DESCRIPTIVE_COLLECTIONS = new Set([
  'all', 'all products', 'home page', 'homepage', 'frontpage', 'front page', 'featured',
  'featured products', 'new', 'new in', 'new arrivals', 'latest', 'sale', 'on sale', 'clearance',
  'outlet', 'best sellers', 'bestsellers', 'best selling', 'shop all', 'everything', 'catalog',
  'catalogue', 'misc', 'miscellaneous', 'other', 'uncategorised', 'uncategorized', 'archive',
  'coming soon', 'gift cards', 'gift card', 'accessories', 'products',
]);

/** Legal and trading suffixes stripped when deriving a short brand name. */
const COMPANY_SUFFIXES = /\s*(?:,)?\s*\b(?:co|co\.|inc|inc\.|ltd|ltd\.|llc|l\.l\.c\.|limited|corp|corp\.|corporation|company|gmbh|bv|b\.v\.|pty|pty\.|plc|s\.a\.|sarl|ab|as|oy|srl|spa|pvt|pvt\.)\b\.?$/i;

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Classifies the store's vertical from its own catalogue vocabulary.
 *
 * Every catalogue word is weighted by where it appeared: a collection the merchant named and
 * filled with 200 products says more about the business than one tag on one product.
 *
 * Returns null when no rule matched — which is a real outcome for a store selling something the
 * taxonomy does not cover, and must leave step 2 unselected rather than pick the least-wrong
 * option on the merchant's behalf.
 */
export function deriveIndustry(signals: CatalogSignals): DerivedAnswer<string> | null {
  const scores = new Map<string, { score: number; matched: Set<string> }>();

  const consider = (text: string, weight: number) => {
    const haystack = normalise(text);
    if (!haystack) return;
    for (const rule of INDUSTRY_RULES) {
      for (const term of rule.terms) {
        if (!haystack.includes(term)) continue;
        const entry = scores.get(rule.label) ?? { score: 0, matched: new Set<string>() };
        entry.score += weight;
        entry.matched.add(text.trim());
        scores.set(rule.label, entry);
        // One hit per rule per phrase: "shoes & sneakers" should not count double for footwear.
        break;
      }
    }
  };

  // Weights reflect how deliberately a merchant chose the word, not how often it occurs.
  for (const collection of signals.collections) {
    // A collection with many products is a stronger statement of what the store is about.
    consider(collection.title, 3 + Math.min(3, Math.floor((collection.productCount ?? 0) / 25)));
  }
  for (const type of signals.productTypes) consider(type.value, 2 + Math.min(4, type.count));
  for (const vendor of signals.vendors) consider(vendor.value, 1);
  for (const tag of signals.tags) consider(tag.value, 1);

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const top = ranked[0];
  if (!top) return null;

  const [label, { score, matched }] = top;
  const runnerUp = ranked[1]?.[1].score ?? 0;

  /**
   * Confidence is about CORROBORATION, not raw score.
   *
   * A store whose vertical shows up in two independent places — a collection the merchant named
   * and the product type they assigned — is a confident match even at a modest score, because two
   * separate merchandising decisions agree. One overwhelming signal counts too, which is what the
   * absolute threshold covers.
   *
   * Either way the leader must be clearly ahead: a catalogue that scores equally as "Apparel" and
   * "Sports" is genuinely ambiguous, and saying so is more useful than asserting one of them.
   */
  const clearLeader = score >= runnerUp * 2;
  const corroborated = matched.size >= 2 && clearLeader;
  const confidence: SignalConfidence =
    corroborated || (score >= 12 && clearLeader) ? 'high' : score >= 4 ? 'medium' : 'low';

  const examples = [...matched].slice(0, 3);
  return {
    value: label,
    confidence,
    basis: `Matched ${examples.map((example) => `“${example}”`).join(', ')} in your collections and product types.`,
  };
}

/**
 * Seeds target keywords from the phrases the merchant already uses to organise their own store.
 *
 * Collection titles come first and rank highest: they are merchandising decisions, written for
 * shoppers, and they are what a store's category pages compete on. Product types follow.
 *
 * Returns an empty list for a store with no collections and no product types. That is a real and
 * fairly common state for a brand-new store, and step 4 must show it as empty — a merchant who
 * accepts invented keywords gets an audit measured against terms they never chose.
 */
export function deriveKeywords(signals: CatalogSignals, brandTerms: string[]): Array<{ value: string; source: string }> {
  const seen = new Set(brandTerms.map(normalise));
  const seeds: Array<{ value: string; source: string }> = [];

  const add = (raw: string, source: string) => {
    const value = raw.replace(/\s+/g, ' ').trim();
    const key = normalise(value);
    if (!key || key.length < 3 || key.length > 60) return;
    if (NON_DESCRIPTIVE_COLLECTIONS.has(key)) return;
    // A collection named after the shop is branded, not a target keyword.
    if (seen.has(key)) return;
    // Pure numbers and SKU-like codes are organisational, not search terms.
    if (!/[a-z]/i.test(value) || /^[a-z]{0,3}[-_ ]?\d+$/i.test(value)) return;
    seen.add(key);
    seeds.push({ value: value.toLowerCase(), source });
  };

  for (const collection of signals.collections) {
    add(collection.title, collection.productCount === null ? 'Collection' : `Collection · ${collection.productCount} products`);
  }
  for (const type of signals.productTypes) {
    add(type.value, `Product type · ${type.count} of ${signals.sampledProducts} sampled`);
  }

  // Ten is the cap step 4 offers. More than that stops being a starting point and becomes a list
  // the merchant has to prune, which is the work the seeding exists to remove.
  return seeds.slice(0, 10);
}

/**
 * Questions a shopper might put to an AI assistant, built from the store's own category names.
 *
 * Offered as SUGGESTIONS the merchant confirms one at a time: a suggested question only becomes a
 * tracked one — with real assistant answers recorded against it, at a real per-call cost — when
 * they choose it. Nothing here is added on their behalf.
 *
 * WHAT IS AND IS NOT INVENTED. The topic is always a collection title or product type the store
 * itself uses (via deriveKeywords), and the place is the merchant's own priority market. The
 * sentence frame is the only thing written here, and it is the plainest way anyone asks where to
 * buy something. A store with no usable category names gets no suggestions — never a generic
 * "best products" question that says nothing about it.
 *
 * A question without a market is phrased without one ("online") rather than naming a country the
 * merchant never chose.
 */
export function deriveCustomerQuestions(
  signals: CatalogSignals,
  brandTerms: string[],
  market: string | null,
): Array<{ value: string; source: string }> {
  const place = market?.trim() ? `in ${market.trim()}` : 'online';
  const topics = deriveKeywords(signals, brandTerms).slice(0, 4);

  const questions: Array<{ value: string; source: string }> = [];
  for (const topic of topics) {
    questions.push({
      value: `Where can I buy ${topic.value} ${place}?`,
      source: `From your ${topic.source.split(' · ')[0]!.toLowerCase()} “${topic.value}”`,
    });
  }
  // One more angle on the single strongest topic: asking for a recommendation rather than a
  // retailer is the other shape these questions take, and it tests a different kind of answer.
  const lead = topics[0];
  if (lead) {
    questions.push({
      value: `What are the best ${lead.value} brands${market?.trim() ? ` in ${market.trim()}` : ''}?`,
      source: `From your ${lead.source.split(' · ')[0]!.toLowerCase()} “${lead.value}”`,
    });
  }
  return questions;
}

/**
 * Derives brand-name variants from the shop's own name and myshopify handle.
 *
 * Used to separate branded from non-branded performance, and to keep the merchant's own name out
 * of the target-keyword seeds. Only variants that genuinely differ are returned — a shop called
 * "Northline" yields one term, not three copies of it.
 */
export function deriveBrandedTerms(shopName: string | null, myshopifyDomain: string | null): string[] {
  const terms: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 2) return;
    if (terms.some((existing) => normalise(existing) === normalise(trimmed))) return;
    terms.push(trimmed);
  };

  push(shopName);
  // "Northline Outdoor Supply Co." also competes as "Northline Outdoor Supply".
  if (shopName) {
    const stripped = shopName.replace(COMPANY_SUFFIXES, '').trim();
    if (stripped && stripped !== shopName.trim()) push(stripped);
  }
  // The handle is how the store is addressed before a custom domain, and merchants are searched
  // for by it. Only added when it differs from the name — usually it does not.
  if (myshopifyDomain) {
    const handle = myshopifyDomain.replace(/\.myshopify\.com$/i, '').replace(/-/g, ' ').trim();
    push(handle);
  }

  return terms;
}

/** The two catalogue shapes the audit plans differently for. */
export const CATALOG_SHAPES = ['Focused catalogue', 'Broad catalogue'] as const;

/**
 * Describes the catalogue's shape from its real product count.
 *
 * The threshold is a crawl-planning decision, not a judgement: below it, every product page can be
 * audited individually within the free page budget; above it, template-level sampling is what
 * makes an audit finish. Returns null when Shopify did not give us a count — "we don't know how
 * big your catalogue is" is a legitimate answer and the field stays empty.
 */
export function deriveCatalogShape(signals: CatalogSignals): DerivedAnswer<string> | null {
  const total = signals.productTotal;
  if (!total) return null;

  const broad = total.count >= 200;
  const counted = total.exact ? `${total.count.toLocaleString('en')}` : `at least ${total.count.toLocaleString('en')}`;
  return {
    value: broad ? 'Broad catalogue' : 'Focused catalogue',
    // An inexact count near the boundary is not something to be confident about.
    confidence: total.exact || total.count >= 400 ? 'high' : 'medium',
    basis: `Your store has ${counted} products.`,
  };
}
