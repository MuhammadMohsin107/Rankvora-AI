import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELD_CATALOG, findField, type ResolutionContext } from '../schema-engine/fields.js';
import { SCHEMA_LIBRARY, defaultTemplateFor, findSchemaType } from '../schema-engine/library.js';
import { resolveTemplate } from '../schema-engine/resolver.js';
import { validateSchema } from '../schema-engine/validator.js';
import type { SchemaTemplate, ValueSource } from '../schema-engine/types.js';

// The engine's whole contract is "never assert something that is not true of the merchant's real
// data". These exercise that directly: what it emits, what it refuses to emit, and why.

const SHOP: ResolutionContext['shop'] = {
  domain: 't.myshopify.com',
  primaryUrl: 'https://t.myshopify.com',
  name: 'Test Store',
  email: 'hello@example.com',
  currency: 'PKR',
  country: 'PK',
  timezone: 'UTC',
  planName: null,
};

function productContext(overrides: Partial<NonNullable<ResolutionContext['product']>> = {}): ResolutionContext {
  return {
    kind: 'product',
    shop: SHOP,
    product: {
      id: 'p1',
      title: 'Collagen Glow Duo Pack',
      handle: 'collagen-glow-duo-pack',
      url: 'https://t.myshopify.com/products/collagen-glow-duo-pack',
      bodyHtml: '<p>Supports <strong>skin</strong> &amp; hair.</p>',
      productType: 'Supplement',
      vendor: 'My Nutrition Store',
      tags: ['collagen'],
      status: 'ACTIVE',
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      images: [{ id: 'i1', src: 'https://cdn.shopify.com/a.png', alt: null, width: null, height: null }],
      variantCount: 1,
      options: [],
      variants: [{ id: 'v1', sku: 'CGD-1', barcode: '8901234567890', price: 3190, availableForSale: true }],
      variantsTruncated: false,
      sellingPlanGroupCount: 0,
      metafields: [],
      metafieldsAvailable: false,
      seoTitle: null,
      seoDescription: null,
      ...overrides,
    },
  } as ResolutionContext;
}

function template(properties: Record<string, ValueSource>): SchemaTemplate {
  return { type: 'Product', context: 'product', enabled: true, properties };
}

