import type { SchemaContextKind, SchemaTypeName, ValueSource } from './types.js';

/**
 * ─── The Schema type library ─────────────────────────────────────────
 *
 * Every Schema.org type Rankvora AI can generate, what each one's properties mean, which of them
 * Google actually requires for a rich result, and the Shopify field each should start mapped to.
 *
 * PURE DATA, ON PURPOSE. Adding a type is adding an entry here — no resolver change, no UI change,
 * no new endpoint. That is what makes the coverage scalable rather than a menu someone has to
 * hand-build a screen for.
 *
 * `requirement` IS GOOGLE'S, NOT SCHEMA.ORG'S. Schema.org marks almost nothing as required; Google
 * documents exactly which properties a type needs before it is eligible for a rich result, and
 * that is the line a merchant cares about. 'required' therefore means "Google will not show a rich
 * result without it", 'recommended' means "Google documents it as improving the result", and
 * 'optional' means neither — it is still valid Schema.org and still useful to AI crawlers.
 *
 * `defaultSource` is a STARTING POINT the merchant can change, not a hidden rule. Every default
 * points at a field that genuinely exists in the Shopify snapshot (see fields.ts), so a built-in
 * template resolves against a real catalogue the moment it is switched on.
 */

export type PropertyRequirement = 'required' | 'recommended' | 'optional';

export interface SchemaPropertyDefinition {
  name: string;
  /** The Schema.org expected type, shown in the UI so a merchant knows what shape to supply. */
  expects: string;
  requirement: PropertyRequirement;
  description: string;
  /** Preconfigured mapping for a built-in template. Omitted when no Shopify field fits and the
   * merchant must supply it — a default that cannot resolve would be noise, not help. */
  defaultSource?: ValueSource;
}

export type SchemaCategory =
  | 'Ecommerce'
  | 'Website & Organization'
  | 'Content'
  | 'FAQ & Q&A'
  | 'Business & Local'
  | 'Media';

export interface SchemaTypeDefinition {
  type: SchemaTypeName;
  category: SchemaCategory;
  description: string;
  /** Contexts this type can be rendered against. A type with none is nested-only, e.g. Offer. */
  contexts: SchemaContextKind[];
  /** True when this type is offered as a top-level built-in template rather than only as a
   * nested object inside another type. */
  builtIn: boolean;
  /** Google's documentation for this type, so a merchant can check the source rather than trust
   * a label. Omitted where Google documents no rich result for the type. */
  googleDocs?: string;
  properties: SchemaPropertyDefinition[];
}

const shopify = (path: string): ValueSource => ({ kind: 'shopify', path });

// ─── Ecommerce ───────────────────────────────────────────────────────

const OFFER: SchemaTypeDefinition = {
  type: 'Offer',
  category: 'Ecommerce',
  description: 'The price and availability of a product. This is the part that puts a price in the search result.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/product',
  properties: [
    { name: 'price', expects: 'Number', requirement: 'required', description: 'A number, not a formatted string — "1499", never "Rs 1,499".', defaultSource: shopify('variant.price') },
    { name: 'priceCurrency', expects: 'Text (ISO 4217)', requirement: 'required', description: 'Three-letter currency code, e.g. PKR.', defaultSource: shopify('shop.currency') },
    { name: 'availability', expects: 'ItemAvailability', requirement: 'recommended', description: 'A schema.org availability URL. Resolved from whether the variant is purchasable.', defaultSource: shopify('variant.availability') },
    { name: 'url', expects: 'URL', requirement: 'recommended', description: 'Where the offer can be bought.', defaultSource: shopify('product.url') },
    { name: 'itemCondition', expects: 'OfferItemCondition', requirement: 'optional', description: 'e.g. https://schema.org/NewCondition. Shopify has no condition field, so set it yourself if it is not new.' },
    { name: 'priceValidUntil', expects: 'Date', requirement: 'optional', description: 'When the price expires. Google warns on a date in the past, so leave it out unless it is real.' },
    { name: 'sku', expects: 'Text', requirement: 'optional', description: 'Stock code for this specific offer.', defaultSource: shopify('variant.sku') },
  ],
};

const AGGREGATE_RATING: SchemaTypeDefinition = {
  type: 'AggregateRating',
  category: 'Ecommerce',
  description: 'The average of a product\'s reviews. Produces the star rating in search results.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/review-snippet',
  properties: [
    { name: 'ratingValue', expects: 'Number', requirement: 'required', description: 'The average score. Must come from real reviews — Google penalises invented ratings.' },
    { name: 'reviewCount', expects: 'Integer', requirement: 'required', description: 'How many reviews the average is built from. Either this or ratingCount is required.' },
    { name: 'ratingCount', expects: 'Integer', requirement: 'optional', description: 'How many ratings were given, when that differs from the number of written reviews.' },
    { name: 'bestRating', expects: 'Number', requirement: 'optional', description: 'Top of the scale. Defaults to 5 when omitted.' },
    { name: 'worstRating', expects: 'Number', requirement: 'optional', description: 'Bottom of the scale. Defaults to 1 when omitted.' },
  ],
};

const REVIEW: SchemaTypeDefinition = {
  type: 'Review',
  category: 'Ecommerce',
  description: 'One customer review.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/review-snippet',
  properties: [
    { name: 'reviewRating', expects: 'Rating', requirement: 'required', description: 'The score this reviewer gave.' },
    { name: 'author', expects: 'Person or Organization', requirement: 'required', description: 'Who wrote it. Google rejects a review with no author.' },
    { name: 'reviewBody', expects: 'Text', requirement: 'recommended', description: 'What they wrote.' },
    { name: 'datePublished', expects: 'Date', requirement: 'optional', description: 'When the review was left.' },
  ],
};

