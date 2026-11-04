export type PageSettingValue = string | boolean;

export interface PageSettingField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'toggle' | 'url';
  source: 'Merchant config' | 'Shopify' | 'Generated';
  placeholder?: string;
  description?: string;
  options?: readonly string[];
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface PageSettingsSection {
  id: string;
  title: string;
  description?: string;
  fields: PageSettingField[];
}

export interface PageSettingsDefinition {
  title: string;
  description: string;
  sections: PageSettingsSection[];
}

function buildDefaultsFromDefinition(definition: PageSettingsDefinition): Record<string, PageSettingValue> {
  return definition.sections.reduce<Record<string, PageSettingValue>>((acc, section) => {
    for (const field of section.fields) {
      if (field.type === 'toggle') acc[field.key] = false;
      else if (field.type === 'select') acc[field.key] = field.options?.[0] ?? '';
      else acc[field.key] = '';
    }
    return acc;
  }, {});
}

export const schemaPageSettingsDefinition: PageSettingsDefinition = {
  title: 'Schema / JSON-LD settings',
  description: 'Configure the business profile and structured-data defaults used for your store schema.',
  sections: [
    {
      id: 'business',
      title: 'Business profile',
      description: 'Support the brand and contact details that Rankvora AI uses in Organization and LocalBusiness markup.',
      fields: [
        {
          key: 'organizationName',
          label: 'Business name',
          type: 'text',
          source: 'Merchant config',
          placeholder: 'Rankvora AI Store',
          description: 'Shown as the Organization name in generated schema.',
        },
        {
          key: 'websiteUrl',
          label: 'Website URL',
          type: 'url',
          source: 'Shopify',
          placeholder: 'https://www.example.com',
          description: 'Used as the canonical website URL for schema output.',
        },
        {
          key: 'logoUrl',
          label: 'Logo URL',
          type: 'url',
          source: 'Merchant config',
          placeholder: 'https://cdn.example.com/logo.png',
          description: 'Optional but recommended for Organization and LocalBusiness markup.',
        },
        {
          key: 'supportEmail',
          label: 'Support email',
          type: 'text',
          source: 'Merchant config',
          placeholder: 'support@example.com',
          description: 'Used for supported contact schema when present.',
        },
      ],
    },
    {
      id: 'schema-behavior',
      title: 'Structured data behavior',
      description: 'Choose which generated JSON-LD types should be included for supported pages.',
      fields: [
        {
          key: 'productSchemaEnabled',
          label: 'Product schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Enable Product structured data for eligible product pages.',
        },
        {
          key: 'productGroupSchemaEnabled',
          label: 'ProductGroup schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Connect variant URLs and options to their parent product when valid variant data exists.',
        },
        {
          key: 'offerDataEnabled',
          label: 'Product offer data',
          type: 'toggle',
          source: 'Shopify',
          description: 'Include price, currency, availability, and shipping data inside eligible Product markup.',
        },
        {
          key: 'aggregateRatingEnabled',
          label: 'Aggregate rating data',
          type: 'toggle',
          source: 'Merchant config',
          description: 'Include genuine visible review summaries inside Product markup when a review source is connected.',
        },
        {
          key: 'organizationSchemaEnabled',
          label: 'Organization schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Include Organization schema with the configured brand details.',
        },
        {
          key: 'websiteSchemaEnabled',
          label: 'WebSite schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Include store-level WebSite identity and search-action data where supported.',
        },
        {
          key: 'collectionSchemaEnabled',
          label: 'CollectionPage and ItemList schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Add collection context and product listing markup to eligible Shopify collection pages.',
        },
        {
          key: 'faqSchemaEnabled',
          label: 'FAQ schema',
          type: 'toggle',
          source: 'Merchant config',
          description: 'Generate FAQ markup only when a real FAQ block is present on the page.',
        },
        {
          key: 'breadcrumbSchemaEnabled',
          label: 'Breadcrumb schema',
          type: 'toggle',
          source: 'Generated',
          description: 'Attach breadcrumb markup to pages with a valid navigation trail.',
        },
      ],
    },
    {
      id: 'faq',
      title: 'FAQ defaults',
      description: 'These values are used as defaults for the FAQ generator and can be refined before publish.',
      fields: [
        {
          key: 'faqPrompt',
          label: 'FAQ default question',
          type: 'textarea',
          source: 'Merchant config',
          placeholder: 'How quickly can I receive my order?',
          maxLength: 220,
          description: 'Used when a page has a supported FAQ pattern but the text is still being reviewed.',
        },
        {
          key: 'schemaOutputMode',
          label: 'JSON-LD output mode',
          type: 'select',
          source: 'Generated',
          options: ['Draft preview', 'Ready to publish', 'Manual review'],
          description: 'Controls how the generated markup is presented before applying to a page.',
        },
      ],
    },
  ],
};

