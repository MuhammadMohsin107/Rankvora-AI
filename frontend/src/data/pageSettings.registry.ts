export type PageSettingValue = string | boolean;

export interface PageSettingField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'toggle' | 'url';
  source: 'Merchant config' | 'Shopify' | 'Generated';
  placeholder?: string;
  options?: readonly string[];
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface PageSettingsSection {
  id: string;
  title: string;
  fields: PageSettingField[];
}

export interface PageSettingsDefinition {
  title: string;
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
  sections: [
    {
      id: 'business',
      title: 'Business profile',
      fields: [
        {
          key: 'organizationName',
          label: 'Business name',
          type: 'text',
          source: 'Merchant config',
          placeholder: 'Rankvora AI Store',
        },
        {
          key: 'websiteUrl',
          label: 'Website URL',
          type: 'url',
          source: 'Shopify',
          placeholder: 'https://www.example.com',
        },
        {
          key: 'logoUrl',
          label: 'Logo URL',
          type: 'url',
          source: 'Merchant config',
          placeholder: 'https://cdn.example.com/logo.png',
        },
        {
          key: 'supportEmail',
          label: 'Support email',
          type: 'text',
          source: 'Merchant config',
          placeholder: 'support@example.com',
        },
      ],
    },
    {
      id: 'schema-behavior',
      title: 'Structured data behavior',
      fields: [
        {
          key: 'productSchemaEnabled',
          label: 'Product schema',
          type: 'toggle',
          source: 'Generated',
        },
        {
          key: 'productGroupSchemaEnabled',
          label: 'ProductGroup schema',
          type: 'toggle',
          source: 'Generated',
        },
        {
          key: 'offerDataEnabled',
          label: 'Product offer data',
          type: 'toggle',
          source: 'Shopify',
        },
        {
          key: 'aggregateRatingEnabled',
          label: 'Aggregate rating data',
          type: 'toggle',
          source: 'Merchant config',
        },
        {
          key: 'organizationSchemaEnabled',
          label: 'Organization schema',
          type: 'toggle',
          source: 'Generated',
        },
        {
          key: 'websiteSchemaEnabled',
          label: 'WebSite schema',
          type: 'toggle',
          source: 'Generated',
        },
        {
          key: 'collectionSchemaEnabled',
          label: 'CollectionPage and ItemList schema',
          type: 'toggle',
          source: 'Generated',
        },
        {
          key: 'faqSchemaEnabled',
          label: 'FAQ schema',
          type: 'toggle',
          source: 'Merchant config',
        },
        {
          key: 'breadcrumbSchemaEnabled',
          label: 'Breadcrumb schema',
          type: 'toggle',
          source: 'Generated',
        },
      ],
    },
    {
      id: 'faq',
      title: 'FAQ defaults',
      fields: [
        {
          key: 'faqPrompt',
          label: 'FAQ default question',
          type: 'textarea',
          source: 'Merchant config',
          placeholder: 'How quickly can I receive my order?',
          maxLength: 220,
        },
        {
          key: 'schemaOutputMode',
          label: 'JSON-LD output mode',
          type: 'select',
          source: 'Generated',
          options: ['Draft preview', 'Ready to publish', 'Manual review'],
        },
      ],
    },
  ],
};