const BRAND: SchemaTypeDefinition = {
  type: 'Brand',
  category: 'Ecommerce',
  description: 'The brand a product belongs to.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Brand name. Shopify\'s vendor field is the usual source.', defaultSource: shopify('product.vendor') },
    { name: 'url', expects: 'URL', requirement: 'optional', description: 'The brand\'s own site, if it has one.' },
    { name: 'logo', expects: 'URL', requirement: 'optional', description: 'Brand logo.' },
  ],
};

const MERCHANT_RETURN_POLICY: SchemaTypeDefinition = {
  type: 'MerchantReturnPolicy',
  category: 'Ecommerce',
  description: 'Your returns terms. Google shows these in shopping experiences.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/return-policy',
  properties: [
    { name: 'applicableCountry', expects: 'Text (ISO 3166-1)', requirement: 'required', description: 'Where the policy applies.', defaultSource: shopify('shop.country') },
    { name: 'returnPolicyCategory', expects: 'MerchantReturnEnumeration', requirement: 'required', description: 'e.g. https://schema.org/MerchantReturnFiniteReturnWindow.' },
    { name: 'merchantReturnDays', expects: 'Integer', requirement: 'recommended', description: 'Days the buyer has to return. Required when the category is a finite window.' },
    { name: 'returnMethod', expects: 'ReturnMethodEnumeration', requirement: 'optional', description: 'e.g. https://schema.org/ReturnByMail.' },
    { name: 'returnFees', expects: 'ReturnFeesEnumeration', requirement: 'optional', description: 'e.g. https://schema.org/FreeReturn.' },
  ],
};

const OFFER_SHIPPING_DETAILS: SchemaTypeDefinition = {
  type: 'OfferShippingDetails',
  category: 'Ecommerce',
  description: 'Shipping cost and delivery time for an offer.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/product',
  properties: [
    { name: 'shippingRate', expects: 'MonetaryAmount', requirement: 'required', description: 'What delivery costs. Google needs this before shipping details show at all.' },
    { name: 'shippingDestination', expects: 'DefinedRegion', requirement: 'required', description: 'Where you ship to. Required alongside shippingRate.' },
    { name: 'deliveryTime', expects: 'ShippingDeliveryTime', requirement: 'optional', description: 'Handling plus transit time.' },
  ],
};

const PRODUCT: SchemaTypeDefinition = {
  type: 'Product',
  category: 'Ecommerce',
  description: 'A single product. The most valuable schema on a Shopify store — it drives price, availability and rating in search results.',
  contexts: ['product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/product',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'The product name.', defaultSource: shopify('product.title') },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'Plain-text description. HTML is stripped — JSON-LD does not render markup.', defaultSource: shopify('product.description') },
    { name: 'image', expects: 'URL or ImageObject', requirement: 'recommended', description: 'Google prefers several images. Maps to every product image by default.', defaultSource: shopify('product.images') },
    { name: 'url', expects: 'URL', requirement: 'recommended', description: 'The product page.', defaultSource: shopify('product.url') },
    { name: 'sku', expects: 'Text', requirement: 'recommended', description: 'Your stock code.', defaultSource: shopify('variant.sku') },
    { name: 'gtin', expects: 'Text', requirement: 'recommended', description: 'Global trade number. Shopify keeps GTIN/EAN/UPC in the variant barcode field.', defaultSource: shopify('variant.barcode') },
    { name: 'mpn', expects: 'Text', requirement: 'optional', description: 'Manufacturer part number. Shopify has no field for this — map a metafield or type it.' },
    { name: 'brand', expects: 'Brand or Organization', requirement: 'recommended', description: 'Who makes it.', defaultSource: { kind: 'object', type: 'Brand', properties: { name: shopify('product.vendor') } } },
    { name: 'category', expects: 'Text', requirement: 'optional', description: 'Product category. Shopify\'s product type is the usual source.', defaultSource: shopify('product.type') },
    { name: 'color', expects: 'Text', requirement: 'optional', description: 'Colour, when it identifies the product rather than a variant.' },
    { name: 'material', expects: 'Text', requirement: 'optional', description: 'What it is made of.' },
    { name: 'offers', expects: 'Offer or AggregateOffer', requirement: 'required', description: 'Price and availability. Without this there is no product rich result.', defaultSource: { kind: 'object', type: 'Offer', properties: { price: shopify('variant.price'), priceCurrency: shopify('shop.currency'), availability: shopify('variant.availability'), url: shopify('product.url') } } },
    { name: 'aggregateRating', expects: 'AggregateRating', requirement: 'optional', description: 'Average review score. Only map this to a real review source — an invented rating is a manual-action risk.' },
    { name: 'review', expects: 'Review', requirement: 'optional', description: 'Individual reviews.' },
  ],
};

const AGGREGATE_OFFER: SchemaTypeDefinition = {
  type: 'AggregateOffer',
  category: 'Ecommerce',
  description: 'A price range, for a product sold at several prices — the honest shape for a multi-variant product.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'lowPrice', expects: 'Number', requirement: 'required', description: 'Cheapest variant.' },
    { name: 'highPrice', expects: 'Number', requirement: 'recommended', description: 'Most expensive variant.' },
    { name: 'priceCurrency', expects: 'Text (ISO 4217)', requirement: 'required', description: 'Currency for both.', defaultSource: shopify('shop.currency') },
    { name: 'offerCount', expects: 'Integer', requirement: 'recommended', description: 'How many variants are being summarised.' },
  ],
};