export const defaultSchemaPageSettings: Record<string, PageSettingValue> = {
  organizationName: 'Rankvora AI Store',
  websiteUrl: 'https://www.example.com',
  logoUrl: 'https://www.example.com/logo.png',
  supportEmail: 'support@example.com',
  productSchemaEnabled: true,
  productGroupSchemaEnabled: true,
  offerDataEnabled: true,
  aggregateRatingEnabled: true,
  organizationSchemaEnabled: true,
  websiteSchemaEnabled: true,
  collectionSchemaEnabled: true,
  faqSchemaEnabled: false,
  breadcrumbSchemaEnabled: true,
  faqPrompt: 'How quickly can I receive my order?',
  schemaOutputMode: 'Draft preview',
};

export const subPillarSettingsRegistry: Record<string, PageSettingsDefinition> = {
  schema: schemaPageSettingsDefinition,
  'title-tags': {
    title: 'Title tag settings',
    description: 'Title behavior for supported page types and templates.',
    sections: [
      { id: 'templates', title: 'Title templates', description: 'Use the template that matches your business language.', fields: [
        { key: 'titleTemplate', label: 'Title template', type: 'text', source: 'Merchant config', placeholder: '{product_title} | {brand}', description: 'Default format used for eligible titles.' },
        { key: 'titleBrand', label: 'Brand suffix', type: 'text', source: 'Merchant config', placeholder: 'Rankvora AI Store', description: 'Appended to supported product and collection titles.' },
      ] },
      { id: 'rules', title: 'Display rules', description: 'Set the default title rules Rankvora AI should use.', fields: [
        { key: 'titlePreview', label: 'Preview mode', type: 'select', source: 'Generated', options: ['Draft preview', 'Live preview', 'Manual review'], description: 'Controls how titles are reviewed before publishing.' },
        { key: 'titleFallback', label: 'Fallback behavior', type: 'toggle', source: 'Merchant config', description: 'Use the store name when a title is missing or too short.' },
      ] },
    ],
  },
  'meta-descriptions': {
    title: 'Meta description settings',
    description: 'Description templates and validation defaults.',
    sections: [
      { id: 'descriptions', title: 'Description templates', description: 'Define the default copy structure for supported pages.', fields: [
        { key: 'metaTemplate', label: 'Description template', type: 'textarea', source: 'Merchant config', placeholder: '{product_title} with fast shipping, easy returns, and trusted support.', maxLength: 180, description: 'Used when no custom merchant copy is available.' },
      ] },
      { id: 'quality', title: 'Quality rules', description: 'Set the validation and preview preferences for this sub-pillar.', fields: [
        { key: 'metaLengthMode', label: 'Length guidance', type: 'select', source: 'Generated', options: ['Balanced', 'Short', 'Expanded'], description: 'Indicates how strict the guidance should be.' },
        { key: 'metaPreview', label: 'Preview on edit', type: 'toggle', source: 'Merchant config', description: 'Show a live preview while editing descriptions.' },
      ] },
    ],
  },
  /**
   * Alt text is configured by the Alt-Text Template Builder on the page itself, which stores a real
   * template against the store and previews it against the store's own catalogue.
   *
   * The two controls that used to live here — an "Alt text rule" select and an "Auto-suggest"
   * toggle — were removed rather than left beside it: nothing read either value, so they were
   * settings a merchant could change with no effect, and now they would also contradict a builder
   * that genuinely works.
   */
  'image-alt-text': {
    title: 'Image alt text settings',
    description: 'Alt text is configured on this page, in the Alt-Text Template Builder.',
    sections: [
      {
        id: 'alt-rules',
        title: 'Alt text behavior',
        description: 'Use the Alt-Text Template Builder above to set the template, character limit, formatting and skip rules for products and articles.',
        fields: [],
      },
    ],
  },
  // Canonicals has no settings. Its "Canonical strategy" and "Require review" controls were saved
  // but read by nothing — the canonical tag is theme markup Rankvora AI measures and cannot write — so
  // they were removed rather than left as settings with no effect. See hasSubPillarSettings().
  sitemap: {
    title: 'Sitemap settings',
    description: 'Choose how sitemap issues are surfaced and updated for supported pages.',
    sections: [
      { id: 'sitemap', title: 'Sitemap behavior', description: 'Define the default sitemap review behavior.', fields: [
        { key: 'sitemapAutoSubmit', label: 'Auto-submit review', type: 'toggle', source: 'Merchant config', description: 'Allow Rankvora AI to queue a sitemap review when issues are resolved.' },
        { key: 'sitemapPriority', label: 'Priority mode', type: 'select', source: 'Generated', options: ['Standard', 'Prioritized'], description: 'How Rankvora AI prioritizes sitemap updates.' },
      ] },
    ],
  },
  'internal-links': {
    title: 'Internal links settings',
    description: 'Defaults for internal linking guidance and cross-linking review.',
    sections: [
      { id: 'internal-links', title: 'Linking rules', description: 'Adjust the default guidance and review thresholds.', fields: [
        { key: 'linkingTarget', label: 'Preferred target', type: 'text', source: 'Merchant config', placeholder: 'Collection pages', description: 'Primary internal link target for supported content pages.' },
        { key: 'linkingReview', label: 'Review before apply', type: 'toggle', source: 'Merchant config', description: 'Require a check before internal link changes are applied.' },
      ] },
    ],
  },
  // Handles & redirects has no settings either. "Redirect mode" (301/302/manual) and "Approval
  // required" were saved but read by nothing: Shopify URL redirects are always permanent (301),
  // and Rankvora AI only reads redirects — it never creates or edits one, so there is nothing to approve.
};