describe('schema engine · resolving real Shopify data', () => {
  it('emits the values the store actually holds', () => {
    const { jsonLd } = resolveTemplate(defaultTemplateFor('Product', 'product')!, productContext());
    assert.ok(jsonLd);
    assert.equal(jsonLd['@context'], 'https://schema.org');
    assert.equal(jsonLd['@type'], 'Product');
    assert.equal(jsonLd.name, 'Collagen Glow Duo Pack');
    assert.equal(jsonLd.sku, 'CGD-1');
    assert.equal(jsonLd.gtin, '8901234567890');
    // HTML never reaches JSON-LD: it is not rendered there and only inflates the document.
    assert.equal(jsonLd.description, 'Supports skin & hair.');
    assert.deepEqual(jsonLd.brand, { '@type': 'Brand', name: 'My Nutrition Store' });
  });

  it('emits price as a number and availability as a schema.org URL', () => {
    // The two most common structured-data mistakes on a storefront: a formatted price string that
    // no consumer can parse, and an invented availability word Google does not recognise.
    const { jsonLd } = resolveTemplate(defaultTemplateFor('Product', 'product')!, productContext());
    const offers = jsonLd?.offers as Record<string, unknown>;
    assert.equal(typeof offers.price, 'number');
    assert.equal(offers.price, 3190);
    assert.equal(offers.priceCurrency, 'PKR');
    assert.equal(offers.availability, 'https://schema.org/InStock');
  });

  it('omits a property rather than asserting an empty value, and says why', () => {
    // A product with no SKU must not ship `"sku": ""` — that claims an SKU whose value is nothing.
    const context = productContext({ variants: [{ id: 'v1', sku: null, barcode: '', price: 3190, availableForSale: false }] });
    const { jsonLd, omissions } = resolveTemplate(defaultTemplateFor('Product', 'product')!, context);

    assert.equal('sku' in (jsonLd ?? {}), false);
    assert.equal('gtin' in (jsonLd ?? {}), false);
    assert.ok(omissions.some((entry) => entry.property === 'sku' && entry.reason === 'empty'));
    assert.ok(omissions.some((entry) => entry.property === 'gtin' && entry.reason === 'empty'));
    // Out of stock is a real value, not an absence.
    assert.equal((jsonLd?.offers as Record<string, unknown>).availability, 'https://schema.org/OutOfStock');
  });

  it('drops a nested object whose every property resolved to nothing', () => {
    // `"brand": {"@type": "Brand"}` tells a consumer nothing and can fail validation.
    const context = productContext({ vendor: '' });
    const { jsonLd } = resolveTemplate(defaultTemplateFor('Product', 'product')!, context);
    assert.equal('brand' in (jsonLd ?? {}), false);
  });

  it('reports a mapping that points at a field this engine cannot read', () => {
    const { jsonLd, omissions } = resolveTemplate(
      template({ name: { kind: 'shopify', path: 'product.does_not_exist' } }),
      productContext(),
    );
    assert.equal(jsonLd, null);
    assert.equal(omissions[0].reason, 'unknown_field');
  });

  it('refuses a field that does not exist in this context', () => {
    // article.title on a product page is a configuration mistake, not an empty value.
    const { omissions } = resolveTemplate(
      template({ name: { kind: 'shopify', path: 'article.title' } }),
      productContext(),
    );
    assert.equal(omissions[0].reason, 'unknown_field');
  });

  it('states plainly that metafield values are not readable yet', () => {
    // The mapping is accepted and stored, but nothing is emitted and the merchant is told why —
    // rather than silently producing an empty property they would have to discover on the page.
    const context = productContext({
      metafieldsAvailable: true,
      metafields: [{ namespace: 'custom', key: 'mpn', type: 'single_line_text_field', hasValue: true }],
    });
    const { jsonLd, omissions } = resolveTemplate(
      template({ name: { kind: 'shopify', path: 'product.title' }, mpn: { kind: 'metafield', namespace: 'custom', key: 'mpn' } }),
      context,
    );
    assert.equal('mpn' in (jsonLd ?? {}), false);
    assert.equal(omissions.find((entry) => entry.property === 'mpn')?.reason, 'metafield_values_unavailable');
  });

  it('takes a merchant-typed value at face value, but not a blank box', () => {
    const { jsonLd, omissions } = resolveTemplate(
      template({ name: { kind: 'static', value: 'Hand-written' }, sku: { kind: 'static', value: '   ' } }),
      productContext(),
    );
    assert.equal(jsonLd?.name, 'Hand-written');
    assert.equal('sku' in (jsonLd ?? {}), false);
    assert.equal(omissions.find((entry) => entry.property === 'sku')?.reason, 'empty');
  });

  it('returns null rather than a document that describes nothing', () => {
    // `{"@context":..., "@type":"Product"}` alone is an empty assertion on the page.
    const { jsonLd } = resolveTemplate(template({ name: { kind: 'none' } }), productContext());
    assert.equal(jsonLd, null);
  });
});

describe('schema engine · validation', () => {
  it('rejects a price that is text', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@type': 'Offer',
      price: 'Rs 3,190',
      priceCurrency: 'PKR',
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.property === 'price' && issue.severity === 'error'));
  });

  it('rejects a relative URL', () => {
    const result = validateSchema({ '@context': 'https://schema.org', '@type': 'Brand', name: 'X', url: '/brands/x' });
    assert.ok(result.issues.some((issue) => issue.property === 'url' && issue.severity === 'error'));
  });

  it('errors on a missing required property and only warns on a recommended one', () => {
    const result = validateSchema({ '@context': 'https://schema.org', '@type': 'Product', name: 'X' });
    // offers is required for a product rich result; description is merely recommended.
    assert.ok(result.issues.some((issue) => issue.property === 'offers' && issue.severity === 'error'));
    assert.ok(result.issues.some((issue) => issue.property === 'description' && issue.severity === 'warning'));
    assert.equal(result.valid, false);
  });

  it('accepts an unknown type without inventing a verdict about it', () => {
    // The custom builder can emit any Schema.org type; the library is a curated subset.
    const result = validateSchema({ '@context': 'https://schema.org', '@type': 'Vehicle', name: 'X' });
    assert.equal(result.valid, true);
  });
});