const PRODUCT_GROUP: SchemaTypeDefinition = {
  type: 'ProductGroup',
  category: 'Ecommerce',
  description: 'A product with variants, described as a group. Use this instead of Product when price or availability differs between variants — describing variant #1 as "the product" misstates every other one.',
  contexts: ['product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/product-variants',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'The group name.', defaultSource: shopify('product.title') },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'Plain-text description.', defaultSource: shopify('product.description') },
    { name: 'url', expects: 'URL', requirement: 'recommended', description: 'The product page.', defaultSource: shopify('product.url') },
    { name: 'brand', expects: 'Brand', requirement: 'recommended', description: 'Who makes it.', defaultSource: { kind: 'object', type: 'Brand', properties: { name: shopify('product.vendor') } } },
    { name: 'productGroupID', expects: 'Text', requirement: 'required', description: 'An identifier shared by every variant in the group.', defaultSource: shopify('product.handle') },
    { name: 'variesBy', expects: 'Text', requirement: 'recommended', description: 'Which properties differ between variants, e.g. https://schema.org/size.' },
    { name: 'hasVariant', expects: 'Product', requirement: 'required', description: 'The individual variants.' },
  ],
};

// ─── Website & Organization ──────────────────────────────────────────

const POSTAL_ADDRESS: SchemaTypeDefinition = {
  type: 'PostalAddress',
  category: 'Business & Local',
  description: 'A street address.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'streetAddress', expects: 'Text', requirement: 'required', description: 'Street and number.' },
    { name: 'addressLocality', expects: 'Text', requirement: 'required', description: 'City.' },
    { name: 'addressRegion', expects: 'Text', requirement: 'recommended', description: 'State or province.' },
    { name: 'postalCode', expects: 'Text', requirement: 'recommended', description: 'Postal or ZIP code.' },
    { name: 'addressCountry', expects: 'Text (ISO 3166-1)', requirement: 'required', description: 'Country.', defaultSource: shopify('shop.country') },
  ],
};

const GEO_COORDINATES: SchemaTypeDefinition = {
  type: 'GeoCoordinates',
  category: 'Business & Local',
  description: 'Latitude and longitude of a place.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'latitude', expects: 'Number', requirement: 'required', description: 'Decimal degrees.' },
    { name: 'longitude', expects: 'Number', requirement: 'required', description: 'Decimal degrees.' },
  ],
};

const OPENING_HOURS: SchemaTypeDefinition = {
  type: 'OpeningHoursSpecification',
  category: 'Business & Local',
  description: 'When a business is open.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'dayOfWeek', expects: 'DayOfWeek', requirement: 'required', description: 'e.g. https://schema.org/Monday.' },
    { name: 'opens', expects: 'Time', requirement: 'required', description: '24-hour time, e.g. 09:00.' },
    { name: 'closes', expects: 'Time', requirement: 'required', description: '24-hour time, e.g. 18:00.' },
  ],
};

const ORGANIZATION: SchemaTypeDefinition = {
  type: 'Organization',
  category: 'Website & Organization',
  description: 'The business behind the store. Feeds the knowledge panel and the logo shown beside your results.',
  contexts: ['shop'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Business name.', defaultSource: shopify('shop.name') },
    { name: 'url', expects: 'URL', requirement: 'required', description: 'Your storefront.', defaultSource: shopify('shop.url') },
    { name: 'logo', expects: 'URL or ImageObject', requirement: 'recommended', description: 'Square logo, at least 112x112px. Shopify has no logo field the Admin API exposes, so supply the URL.' },
    { name: 'email', expects: 'Text', requirement: 'optional', description: 'Public contact address.', defaultSource: shopify('shop.email') },
    { name: 'telephone', expects: 'Text', requirement: 'optional', description: 'Public phone number, with country code.' },
    { name: 'sameAs', expects: 'URL', requirement: 'recommended', description: 'Your social profiles. This is how Google links the store to its accounts.' },
    { name: 'address', expects: 'PostalAddress', requirement: 'optional', description: 'Registered or trading address.' },
  ],
};

const ONLINE_STORE: SchemaTypeDefinition = {
  type: 'OnlineStore',
  category: 'Website & Organization',
  description: 'An Organization that sells online. More specific than Organization, and the accurate type for a Shopify store.',
  contexts: ['shop'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
  properties: ORGANIZATION.properties,
};

const WEBSITE: SchemaTypeDefinition = {
  type: 'WebSite',
  category: 'Website & Organization',
  description: 'The site as a whole. Carries the sitelinks search box when a search action is configured.',
  contexts: ['shop'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/sitelinks-searchbox',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Site name.', defaultSource: shopify('shop.name') },
    { name: 'url', expects: 'URL', requirement: 'required', description: 'Site root.', defaultSource: shopify('shop.url') },
    { name: 'potentialAction', expects: 'SearchAction', requirement: 'optional', description: 'Declares your search URL so Google can offer a search box.' },
  ],
};