const contextualSettings = (
  title: string,
  description: string,
  sectionTitle: string,
  fields: PageSettingField[],
): PageSettingsDefinition => ({ title, description, sections: [{ id: 'client-rules', title: sectionTitle, fields }] });

const selectField = (key: string, label: string, options: string[], description: string): PageSettingField => ({ key, label, type: 'select', source: 'Merchant config', options, description });
const toggleField = (key: string, label: string, description: string, source: PageSettingField['source'] = 'Merchant config'): PageSettingField => ({ key, label, type: 'toggle', source, description });
const textField = (key: string, label: string, placeholder: string, description: string, type: PageSettingField['type'] = 'text'): PageSettingField => ({ key, label, type, source: 'Merchant config', placeholder, description });

Object.assign(subPillarSettingsRegistry, {
  'content/product-descriptions': contextualSettings('Product description settings', 'Set the content standards used when reviewing product descriptions.', 'Content standard', [selectField('productDescriptionMinWords', 'Minimum word count', ['50 words', '80 words', '120 words'], 'Minimum useful context expected on eligible product pages.'), toggleField('productDescriptionReview', 'Require review before apply', 'Keep suggested product copy in review until a client approves it.')]),
  'content/collection-descriptions': contextualSettings('Collection description settings', 'Control collection copy guidance and duplicate-content review.', 'Collection copy rules', [selectField('collectionDescriptionMinWords', 'Minimum word count', ['30 words', '60 words', '100 words'], 'Minimum context expected around the collection grid.'), toggleField('collectionDescriptionUnique', 'Flag duplicate copy', 'Flag collection descriptions that closely match another collection.', 'Generated')]),
  'content/metafields': contextualSettings('Metafield completeness settings', 'Choose which product attributes are required and how gaps are prioritized.', 'Attribute rules', [selectField('metafieldRequiredGroup', 'Required field group', ['Trust and compliance', 'Search and merchandising', 'All applicable fields'], 'Scope the completeness review to the fields that matter most.'), toggleField('metafieldCriticalFirst', 'Prioritize critical fields', 'Put trust and compliance gaps first in the review queue.')]),
  'content/dup-templated': contextualSettings('Duplicate content settings', 'Set similarity thresholds and the review workflow for repetitive copy.', 'Similarity rules', [selectField('duplicateSimilarityThreshold', 'Duplicate threshold', ['70%', '80%', '90%'], 'Similarity level at which Rankvora AI raises a duplicate finding.'), toggleField('duplicateReviewRequired', 'Require editorial review', 'Require approval before rewriting or consolidating content.')]),
  'content/blog-freshness': contextualSettings('Blog freshness settings', 'Define when editorial content becomes aging or stale for this store.', 'Freshness rules', [selectField('blogAgingMonths', 'Aging after', ['6 months', '9 months', '12 months'], 'Age at which an article enters the refresh queue.'), toggleField('blogRetirementReview', 'Review before retirement', 'Require a client decision before an article is retired or redirected.')]),
  'content/media-richness': contextualSettings('Media richness settings', 'Set the minimum visual coverage expected for product pages.', 'Media standard', [selectField('mediaMinimumImages', 'Minimum image count', ['3 images', '4 images', '6 images'], 'Minimum gallery size for a product to be media-rich.'), toggleField('mediaVideoRecommended', 'Recommend product video', 'Recommend a short demo video for products with thin galleries.')]),
  'speed/cwv': contextualSettings('Core Web Vitals settings', 'Choose the experience thresholds used to prioritize page performance issues.', 'Experience thresholds', [selectField('cwvDataSource', 'Preferred data source', ['Field data', 'Lab data', 'Field and lab data'], 'Evidence used for the page experience review.'), toggleField('cwvCriticalOnly', 'Show critical pages first', 'Prioritize pages that fail more than one Core Web Vital.', 'Generated')]),
  'speed/image-weight': contextualSettings('Image optimization settings', 'Set payload and format guidance for storefront images.', 'Image rules', [selectField('imageMaxKb', 'Maximum image size', ['150 KB', '250 KB', '400 KB'], 'Flag images that exceed the selected payload target.'), toggleField('imageModernFormats', 'Require modern formats', 'Flag eligible assets that could be served as WebP or AVIF.', 'Generated')]),
  'speed/app-bloat': contextualSettings('App and script settings', 'Control how third-party scripts are classified and prioritized.', 'Script rules', [selectField('scriptHeavyThreshold', 'Heavy script threshold', ['100 KB', '150 KB', '250 KB'], 'Payload above which a script is treated as heavy.'), toggleField('scriptBlockingReview', 'Flag blocking scripts', 'Raise findings for scripts that delay first paint or interaction.', 'Generated')]),
  'speed/theme-weight': contextualSettings('Theme weight settings', 'Set theme asset budgets and loading expectations for the storefront.', 'Theme budgets', [selectField('themeBudgetMb', 'Theme size budget', ['2 MB', '3 MB', '4 MB'], 'Target total theme asset size before a review is raised.'), toggleField('themeLazyLoadRequired', 'Require lazy loading', 'Flag eligible below-fold media that loads eagerly.', 'Generated')]),
  'cro/clarity': contextualSettings('CTA clarity settings', 'Define how Rankvora AI evaluates the primary action across storefront surfaces.', 'Action clarity', [textField('ctaPrimaryAction', 'Primary action label', 'Add to cart', 'The action shoppers should see most clearly.'), toggleField('ctaAboveFoldRequired', 'Require above-fold action', 'Flag key pages where the primary action requires scrolling.', 'Generated')]),
  'cro/cart-recovery': contextualSettings('Cart recovery settings', 'Set the recovery window and approval guardrails for abandoned-cart flows.', 'Recovery rules', [selectField('recoveryWindow', 'Recovery window', ['24 hours', '72 hours', '7 days'], 'Time after abandonment during which recovery remains relevant.'), toggleField('recoveryDiscountApproval', 'Approve discounts before launch', 'Require approval for incentive-based recovery flows.')]),
  'cro/trust': contextualSettings('Trust and social proof settings', 'Choose review coverage standards used for product pages.', 'Trust coverage', [selectField('trustMinimumReviews', 'Minimum review count', ['1 review', '3 reviews', '5 reviews'], 'Minimum reviews before a product is well supported.'), toggleField('trustBadgeRequired', 'Require trust badge coverage', 'Flag eligible pages without the configured trust signal.')]),
  'cro/returns': contextualSettings('Returns flow settings', 'Set self-service and policy clarity expectations for returns.', 'Returns rules', [toggleField('returnsSelfServiceRequired', 'Require self-service path', 'Flag stores where customers cannot start a return without support.'), textField('returnsPolicyUrl', 'Returns policy URL', 'https://www.example.com/returns', 'Canonical policy page used in the customer journey.', 'url')]),
  'cro/tracking': contextualSettings('Order tracking settings', 'Control delivery visibility and branded tracking expectations.', 'Tracking rules', [textField('trackingPageUrl', 'Branded tracking URL', 'https://www.example.com/track', 'Page customers should use to view delivery updates.', 'url'), toggleField('trackingFallbackRequired', 'Require tracking fallback', 'Flag orders without a carrier event or usable fallback status.', 'Generated')]),
  'cro/cod': contextualSettings('COD checkout settings', 'Set validation and confirmation expectations for cash-on-delivery checkout.', 'COD safeguards', [toggleField('codOtpRequired', 'Require OTP verification', 'Require customer confirmation before placing a COD order.'), selectField('codPhoneRequired', 'Phone number requirement', ['Optional', 'Required', 'Required and verified'], 'Phone validation standard for COD orders.')]),
  'cro/options': contextualSettings('Product options settings', 'Define variant, fit guidance, and add-on expectations for product pages.', 'Option coverage', [toggleField('optionsSizeGuideRequired', 'Require size guidance', 'Flag eligible products without fit or sizing guidance.'), toggleField('optionsAddOnsRecommended', 'Recommend relevant add-ons', 'Include cross-sell opportunities when product context supports them.', 'Generated')]),
  'cro/subscription': contextualSettings('Subscription settings', 'Set which products should expose recurring purchase opportunities.', 'Recurring purchase rules', [textField('subscriptionEligibleCategory', 'Eligible category scope', 'Consumables and accessories', 'Categories where recurring purchase should be considered.'), toggleField('subscriptionSavingsRequired', 'Require savings message', 'Flag offers that do not explain the customer value.')]),
  'cro/wishlist': contextualSettings('Wishlist settings', 'Control wishlist coverage and reminders for saved intent.', 'Wishlist behavior', [toggleField('wishlistAllProductPages', 'Require product-page coverage', 'Flag templates where shoppers cannot save an item.'), selectField('wishlistReminderMode', 'Reminder mode', ['No reminders', 'Restock only', 'Restock and price alerts'], 'Shopper reminders expected for saved products.')]),
  'cro/locator': contextualSettings('Store locator settings', 'Set location data fields required for a trustworthy store finder.', 'Location data', [toggleField('locatorHoursRequired', 'Require opening hours', 'Flag locations without regular and holiday hours.'), selectField('locatorMapProvider', 'Map provider', ['Google Maps', 'Mapbox', 'Storefront map'], 'Map experience used by the store locator.')]),
  'cro/mobile-ux': contextualSettings('Mobile UX settings', 'Set mobile usability expectations for tap targets and purchase paths.', 'Mobile experience', [toggleField('mobileStickyActionRequired', 'Require sticky purchase action', 'Flag long product pages without an accessible purchase action.'), selectField('mobileViewport', 'Primary review viewport', ['390px', '412px', '768px'], 'Viewport used for the focused mobile usability review.')]),
});