export const subPillarSettingsRegistry: Record<string, PageSettingsDefinition> = {
  schema: schemaPageSettingsDefinition,
  'title-tags': {
    title: 'Title tag settings',
    sections: [
      { id: 'templates', title: 'Title templates', fields: [
        { key: 'titleTemplate', label: 'Title template', type: 'text', source: 'Merchant config', placeholder: '{product_title} | {brand}' },
        { key: 'titleBrand', label: 'Brand suffix', type: 'text', source: 'Merchant config', placeholder: 'Rankvora AI Store' },
      ] },
      { id: 'rules', title: 'Display rules', fields: [
        { key: 'titlePreview', label: 'Preview mode', type: 'select', source: 'Generated', options: ['Draft preview', 'Live preview', 'Manual review'] },
        { key: 'titleFallback', label: 'Fallback behavior', type: 'toggle', source: 'Merchant config' },
      ] },
    ],
  },
  'meta-descriptions': {
    title: 'Meta description settings',
    sections: [
      { id: 'descriptions', title: 'Description templates', fields: [
        { key: 'metaTemplate', label: 'Description template', type: 'textarea', source: 'Merchant config', placeholder: '{product_title} with fast shipping, easy returns, and trusted support.', maxLength: 180 },
      ] },
      { id: 'quality', title: 'Quality rules', fields: [
        { key: 'metaLengthMode', label: 'Length guidance', type: 'select', source: 'Generated', options: ['Balanced', 'Short', 'Expanded'] },
        { key: 'metaPreview', label: 'Preview on edit', type: 'toggle', source: 'Merchant config' },
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
    sections: [],
  },
  // Canonicals has no settings. Its "Canonical strategy" and "Require review" controls were saved
  // but read by nothing — the canonical tag is theme markup Rankvora AI measures and cannot write — so
  // they were removed rather than left as settings with no effect. See hasSubPillarSettings().
  sitemap: {
    title: 'Sitemap settings',
    sections: [
      { id: 'sitemap', title: 'Sitemap behavior', fields: [
        { key: 'sitemapAutoSubmit', label: 'Auto-submit review', type: 'toggle', source: 'Merchant config' },
        { key: 'sitemapPriority', label: 'Priority mode', type: 'select', source: 'Generated', options: ['Standard', 'Prioritized'] },
      ] },
    ],
  },
  'internal-links': {
    title: 'Internal links settings',
    sections: [
      { id: 'internal-links', title: 'Linking rules', fields: [
        { key: 'linkingTarget', label: 'Preferred target', type: 'text', source: 'Merchant config', placeholder: 'Collection pages' },
        { key: 'linkingReview', label: 'Review before apply', type: 'toggle', source: 'Merchant config' },
      ] },
    ],
  },
  // Handles & redirects has no settings either. "Redirect mode" (301/302/manual) and "Approval
  // required" were saved but read by nothing: Shopify URL redirects are always permanent (301),
  // and Rankvora AI only reads redirects — it never creates or edits one, so there is nothing to approve.
};

const contextualSettings = (
  title: string,
  sectionTitle: string,
  fields: PageSettingField[],
): PageSettingsDefinition => ({ title, sections: [{ id: 'client-rules', title: sectionTitle, fields }] });

const selectField = (key: string, label: string, options: string[]): PageSettingField => ({ key, label, type: 'select', source: 'Merchant config', options });
const toggleField = (key: string, label: string, source: PageSettingField['source'] = 'Merchant config'): PageSettingField => ({ key, label, type: 'toggle', source });
const textField = (key: string, label: string, placeholder: string, type: PageSettingField['type'] = 'text'): PageSettingField => ({ key, label, type, source: 'Merchant config', placeholder });

Object.assign(subPillarSettingsRegistry, {
  'content/product-descriptions': contextualSettings('Product description settings', 'Content standard', [selectField('productDescriptionMinWords', 'Minimum word count', ['50 words', '80 words', '120 words']), toggleField('productDescriptionReview', 'Require review before apply')]),
  'content/collection-descriptions': contextualSettings('Collection description settings', 'Collection copy rules', [selectField('collectionDescriptionMinWords', 'Minimum word count', ['30 words', '60 words', '100 words']), toggleField('collectionDescriptionUnique', 'Flag duplicate copy', 'Generated')]),
  'content/metafields': contextualSettings('Metafield completeness settings', 'Attribute rules', [selectField('metafieldRequiredGroup', 'Required field group', ['Trust and compliance', 'Search and merchandising', 'All applicable fields']), toggleField('metafieldCriticalFirst', 'Prioritize critical fields')]),
  'content/dup-templated': contextualSettings('Duplicate content settings', 'Similarity rules', [selectField('duplicateSimilarityThreshold', 'Duplicate threshold', ['70%', '80%', '90%']), toggleField('duplicateReviewRequired', 'Require editorial review')]),
  'content/blog-freshness': contextualSettings('Blog freshness settings', 'Freshness rules', [selectField('blogAgingMonths', 'Aging after', ['6 months', '9 months', '12 months']), toggleField('blogRetirementReview', 'Review before retirement')]),
  'content/media-richness': contextualSettings('Media richness settings', 'Media standard', [selectField('mediaMinimumImages', 'Minimum image count', ['3 images', '4 images', '6 images']), toggleField('mediaVideoRecommended', 'Recommend product video')]),
  'speed/cwv': contextualSettings('Core Web Vitals settings', 'Experience thresholds', [selectField('cwvDataSource', 'Preferred data source', ['Field data', 'Lab data', 'Field and lab data']), toggleField('cwvCriticalOnly', 'Show critical pages first', 'Generated')]),
  'speed/image-weight': contextualSettings('Image optimization settings', 'Image rules', [selectField('imageMaxKb', 'Maximum image size', ['150 KB', '250 KB', '400 KB']), toggleField('imageModernFormats', 'Require modern formats', 'Generated')]),
  'speed/app-bloat': contextualSettings('App and script settings', 'Script rules', [selectField('scriptHeavyThreshold', 'Heavy script threshold', ['100 KB', '150 KB', '250 KB']), toggleField('scriptBlockingReview', 'Flag blocking scripts', 'Generated')]),
  'speed/theme-weight': contextualSettings('Theme weight settings', 'Theme budgets', [selectField('themeBudgetMb', 'Theme size budget', ['2 MB', '3 MB', '4 MB']), toggleField('themeLazyLoadRequired', 'Require lazy loading', 'Generated')]),
  'cro/clarity': contextualSettings('CTA clarity settings', 'Action clarity', [textField('ctaPrimaryAction', 'Primary action label', 'Add to cart'), toggleField('ctaAboveFoldRequired', 'Require above-fold action', 'Generated')]),
  'cro/cart-recovery': contextualSettings('Cart recovery settings', 'Recovery rules', [selectField('recoveryWindow', 'Recovery window', ['24 hours', '72 hours', '7 days']), toggleField('recoveryDiscountApproval', 'Approve discounts before launch')]),
  'cro/trust': contextualSettings('Trust and social proof settings', 'Trust coverage', [selectField('trustMinimumReviews', 'Minimum review count', ['1 review', '3 reviews', '5 reviews']), toggleField('trustBadgeRequired', 'Require trust badge coverage')]),
  'cro/returns': contextualSettings('Returns flow settings', 'Returns rules', [toggleField('returnsSelfServiceRequired', 'Require self-service path'), textField('returnsPolicyUrl', 'Returns policy URL', 'https://www.example.com/returns', 'url')]),
  'cro/tracking': contextualSettings('Order tracking settings', 'Tracking rules', [textField('trackingPageUrl', 'Branded tracking URL', 'https://www.example.com/track', 'url'), toggleField('trackingFallbackRequired', 'Require tracking fallback', 'Generated')]),
  'cro/cod': contextualSettings('COD checkout settings', 'COD safeguards', [toggleField('codOtpRequired', 'Require OTP verification'), selectField('codPhoneRequired', 'Phone number requirement', ['Optional', 'Required', 'Required and verified'])]),
  'cro/options': contextualSettings('Product options settings', 'Option coverage', [toggleField('optionsSizeGuideRequired', 'Require size guidance'), toggleField('optionsAddOnsRecommended', 'Recommend relevant add-ons', 'Generated')]),
  'cro/subscription': contextualSettings('Subscription settings', 'Recurring purchase rules', [textField('subscriptionEligibleCategory', 'Eligible category scope', 'Consumables and accessories'), toggleField('subscriptionSavingsRequired', 'Require savings message')]),
  'cro/wishlist': contextualSettings('Wishlist settings', 'Wishlist behavior', [toggleField('wishlistAllProductPages', 'Require product-page coverage'), selectField('wishlistReminderMode', 'Reminder mode', ['No reminders', 'Restock only', 'Restock and price alerts'])]),
  'cro/locator': contextualSettings('Store locator settings', 'Location data', [toggleField('locatorHoursRequired', 'Require opening hours'), selectField('locatorMapProvider', 'Map provider', ['Google Maps', 'Mapbox', 'Storefront map'])]),
  'cro/mobile-ux': contextualSettings('Mobile UX settings', 'Mobile experience', [toggleField('mobileStickyActionRequired', 'Require sticky purchase action'), selectField('mobileViewport', 'Primary review viewport', ['390px', '412px', '768px'])]),
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
 * the AI Discovery page, where the checks actually read them. */
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