function webPageType(type: string, description: string, contexts: SchemaContextKind[], builtIn: boolean): SchemaTypeDefinition {
  return {
    type,
    category: 'Website & Organization',
    description,
    contexts,
    builtIn,
    properties: [
      { name: 'name', expects: 'Text', requirement: 'required', description: 'Page title.' },
      { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What the page is about.' },
      { name: 'url', expects: 'URL', requirement: 'required', description: 'The page URL.' },
      { name: 'breadcrumb', expects: 'BreadcrumbList', requirement: 'optional', description: 'Where the page sits in the site.' },
    ],
  };
}

const BREADCRUMB_LIST: SchemaTypeDefinition = {
  type: 'BreadcrumbList',
  category: 'Website & Organization',
  description: 'The trail above a page. Replaces the bare URL in search results with a readable path.',
  contexts: ['product', 'collection', 'page', 'article'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
  properties: [
    { name: 'itemListElement', expects: 'ListItem', requirement: 'required', description: 'The ordered steps of the trail. Each needs a position, a name and a URL.' },
  ],
};

// ─── Content ─────────────────────────────────────────────────────────

function articleType(type: string, description: string): SchemaTypeDefinition {
  return {
    type,
    category: 'Content',
    description,
    contexts: ['article'],
    builtIn: true,
    googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/article',
    properties: [
      { name: 'headline', expects: 'Text', requirement: 'required', description: 'The title. Google truncates past 110 characters.', defaultSource: shopify('article.title') },
      { name: 'description', expects: 'Text', requirement: 'recommended', description: 'Plain-text summary.', defaultSource: shopify('article.description') },
      { name: 'image', expects: 'URL or ImageObject', requirement: 'recommended', description: 'Article image.', defaultSource: shopify('article.image') },
      { name: 'datePublished', expects: 'DateTime', requirement: 'recommended', description: 'When it went live.', defaultSource: shopify('article.published_at') },
      { name: 'dateModified', expects: 'DateTime', requirement: 'recommended', description: 'Last edit.', defaultSource: shopify('article.updated_at') },
      { name: 'author', expects: 'Person or Organization', requirement: 'recommended', description: 'Who wrote it. Google documents this as required for article rich results.' },
      { name: 'publisher', expects: 'Organization', requirement: 'recommended', description: 'The site publishing it.', defaultSource: { kind: 'object', type: 'Organization', properties: { name: shopify('shop.name'), url: shopify('shop.url') } } },
      { name: 'mainEntityOfPage', expects: 'URL', requirement: 'optional', description: 'The canonical page for this article.', defaultSource: shopify('article.url') },
    ],
  };
}

const IMAGE_OBJECT: SchemaTypeDefinition = {
  type: 'ImageObject',
  category: 'Media',
  description: 'An image, described rather than just linked.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'url', expects: 'URL', requirement: 'required', description: 'The image file.' },
    { name: 'caption', expects: 'Text', requirement: 'optional', description: 'What it shows.' },
    { name: 'width', expects: 'Number', requirement: 'optional', description: 'Pixels.' },
    { name: 'height', expects: 'Number', requirement: 'optional', description: 'Pixels.' },
  ],
};

const VIDEO_OBJECT: SchemaTypeDefinition = {
  type: 'VideoObject',
  category: 'Media',
  description: 'A video. Required for video rich results and Google video search.',
  contexts: ['product', 'page', 'article'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/video',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Video title.' },
    { name: 'description', expects: 'Text', requirement: 'required', description: 'What the video shows.' },
    { name: 'thumbnailUrl', expects: 'URL', requirement: 'required', description: 'Preview image.' },
    { name: 'uploadDate', expects: 'DateTime', requirement: 'required', description: 'When it was published, with timezone.' },
    { name: 'duration', expects: 'Duration (ISO 8601)', requirement: 'recommended', description: 'e.g. PT1M30S.' },
    { name: 'contentUrl', expects: 'URL', requirement: 'recommended', description: 'The video file itself.' },
    { name: 'embedUrl', expects: 'URL', requirement: 'optional', description: 'A player URL.' },
  ],
};

// ─── FAQ & Q&A ───────────────────────────────────────────────────────
// FAQPage and QAPage are DIFFERENT things and Google treats them differently. FAQPage is a page
// where the SITE publishes both question and answer; QAPage is a page where USERS ask and answer,
// with one accepted answer among several. Using FAQPage for a user forum — or QAPage for a help
// page — is a structured-data error, not a stylistic choice, so they are separate entries here.

const ANSWER: SchemaTypeDefinition = {
  type: 'Answer',
  category: 'FAQ & Q&A',
  description: 'An answer to a question.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'text', expects: 'Text', requirement: 'required', description: 'The answer. May contain basic HTML.' },
    { name: 'url', expects: 'URL', requirement: 'optional', description: 'A link to the answer on the page.' },
    { name: 'upvoteCount', expects: 'Integer', requirement: 'optional', description: 'QAPage only — how many people found it useful.' },
  ],
};

const QUESTION: SchemaTypeDefinition = {
  type: 'Question',
  category: 'FAQ & Q&A',
  description: 'A question with its answer.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'The question itself.' },
    { name: 'acceptedAnswer', expects: 'Answer', requirement: 'required', description: 'The answer. On a QAPage this is the one marked accepted.' },
    { name: 'suggestedAnswer', expects: 'Answer', requirement: 'optional', description: 'QAPage only — other answers that were not accepted.' },
    { name: 'answerCount', expects: 'Integer', requirement: 'optional', description: 'QAPage only — how many answers exist.' },
  ],
};