describe('schema engine · library integrity', () => {
  it('every preconfigured mapping points at a field that really exists', () => {
    // A default that cannot resolve is worse than no default: the merchant enables a template,
    // sees an empty property, and has no way to know the app shipped it that way.
    const check = (source: ValueSource, where: string) => {
      if (source.kind === 'shopify') {
        assert.ok(findField(source.path), `${where} maps to "${source.path}", which is not in the field catalog`);
      } else if (source.kind === 'object') {
        for (const [name, nested] of Object.entries(source.properties)) check(nested, `${where}.${name}`);
      } else if (source.kind === 'array') {
        source.items.forEach((item, index) => check(item, `${where}[${index}]`));
      }
    };

    for (const definition of SCHEMA_LIBRARY) {
      for (const property of definition.properties) {
        if (property.defaultSource) check(property.defaultSource, `${definition.type}.${property.name}`);
      }
    }
  });

  it('every default is readable in the context its type is offered for', () => {
    for (const definition of SCHEMA_LIBRARY) {
      for (const context of definition.contexts) {
        for (const property of definition.properties) {
          const source = property.defaultSource;
          if (source?.kind !== 'shopify') continue;
          const field = findField(source.path);
          assert.ok(
            field?.contexts.includes(context),
            `${definition.type}.${property.name} defaults to "${source.path}", which does not exist on a ${context}`,
          );
        }
      }
    }
  });

  it('keeps FAQPage and QAPage as different concepts', () => {
    // Google treats them differently: FAQPage is the SITE publishing both halves, QAPage is USERS
    // asking and answering with one accepted answer. Collapsing them is a structured-data error.
    const faq = findSchemaType('FAQPage');
    const qa = findSchemaType('QAPage');
    assert.ok(faq && qa);
    assert.notEqual(faq.description, qa.description);
    assert.ok(/customers/i.test(qa.description), 'QAPage must describe user-contributed answers');
  });

  it('offers specific LocalBusiness subtypes rather than only the generic parent', () => {
    const types = new Set(SCHEMA_LIBRARY.map((definition) => definition.type));
    for (const subtype of ['Store', 'Restaurant', 'MedicalBusiness', 'ProfessionalService', 'FinancialService', 'AutomotiveBusiness', 'LodgingBusiness', 'FoodEstablishment']) {
      assert.ok(types.has(subtype), `${subtype} is missing from the library`);
    }
  });

  it('covers every schema type the product requires, with nothing quietly dropped', () => {
    // The agreed coverage list, written out in full rather than counted. A count would pass while
    // one type was swapped for another; this fails naming the exact type that went missing.
    const REQUIRED = [
      // Ecommerce & Product
      'Product', 'ProductGroup', 'Offer', 'AggregateOffer', 'AggregateRating', 'Review', 'Brand',
      'IndividualProduct', 'MerchantReturnPolicy', 'OfferShippingDetails',
      // Website & Organization
      'Organization', 'OnlineStore', 'WebSite', 'WebPage', 'AboutPage', 'ContactPage',
      'CollectionPage', 'SearchResultsPage', 'ProfilePage', 'BreadcrumbList',
      // Content
      'Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'Report', 'CreativeWork',
      'ImageObject', 'VideoObject', 'AudioObject',
      // FAQ / Q&A
      'FAQPage', 'Question', 'Answer', 'QAPage',
      // Business & Local SEO
      'LocalBusiness', 'Store', 'Restaurant', 'MedicalBusiness', 'ProfessionalService',
      'FinancialService', 'AutomotiveBusiness', 'LodgingBusiness', 'FoodEstablishment', 'Place',
      'PostalAddress', 'GeoCoordinates', 'OpeningHoursSpecification',
      // Media & Rich Content
      'Clip', 'BroadcastEvent', 'LiveBlogPosting',
      // Education / Guides
      'Course', 'CourseInstance', 'HowTo', 'LearningResource',
      // Jobs
      'JobPosting', 'OccupationalExperienceRequirements', 'EducationalOccupationalCredential',
      // Events
      'Event', 'BusinessEvent', 'EducationEvent', 'Festival', 'SocialEvent', 'SportsEvent', 'ScreeningEvent',
      // Recipes / Food
      'Recipe', 'NutritionInformation',
      // Software / Technology
      'SoftwareApplication', 'MobileApplication', 'WebApplication',
    ];

    const present = new Set(SCHEMA_LIBRARY.map((definition) => definition.type));
    const missing = REQUIRED.filter((type) => !present.has(type));
    assert.deepEqual(missing, [], `missing from the schema library: ${missing.join(', ')}`);
  });

  it('gives every type at least one required property, so nothing is a hollow entry', () => {
    // A type in the list with no properties would look like coverage and deliver none.
    for (const definition of SCHEMA_LIBRARY) {
      assert.ok(definition.properties.length > 0, `${definition.type} has no properties`);
      assert.ok(
        definition.properties.some((property) => property.requirement === 'required'),
        `${definition.type} declares nothing as required — check it against Google's documentation`,
      );
    }
  });

  it('has no duplicate type entries and no duplicate field paths', () => {
    const types = SCHEMA_LIBRARY.map((definition) => definition.type);
    assert.equal(new Set(types).size, types.length, 'a Schema type is defined twice');
    const paths = FIELD_CATALOG.map((field) => field.path);
    assert.equal(new Set(paths).size, paths.length, 'a field path is defined twice');
  });
});