/** Sub-pillars whose page offers no settings at all — the Settings button is not shown for them,
 * rather than falling back to another page's definition.
 *
 * All seven AI Discovery areas are here. Four of them used to offer controls no check reads —
 * "Minimum answers per product: 3/5/8", "Freshness window: 24h/48h/7d", "Policy mode" — saved to
 * the database and then ignored by every audit, so a merchant changed a number and the result did
 * not move. The other three had no entry at all and fell back to the Schema / JSON-LD panel, with
 * its "Rankvora AI Store" and example.com placeholders, on pages about crawlers and IndexNow.
 * AI Discovery's real inputs — the IndexNow key and the tracked questions — live in
 * Settings → AI Discovery, where the checks actually read them. */
const WITHOUT_SETTINGS = new Set([
  'canonicals',
  'handles-redirects',
  'ai-discovery/agents-md',
  'ai-discovery/agentic-attrs',
  'ai-discovery/answerable-qa',
  'ai-discovery/feed',
  'ai-discovery/indexing-freshness',
  'ai-discovery/indexnow',
  'ai-discovery/prompt-tracking',
]);

export function hasSubPillarSettings(slug: string): boolean {
  return !WITHOUT_SETTINGS.has(slug);
}

export function getSubPillarSettingsDefinition(slug: string): PageSettingsDefinition {
  return subPillarSettingsRegistry[slug] ?? schemaPageSettingsDefinition;
}

export function getDefaultSubPillarSettings(slug: string): Record<string, PageSettingValue> {
  return buildDefaultsFromDefinition(getSubPillarSettingsDefinition(slug));
}

// Persistence lives in data/pageSettings.repository.ts (GET/PUT
// /api/page-settings/:slug) — the earlier localStorage readers were
// removed when client settings moved to the database.