const FAQ_PAGE: SchemaTypeDefinition = {
  type: 'FAQPage',
  category: 'FAQ & Q&A',
  description: 'A page where YOU publish both the questions and the answers — a help or shipping-info page. Not for pages where customers post answers.',
  contexts: ['page', 'product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage',
  properties: [
    { name: 'mainEntity', expects: 'Question', requirement: 'required', description: 'The questions on the page. Every one needs an acceptedAnswer.' },
  ],
};

const QA_PAGE: SchemaTypeDefinition = {
  type: 'QAPage',
  category: 'FAQ & Q&A',
  description: 'A page where CUSTOMERS ask and answer — a product Q&A widget or forum thread. Exactly one question per page, with one accepted answer among several.',
  contexts: ['page', 'product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/qapage',
  properties: [
    { name: 'mainEntity', expects: 'Question', requirement: 'required', description: 'The single question this page is about. A QAPage with several questions is invalid — use FAQPage instead.' },
  ],
};

// ─── Business & Local ────────────────────────────────────────────────
// Google reads the MOST SPECIFIC type it is given, so a bakery marked up as LocalBusiness loses
// the detail a Bakery type would have carried. Each subtype is therefore offered in its own right
// rather than every business being pushed through the generic parent.

function localBusinessType(type: string, description: string, builtIn: boolean): SchemaTypeDefinition {
  return {
    type,
    category: 'Business & Local',
    description,
    contexts: ['shop'],
    builtIn,
    googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/local-business',
    properties: [
      { name: 'name', expects: 'Text', requirement: 'required', description: 'Business name.', defaultSource: shopify('shop.name') },
      { name: 'address', expects: 'PostalAddress', requirement: 'required', description: 'Street address. Google will not show a local result without it.' },
      { name: 'url', expects: 'URL', requirement: 'recommended', description: 'Your site.', defaultSource: shopify('shop.url') },
      { name: 'telephone', expects: 'Text', requirement: 'recommended', description: 'Public phone number with country code.' },
      { name: 'email', expects: 'Text', requirement: 'optional', description: 'Public contact address.', defaultSource: shopify('shop.email') },
      { name: 'image', expects: 'URL', requirement: 'recommended', description: 'A photo of the business.' },
      { name: 'geo', expects: 'GeoCoordinates', requirement: 'optional', description: 'Latitude and longitude.' },
      { name: 'openingHoursSpecification', expects: 'OpeningHoursSpecification', requirement: 'recommended', description: 'When you are open.' },
      { name: 'priceRange', expects: 'Text', requirement: 'optional', description: 'e.g. $$.' },
    ],
  };
}

// ─── Education, jobs, events, food, software ─────────────────────────
// Each of these has its own Google rich result, and each is a real thing a Shopify store
// publishes — a supplement brand runs courses and posts recipes, a growing one posts jobs. They
// are entries in this list rather than code because that is what keeps coverage extensible.

const HOW_TO: SchemaTypeDefinition = {
  type: 'HowTo',
  category: 'Content',
  description: 'Step-by-step instructions — "how to use this supplement", "how to fit this part".',
  contexts: ['page', 'article', 'product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/how-to',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'What the instructions achieve.' },
    { name: 'step', expects: 'HowToStep', requirement: 'required', description: 'The ordered steps. Each needs text; a name and image help.' },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'A summary of the process.' },
    { name: 'totalTime', expects: 'Duration (ISO 8601)', requirement: 'optional', description: 'e.g. PT30M.' },
    { name: 'supply', expects: 'HowToSupply', requirement: 'optional', description: 'What gets used up.' },
    { name: 'tool', expects: 'HowToTool', requirement: 'optional', description: 'What is needed but not consumed.' },
  ],
};

const COURSE: SchemaTypeDefinition = {
  type: 'Course',
  category: 'Content',
  description: 'A course of instruction.',
  contexts: ['page', 'product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/course',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Course title.' },
    { name: 'description', expects: 'Text', requirement: 'required', description: 'What the course covers.' },
    { name: 'provider', expects: 'Organization', requirement: 'required', description: 'Who runs it.', defaultSource: { kind: 'object', type: 'Organization', properties: { name: shopify('shop.name'), url: shopify('shop.url') } } },
    { name: 'hasCourseInstance', expects: 'CourseInstance', requirement: 'optional', description: 'Specific runs of the course.' },
    { name: 'offers', expects: 'Offer', requirement: 'optional', description: 'What it costs.' },
  ],
};

const COURSE_INSTANCE: SchemaTypeDefinition = {
  type: 'CourseInstance',
  category: 'Content',
  description: 'One scheduled run of a course.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'courseMode', expects: 'Text', requirement: 'required', description: 'e.g. Online, Onsite. Google needs it to tell an instance apart from the course itself.' },
    { name: 'startDate', expects: 'Date', requirement: 'required', description: 'When this run begins. An instance with no date is just the course again.' },
    { name: 'endDate', expects: 'Date', requirement: 'optional', description: 'When it ends.' },
    { name: 'location', expects: 'Place or VirtualLocation', requirement: 'optional', description: 'Where it happens.' },
  ],
};

const JOB_POSTING: SchemaTypeDefinition = {
  type: 'JobPosting',
  category: 'Content',
  description: 'A job opening. Feeds Google for Jobs.',
  contexts: ['page'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting',
  properties: [
    { name: 'title', expects: 'Text', requirement: 'required', description: 'The role, e.g. "Warehouse Assistant". Not the posting headline.' },
    { name: 'description', expects: 'Text', requirement: 'required', description: 'The full description. HTML is allowed here.' },
    { name: 'datePosted', expects: 'Date', requirement: 'required', description: 'When it was published.' },
    { name: 'hiringOrganization', expects: 'Organization', requirement: 'required', description: 'Who is hiring.', defaultSource: { kind: 'object', type: 'Organization', properties: { name: shopify('shop.name'), url: shopify('shop.url') } } },
    { name: 'jobLocation', expects: 'Place', requirement: 'required', description: 'Where the work happens. Omit only for a fully remote role.' },
    { name: 'validThrough', expects: 'Date', requirement: 'recommended', description: 'When the posting expires. Google drops expired postings.' },
    { name: 'employmentType', expects: 'Text', requirement: 'optional', description: 'e.g. FULL_TIME, PART_TIME.' },
    { name: 'baseSalary', expects: 'MonetaryAmount', requirement: 'optional', description: 'Pay.' },
  ],
};

function eventType(type: string, description: string, builtIn: boolean): SchemaTypeDefinition {
  return {
    type,
    category: 'Content',
    description,
    contexts: ['page'],
    builtIn,
    googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/event',
    properties: [
      { name: 'name', expects: 'Text', requirement: 'required', description: 'Event name.' },
      { name: 'startDate', expects: 'DateTime', requirement: 'required', description: 'Start, with timezone offset.' },
      { name: 'location', expects: 'Place or VirtualLocation', requirement: 'required', description: 'Where it happens. Online events use VirtualLocation.' },
      { name: 'endDate', expects: 'DateTime', requirement: 'recommended', description: 'End, with timezone offset.' },
      { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it is.' },
      { name: 'image', expects: 'URL', requirement: 'recommended', description: 'Event image.' },
      { name: 'offers', expects: 'Offer', requirement: 'optional', description: 'Tickets.' },
      { name: 'organizer', expects: 'Organization', requirement: 'optional', description: 'Who runs it.', defaultSource: { kind: 'object', type: 'Organization', properties: { name: shopify('shop.name'), url: shopify('shop.url') } } },
    ],
  };
}

const NUTRITION_INFORMATION: SchemaTypeDefinition = {
  type: 'NutritionInformation',
  category: 'Content',
  description: 'Nutrition facts for a recipe or food product.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'calories', expects: 'Energy', requirement: 'required', description: 'e.g. "240 calories". This is the one Google surfaces — a nutrition block without it shows nothing.' },
    { name: 'servingSize', expects: 'Text', requirement: 'optional', description: 'What one serving is.' },
    { name: 'proteinContent', expects: 'Mass', requirement: 'optional', description: 'e.g. "12 g".' },
    { name: 'fatContent', expects: 'Mass', requirement: 'optional', description: 'e.g. "3 g".' },
    { name: 'carbohydrateContent', expects: 'Mass', requirement: 'optional', description: 'e.g. "30 g".' },
    { name: 'sugarContent', expects: 'Mass', requirement: 'optional', description: 'e.g. "8 g".' },
  ],
};

const RECIPE: SchemaTypeDefinition = {
  type: 'Recipe',
  category: 'Content',
  description: 'A recipe. Common on supplement and food stores, and it has its own rich result.',
  contexts: ['article', 'page', 'product'],
  builtIn: true,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/recipe',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Recipe name.' },
    { name: 'image', expects: 'URL', requirement: 'required', description: 'A photo of the finished dish.' },
    { name: 'recipeIngredient', expects: 'Text', requirement: 'required', description: 'One entry per ingredient, with quantity.' },
    { name: 'recipeInstructions', expects: 'HowToStep', requirement: 'required', description: 'The steps, in order.' },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it is.' },
    { name: 'prepTime', expects: 'Duration (ISO 8601)', requirement: 'optional', description: 'e.g. PT15M.' },
    { name: 'cookTime', expects: 'Duration (ISO 8601)', requirement: 'optional', description: 'e.g. PT30M.' },
    { name: 'recipeYield', expects: 'Text', requirement: 'optional', description: 'e.g. "4 servings".' },
    { name: 'nutrition', expects: 'NutritionInformation', requirement: 'optional', description: 'Nutrition facts.' },
    { name: 'aggregateRating', expects: 'AggregateRating', requirement: 'optional', description: 'Real ratings only.' },
  ],
};

function softwareType(type: string, description: string, builtIn: boolean): SchemaTypeDefinition {
  return {
    type,
    category: 'Content',
    description,
    contexts: ['page', 'product'],
    builtIn,
    googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/software-app',
    properties: [
      { name: 'name', expects: 'Text', requirement: 'required', description: 'Application name.' },
      { name: 'offers', expects: 'Offer', requirement: 'required', description: 'Price. Use 0 for a free app.' },
      { name: 'applicationCategory', expects: 'Text', requirement: 'required', description: 'e.g. HealthApplication.' },
      { name: 'operatingSystem', expects: 'Text', requirement: 'recommended', description: 'e.g. Android, iOS.' },
      { name: 'aggregateRating', expects: 'AggregateRating', requirement: 'optional', description: 'Real ratings only.' },
    ],
  };
}

const AUDIO_OBJECT: SchemaTypeDefinition = {
  type: 'AudioObject',
  category: 'Media',
  description: 'An audio file — a podcast episode or product audio guide.',
  contexts: ['page', 'article'],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Title.' },
    { name: 'contentUrl', expects: 'URL', requirement: 'required', description: 'The audio file.' },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it covers.' },
    { name: 'duration', expects: 'Duration (ISO 8601)', requirement: 'optional', description: 'e.g. PT22M.' },
    { name: 'uploadDate', expects: 'Date', requirement: 'optional', description: 'When it was published.' },
  ],
};

const PLACE: SchemaTypeDefinition = {
  type: 'Place',
  category: 'Business & Local',
  description: 'A physical location.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'recommended', description: 'What the place is called.' },
    { name: 'address', expects: 'PostalAddress', requirement: 'required', description: 'Where it is.' },
    { name: 'geo', expects: 'GeoCoordinates', requirement: 'optional', description: 'Latitude and longitude.' },
  ],
};

const CREATIVE_WORK: SchemaTypeDefinition = {
  type: 'CreativeWork',
  category: 'Content',
  description: 'A generic created work, for content none of the more specific types fits.',
  contexts: ['page', 'article'],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'Title.' },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it is.' },
    { name: 'author', expects: 'Person or Organization', requirement: 'optional', description: 'Who made it.' },
    { name: 'datePublished', expects: 'Date', requirement: 'optional', description: 'When it was published.' },
    { name: 'url', expects: 'URL', requirement: 'optional', description: 'Where it lives.' },
  ],
};

// ─── Remaining required coverage ─────────────────────────────────────

const INDIVIDUAL_PRODUCT: SchemaTypeDefinition = {
  type: 'IndividualProduct',
  category: 'Ecommerce',
  description: 'One specific physical item rather than a product line — a serial-numbered or one-of-a-kind piece.',
  contexts: ['product'],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'The item.', defaultSource: shopify('product.title') },
    { name: 'serialNumber', expects: 'Text', requirement: 'recommended', description: 'What identifies this exact item. Shopify\'s SKU is the usual source.', defaultSource: shopify('variant.sku') },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'Plain-text description.', defaultSource: shopify('product.description') },
    { name: 'offers', expects: 'Offer', requirement: 'recommended', description: 'Price and availability.', defaultSource: { kind: 'object', type: 'Offer', properties: { price: shopify('variant.price'), priceCurrency: shopify('shop.currency'), availability: shopify('variant.availability') } } },
  ],
};

const REPORT: SchemaTypeDefinition = {
  type: 'Report',
  category: 'Content',
  description: 'A report — a study, white paper or published findings. Published as a blog article on Shopify.',
  contexts: ['article'],
  builtIn: false,
  properties: [
    { name: 'headline', expects: 'Text', requirement: 'required', description: 'The report title.', defaultSource: shopify('article.title') },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it covers.', defaultSource: shopify('article.description') },
    { name: 'datePublished', expects: 'Date', requirement: 'recommended', description: 'Publication date.', defaultSource: shopify('article.published_at') },
    { name: 'author', expects: 'Person or Organization', requirement: 'recommended', description: 'Who produced it.' },
    { name: 'reportNumber', expects: 'Text', requirement: 'optional', description: 'An identifying number, if the report has one.' },
  ],
};

const CLIP: SchemaTypeDefinition = {
  type: 'Clip',
  category: 'Media',
  description: 'A named segment within a video — what produces "key moments" under a video result.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/video',
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'What this segment covers.' },
    { name: 'startOffset', expects: 'Number', requirement: 'required', description: 'Seconds from the start of the video.' },
    { name: 'endOffset', expects: 'Number', requirement: 'recommended', description: 'Seconds from the start, where the segment ends.' },
    { name: 'url', expects: 'URL', requirement: 'required', description: 'A deep link to this timestamp.' },
  ],
};

const BROADCAST_EVENT: SchemaTypeDefinition = {
  type: 'BroadcastEvent',
  category: 'Media',
  description: 'A live broadcast of a video — a launch stream or live shopping event.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/video',
  properties: [
    { name: 'isLiveBroadcast', expects: 'Boolean', requirement: 'required', description: 'True while it is live.' },
    { name: 'startDate', expects: 'DateTime', requirement: 'required', description: 'When the stream starts, with timezone.' },
    { name: 'endDate', expects: 'DateTime', requirement: 'recommended', description: 'When it ends.' },
    { name: 'name', expects: 'Text', requirement: 'optional', description: 'What the broadcast is called.' },
  ],
};

const LIVE_BLOG_POSTING: SchemaTypeDefinition = {
  type: 'LiveBlogPosting',
  category: 'Content',
  description: 'A post updated live as an event unfolds — a launch-day or sale-day running commentary.',
  contexts: ['article'],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/article',
  properties: [
    { name: 'headline', expects: 'Text', requirement: 'required', description: 'The title.', defaultSource: shopify('article.title') },
    { name: 'coverageStartTime', expects: 'DateTime', requirement: 'required', description: 'When live coverage began.' },
    { name: 'coverageEndTime', expects: 'DateTime', requirement: 'recommended', description: 'When it ended. Leave out while still running.' },
    { name: 'liveBlogUpdate', expects: 'BlogPosting', requirement: 'recommended', description: 'The individual updates, newest first.' },
    { name: 'datePublished', expects: 'DateTime', requirement: 'recommended', description: 'When the post went live.', defaultSource: shopify('article.published_at') },
  ],
};

const LEARNING_RESOURCE: SchemaTypeDefinition = {
  type: 'LearningResource',
  category: 'Content',
  description: 'Material made for learning — a guide, worksheet or training module.',
  contexts: ['page', 'article'],
  builtIn: false,
  properties: [
    { name: 'name', expects: 'Text', requirement: 'required', description: 'What the resource is called.' },
    { name: 'description', expects: 'Text', requirement: 'recommended', description: 'What it teaches.' },
    { name: 'learningResourceType', expects: 'Text', requirement: 'recommended', description: 'e.g. Guide, Worksheet, Course material.' },
    { name: 'educationalLevel', expects: 'Text', requirement: 'optional', description: 'Who it is pitched at.' },
    { name: 'teaches', expects: 'Text', requirement: 'optional', description: 'The skill or knowledge it imparts.' },
  ],
};

const OCCUPATIONAL_EXPERIENCE: SchemaTypeDefinition = {
  type: 'OccupationalExperienceRequirements',
  category: 'Content',
  description: 'How much work experience a job asks for. Nested inside JobPosting.',
  contexts: [],
  builtIn: false,
  googleDocs: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting',
  properties: [
    { name: 'monthsOfExperience', expects: 'Number', requirement: 'required', description: 'Months of relevant experience required.' },
  ],
};

const EDUCATIONAL_CREDENTIAL: SchemaTypeDefinition = {
  type: 'EducationalOccupationalCredential',
  category: 'Content',
  description: 'A qualification a job requires or a course awards.',
  contexts: [],
  builtIn: false,
  properties: [
    { name: 'credentialCategory', expects: 'Text', requirement: 'required', description: 'e.g. degree, certificate, high school.' },
    { name: 'name', expects: 'Text', requirement: 'optional', description: 'What the credential is called.' },
    { name: 'educationalLevel', expects: 'Text', requirement: 'optional', description: 'The level it sits at.' },
  ],
};

export const SCHEMA_LIBRARY: SchemaTypeDefinition[] = [
  // Ecommerce
  PRODUCT,
  PRODUCT_GROUP,
  OFFER,
  AGGREGATE_OFFER,
  AGGREGATE_RATING,
  REVIEW,
  BRAND,
  MERCHANT_RETURN_POLICY,
  OFFER_SHIPPING_DETAILS,
  // Website & Organization
  ORGANIZATION,
  ONLINE_STORE,
  WEBSITE,
  BREADCRUMB_LIST,
  webPageType('WebPage', 'A generic page.', ['page'], true),
  webPageType('AboutPage', 'An about-us page.', ['page'], true),
  webPageType('ContactPage', 'A contact page.', ['page'], true),
  webPageType('CollectionPage', 'A page listing several items — a Shopify collection.', ['collection'], true),
  webPageType('SearchResultsPage', 'A search results page.', ['page'], false),
  webPageType('ProfilePage', 'A profile page for a person or organization.', ['page'], false),
  // Content
  articleType('Article', 'A general article.'),
  articleType('BlogPosting', 'A blog post. The right type for Shopify blog articles.'),
  articleType('NewsArticle', 'A news story.'),
  articleType('TechArticle', 'A technical or how-to article.'),
  // Media
  IMAGE_OBJECT,
  VIDEO_OBJECT,
  // FAQ & Q&A
  FAQ_PAGE,
  QA_PAGE,
  QUESTION,
  ANSWER,
  // Business & Local
  POSTAL_ADDRESS,
  GEO_COORDINATES,
  OPENING_HOURS,
  localBusinessType('LocalBusiness', 'A business with a physical location. Prefer a more specific type below when one fits.', true),
  localBusinessType('Store', 'A retail shop.', true),
  localBusinessType('Restaurant', 'A restaurant.', false),
  localBusinessType('FoodEstablishment', 'A food business — cafe, bakery, takeaway.', false),
  localBusinessType('MedicalBusiness', 'A medical or health business.', false),
  localBusinessType('ProfessionalService', 'A professional services business.', false),
  localBusinessType('FinancialService', 'A financial services business.', false),
  localBusinessType('AutomotiveBusiness', 'An automotive business.', false),
  localBusinessType('LodgingBusiness', 'A hotel or other lodging.', false),
  PLACE,
  // Education, jobs, events, food, software
  HOW_TO,
  COURSE,
  COURSE_INSTANCE,
  JOB_POSTING,
  eventType('Event', 'A scheduled event.', true),
  eventType('BusinessEvent', 'A business event or trade show.', false),
  eventType('EducationEvent', 'A class, workshop or webinar.', false),
  eventType('Festival', 'A festival.', false),
  eventType('SocialEvent', 'A social gathering.', false),
  eventType('SportsEvent', 'A sporting event.', false),
  eventType('ScreeningEvent', 'A film or video screening.', false),
  RECIPE,
  NUTRITION_INFORMATION,
  softwareType('SoftwareApplication', 'A software application.', true),
  softwareType('MobileApplication', 'A mobile app.', false),
  softwareType('WebApplication', 'A web app.', false),
  AUDIO_OBJECT,
  CREATIVE_WORK,
  // Remaining required coverage
  INDIVIDUAL_PRODUCT,
  REPORT,
  CLIP,
  BROADCAST_EVENT,
  LIVE_BLOG_POSTING,
  LEARNING_RESOURCE,
  OCCUPATIONAL_EXPERIENCE,
  EDUCATIONAL_CREDENTIAL,
];

const BY_TYPE = new Map(SCHEMA_LIBRARY.map((definition) => [definition.type, definition]));

export function findSchemaType(type: SchemaTypeName): SchemaTypeDefinition | null {
  return BY_TYPE.get(type) ?? null;
}

/** Types offered as top-level templates for a context. */
export function builtInTypesForContext(context: SchemaContextKind): SchemaTypeDefinition[] {
  return SCHEMA_LIBRARY.filter((definition) => definition.builtIn && definition.contexts.includes(context));
}

/** Builds a template preconfigured from the library's defaults — what "enable Product schema"
 * produces before the merchant changes anything. */
export function defaultTemplateFor(type: SchemaTypeName, context: SchemaContextKind) {
  const definition = findSchemaType(type);
  if (!definition) return null;

  const properties: Record<string, ValueSource> = {};
  for (const property of definition.properties) {
    properties[property.name] = property.defaultSource ?? { kind: 'none' };
  }
  return { type, context, enabled: false, properties };
}
