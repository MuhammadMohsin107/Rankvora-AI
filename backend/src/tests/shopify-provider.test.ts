import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { ShopifyStoreDataProvider } from '../audit-engine/store-data/shopify.provider.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';

function gqlResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const SHOP = {
  shop: {
    id: 'gid://shopify/Shop/1',
    name: 'Acme',
    contactEmail: 'a@b.com',
    myshopifyDomain: 'test.myshopify.com',
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
    plan: { displayName: 'Basic' },
    billingAddress: { country: 'United States' },
    primaryDomain: { url: 'https://test.myshopify.com', host: 'test.myshopify.com' },
  },
};

const emptyConnection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

/** Routes a fake GraphQL Admin API by operation name; anything unlisted returns an empty
 * connection so a test only has to declare the resources it cares about. */
function providerFor(operations: Record<string, unknown>, productLimit = 100) {
  const client = new ShopifyClient({
    shopDomain: 'test.myshopify.com',
    accessToken: 'token',
    sleepImpl: async () => {},
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const { query } = JSON.parse(init?.body ?? '{}') as { query: string };
      const name = query.match(/query\s+(\w+)/)?.[1] ?? '';
      const configured = operations[name];

      if (configured instanceof Error) throw configured;
      if (configured !== undefined) return gqlResponse({ data: configured });

      if (name === 'ScoreloShopIdentity') return gqlResponse({ data: { shop: null } });
      if (name === 'ScoreloPolicies') return gqlResponse({ data: { shop: { shopPolicies: [] } } });
      const key = name.replace('Scorelo', '').toLowerCase();
      return gqlResponse({ data: { [key]: emptyConnection } });
    },
  });
  return new ShopifyStoreDataProvider(client, 42, 'test.myshopify.com', productLimit);
}

function productsPage(nodes: unknown[]) {
  return { products: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
}

describe('ShopifyStoreDataProvider progress', () => {
  it('reports each step in order, with real counts against the total Shopify reported', async () => {
    let productCalls = 0;
    const client = new ShopifyClient({
      shopDomain: 'test.myshopify.com',
      accessToken: 'token',
      sleepImpl: async () => {},
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const { query } = JSON.parse(init?.body ?? '{}') as { query: string };
        const name = query.match(/query\s+(\w+)/)?.[1] ?? '';
        if (name === 'ScoreloShopIdentity') return gqlResponse({ data: SHOP });
        if (name === 'ScoreloCatalogTotals') return gqlResponse({ data: { productsCount: { count: 2, precision: 'EXACT' }, collectionsCount: { count: 0, precision: 'EXACT' } } });
        if (name === 'ScoreloProducts') {
          productCalls += 1;
          return gqlResponse({ data: { products: {
            nodes: [{ id: `gid://shopify/Product/${productCalls}`, handle: `p${productCalls}` }],
            pageInfo: { hasNextPage: productCalls < 2, endCursor: `c${productCalls}` },
          } } });
        }
        if (name === 'ScoreloPolicies') return gqlResponse({ data: { shop: { shopPolicies: [] } } });
        if (name === 'ScoreloUrlRedirects') return gqlResponse({ data: { urlRedirects: emptyConnection } });
        const key = name.replace('Scorelo', '').toLowerCase();
        return gqlResponse({ data: { [key]: emptyConnection } });
      },
    });
    const updates: Array<{ step: string; label: string; fraction?: number }> = [];
    await new ShopifyStoreDataProvider(client, 42, 'test.myshopify.com', 100).buildSnapshot((update) => { updates.push(update); });

    const steps = [...new Set(updates.map((update) => update.step))];
    assert.deepEqual(steps.slice(0, 5), ['shop', 'products', 'collections', 'pages', 'articles']);
    assert.ok(steps.indexOf('redirects') < steps.indexOf('handles'));

    // Two product pages against Shopify's count of 2: halfway, then all of it — nothing guessed.
    const products = updates.filter((update) => update.step === 'products').map((update) => [update.label, update.fraction]);
    assert.deepEqual(products, [['Reading products', 0], ['Reading products — 1 of 2', 0.5], ['Reading products — 2 of 2', 1]]);
    // Pages have no count to compare against, so they report what was read and no fraction.
    assert.ok(updates.some((update) => update.step === 'pages' && update.label === 'Reading pages — 0 read' && update.fraction === undefined));
  });
});

describe('ShopifyStoreDataProvider normalization', () => {
  it('builds a snapshot with normalized store identity', async () => {
    const snapshot = await providerFor({ ScoreloShopIdentity: SHOP }).buildSnapshot();
    assert.equal(snapshot.storeId, 42);
    assert.equal(snapshot.shop.name, 'Acme');
    assert.equal(snapshot.shop.email, 'a@b.com');
    assert.equal(snapshot.shop.country, 'United States');
    assert.equal(snapshot.shop.planName, 'Basic');
    assert.equal(snapshot.shop.primaryUrl, 'https://test.myshopify.com');
    assert.equal(snapshot.coverage.shop, true);
  });

  it('uses the merchant custom domain for storefront URLs, not the myshopify domain', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: { shop: { ...SHOP.shop, primaryDomain: { url: 'https://shop.acme.com/', host: 'shop.acme.com' } } },
      ScoreloProducts: productsPage([{ id: 'gid://shopify/Product/1', handle: 'mug' }]),
    }).buildSnapshot();

    // A store on a custom domain serves its pages from that domain; deriving evidence URLs from
    // the myshopify domain would point every finding at the wrong host.
    assert.equal(snapshot.shop.primaryUrl, 'https://shop.acme.com');
    assert.equal(snapshot.products[0].url, 'https://shop.acme.com/products/mug');
  });

  it('fails fast when the shop record is absent — store identity is not optional', async () => {
    const error = await providerFor({}).buildSnapshot().catch((e) => e);
    assert.ok(error instanceof StoreDataError);
    assert.equal(error.code, 'MALFORMED_RESPONSE');
  });

  it('prefers the real onlineStoreUrl over a handle-derived one', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([
        { id: 'gid://shopify/Product/1', handle: 'mug', onlineStoreUrl: 'https://test.myshopify.com/products/mug-2024' },
        { id: 'gid://shopify/Product/2', handle: 'cup', onlineStoreUrl: null },
      ]),
    }).buildSnapshot();

    assert.equal(snapshot.products[0].url, 'https://test.myshopify.com/products/mug-2024');
    // Unpublished products have no onlineStoreUrl, but the address they WOULD have is what a fix
    // recommendation needs to name.
    assert.equal(snapshot.products[1].url, 'https://test.myshopify.com/products/cup');
  });

  it('reduces gids to the numeric id merchants see in admin', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([{ id: 'gid://shopify/Product/9876543210', handle: 'p' }]),
    }).buildSnapshot();
    assert.equal(snapshot.products[0].id, '9876543210');
  });

  it('survives null and missing product fields without crashing', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([
        { id: 'gid://shopify/Product/1' }, // everything absent
        { id: 'gid://shopify/Product/2', title: null, handle: null, descriptionHtml: null, tags: null, media: null, variantsCount: null, seo: null },
      ]),
    }).buildSnapshot();

    assert.equal(snapshot.products.length, 2);
    assert.equal(snapshot.products[0].title, '');
    assert.deepEqual(snapshot.products[1].tags, []);
    assert.deepEqual(snapshot.products[1].images, []);
    assert.equal(snapshot.products[1].variantCount, 0);
    assert.equal(snapshot.products[1].seoTitle, null);
  });

  it('preserves the difference between a missing alt attribute and an empty one', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([
        {
          id: 'gid://shopify/Product/1',
          handle: 'p',
          media: {
            nodes: [
              { id: 'gid://shopify/MediaImage/9', image: { url: 'https://cdn/a.jpg', width: 10, height: 10 } },
              { id: 'gid://shopify/MediaImage/10', alt: '', image: { url: 'https://cdn/b.jpg', width: 10, height: 10 } },
            ],
          },
        },
      ]),
    }).buildSnapshot();

    // null = attribute absent, '' = present but blank. Collapsing these would make the
    // image-alt-text check unable to describe what is actually wrong.
    assert.equal(snapshot.products[0].images[0].alt, null);
    assert.equal(snapshot.products[0].images[1].alt, '');
  });

  it('drops non-image media nodes rather than emitting broken rows', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([
        {
          id: 'gid://shopify/Product/1',
          handle: 'p',
          // A video node matches no inline fragment and comes back as an empty object.
          media: { nodes: [{}, null, { id: 'x', image: null }, { id: 'gid://shopify/MediaImage/2', image: { url: 'https://cdn/ok.jpg' } }] },
        },
      ]),
    }).buildSnapshot();

    assert.equal(snapshot.products[0].images.length, 1);
    assert.equal(snapshot.products[0].images[0].src, 'https://cdn/ok.jpg');
  });

  it('reads SEO overrides from the native seo field on every product, not a sample', async () => {
    // The REST provider could only afford to read SEO for the first 50 products (one extra
    // request each); GraphQL returns it inline, so coverage is now total.
    const nodes = Array.from({ length: 80 }, (_, index) => ({
      id: `gid://shopify/Product/${index}`,
      handle: `p${index}`,
      seo: { title: `SEO ${index}`, description: 'desc' },
      metafields: { nodes: [] },
    }));

    const snapshot = await providerFor({ ScoreloShopIdentity: SHOP, ScoreloProducts: productsPage(nodes) }, 100).buildSnapshot();
    assert.equal(snapshot.products[79].seoTitle, 'SEO 79');
    assert.ok(snapshot.products.every((product) => product.metafieldsAvailable));
    assert.equal(snapshot.coverage.metafields, true);
  });

  it('marks metafields unavailable (not empty) when the connection is absent', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([{ id: 'gid://shopify/Product/1', handle: 'p' }]),
    }).buildSnapshot();

    assert.equal(snapshot.products[0].metafieldsAvailable, false);
    assert.equal(snapshot.coverage.metafields, false, 'must not claim coverage we do not have');
  });

  it('reads page SEO overrides out of global metafields, which Page has no seo field for', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloPages: {
        pages: {
          nodes: [
            {
              id: 'gid://shopify/Page/5',
              title: 'About',
              handle: 'about',
              body: '<p>Hi</p>',
              metafields: {
                nodes: [
                  { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Custom SEO title' },
                  { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: 'Custom SEO description' },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }).buildSnapshot();

    assert.equal(snapshot.pages[0].seoTitle, 'Custom SEO title');
    assert.equal(snapshot.pages[0].seoDescription, 'Custom SEO description');
    assert.equal(snapshot.pages[0].url, 'https://test.myshopify.com/pages/about');
  });

  it('records a warning and degrades coverage when one resource group fails', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloProducts: productsPage([{ id: 'gid://shopify/Product/1', handle: 'p' }]),
      ScoreloCollections: new Error('boom'),
    }).buildSnapshot();

    // Products still captured; only collections degraded.
    assert.equal(snapshot.coverage.products, true);
    assert.equal(snapshot.coverage.collections, false);
    assert.ok(snapshot.warnings.some((w) => w.startsWith('collections:')));
  });

  it('propagates a revoked token instead of silently producing an empty snapshot', async () => {
    const client = new ShopifyClient({
      shopDomain: 'test.myshopify.com',
      accessToken: 'token',
      sleepImpl: async () => {},
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const { query } = JSON.parse(init?.body ?? '{}') as { query: string };
        return query.includes('ScoreloShopIdentity')
          ? gqlResponse({ data: SHOP })
          : new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const error = await new ShopifyStoreDataProvider(client, 42, 'test.myshopify.com', 100).buildSnapshot().catch((e) => e);
    assert.ok(error instanceof StoreDataError);
    assert.equal(error.code, 'TOKEN_REVOKED');
  });

  it('reports the applied scope limit so a partial scan is never presented as complete', async () => {
    const snapshot = await providerFor(
      {
        ScoreloShopIdentity: SHOP,
        ScoreloProducts: {
          products: {
            nodes: [{ id: 'gid://shopify/Product/1', handle: 'a' }],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          },
        },
      },
      1,
    ).buildSnapshot();

    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.scope.productLimit, 1);
    assert.equal(snapshot.scope.productsTruncated, true);
  });

  it('reads manual and automated collections from one connection', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloCollections: {
        collections: {
          nodes: [
            { id: 'gid://shopify/Collection/1', title: 'Manual', handle: 'manual', productsCount: { count: 4 }, seo: { title: 'M', description: null } },
            { id: 'gid://shopify/Collection/2', title: 'Auto', handle: 'auto', productsCount: { count: 9 } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }).buildSnapshot();

    assert.deepEqual(snapshot.collections.map((c) => c.handle).sort(), ['auto', 'manual']);
    assert.equal(snapshot.collections[0].url, 'https://test.myshopify.com/collections/manual');
    assert.equal(snapshot.collections[0].productCount, 4);
    assert.equal(snapshot.collections[0].seoTitle, 'M');
  });

  it('collects articles with blog-scoped URLs from the single articles connection', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloArticles: {
        articles: {
          nodes: [
            {
              id: 'gid://shopify/Article/70',
              title: 'Post',
              handle: 'post',
              body: '<p>x</p>',
              blog: { id: 'gid://shopify/Blog/7', handle: 'news' },
              image: { url: 'https://cdn/hero.jpg', altText: 'Hero', width: 100, height: 50 },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }).buildSnapshot();

    assert.equal(snapshot.articles.length, 1);
    assert.equal(snapshot.articles[0].url, 'https://test.myshopify.com/blogs/news/post');
    assert.equal(snapshot.articles[0].blogId, '7');
    assert.equal(snapshot.articles[0].image?.alt, 'Hero');
  });

  it('lower-cases the policy type enum so downstream checks keep matching', async () => {
    const snapshot = await providerFor({
      ScoreloShopIdentity: SHOP,
      ScoreloPolicies: { shop: { shopPolicies: [{ id: 'gid://shopify/ShopPolicy/1', type: 'REFUND_POLICY', title: 'Refunds', body: 'text', url: 'https://x/policies/refund-policy' }] } },
    }).buildSnapshot();

    assert.equal(snapshot.policies[0].type, 'refund_policy');
    assert.equal(snapshot.policies[0].title, 'Refunds');
  });
});

// ─── Reading every variant where the first 25 cannot settle it ───────
// The products query reads each product's first 25 variants. These run the real provider and the
// real client against a fake Admin API that answers by operation name, and check which products
// are read again, that the reads page to the end, and what happens when one cannot be completed.

describe('ShopifyStoreDataProvider variant completion', () => {
  /** A product node shaped as Shopify returns it: `total` variants, the first `read` returned. */
  const productNode = (id: number, total: number, read: number, available: (index: number) => boolean, extra: Record<string, unknown> = {}) => ({
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `p${id}`,
    status: 'ACTIVE',
    publishedAt: '2025-12-01T00:00:00Z',
    variantsCount: { count: total },
    options: [{ name: 'Size', values: ['S'] }],
    variants: { nodes: Array.from({ length: read }, (_, index) => ({ id: `gid://shopify/ProductVariant/${id}${index}`, sku: null, barcode: null, price: '10.00', availableForSale: available(index) })) },
    metafields: { nodes: [] },
    ...extra,
  });

  /** Serves ScoreloProductVariants 250 at a time, recording each request's variables. */
  function providerWith(products: unknown[], allVariants: Record<string, boolean[]>, failFor: Set<string> = new Set()) {
    const variantCalls: Array<{ id: string; after: string | null }> = [];
    const client = new ShopifyClient({
      shopDomain: 'test.myshopify.com',
      accessToken: 'token',
      sleepImpl: async () => {},
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const { query, variables } = JSON.parse(init?.body ?? '{}') as { query: string; variables: Record<string, unknown> };
        const name = query.match(/query\s+(\w+)/)?.[1] ?? '';
        if (name === 'ScoreloShopIdentity') return gqlResponse({ data: SHOP });
        if (name === 'ScoreloProducts') return gqlResponse({ data: productsPage(products) });
        if (name === 'ScoreloPolicies') return gqlResponse({ data: { shop: { shopPolicies: [] } } });
        if (name === 'ScoreloProductVariants') {
          const id = String(variables.id);
          const after = (variables.after as string | null) ?? null;
          variantCalls.push({ id, after });
          if (failFor.has(id)) return gqlResponse({ errors: [{ message: 'Internal error' }] });
          const flags = allVariants[id] ?? [];
          const start = after ? Number(after) : 0;
          const first = Number(variables.first);
          const slice = flags.slice(start, start + first);
          const end = start + slice.length;
          return gqlResponse({ data: { product: { variants: {
            nodes: slice.map((available, index) => ({ id: `gid://shopify/ProductVariant/${start + index}`, sku: null, barcode: null, price: '10.00', availableForSale: available })),
            pageInfo: { hasNextPage: end < flags.length, endCursor: String(end) },
          } } } });
        }
        const key = name.replace('Scorelo', '').toLowerCase();
        return gqlResponse({ data: { [key]: emptyConnection } });
      },
    });
    return { provider: new ShopifyStoreDataProvider(client, 42, 'test.myshopify.com', 100), variantCalls };
  }

  it('reads the rest of a product whose first 25 variants are all sold out, and finds variant 30 in stock', async () => {
    const id = 'gid://shopify/Product/1';
    const flags = Array.from({ length: 40 }, (_, index) => index === 29);
    const { provider, variantCalls } = providerWith([productNode(1, 40, 25, () => false)], { [id]: flags });

    const snapshot = await provider.buildSnapshot();
    const product = snapshot.products[0];
    assert.deepEqual(variantCalls, [{ id, after: null }]);
    assert.equal(product.variants.length, 40);
    assert.equal(product.variantsTruncated, false);
    assert.equal(product.variants.filter((variant) => variant.availableForSale).length, 1);
  });

  it('pages past 250 variants to the end', async () => {
    const id = 'gid://shopify/Product/2';
    const flags = Array.from({ length: 600 }, () => false);
    const { provider, variantCalls } = providerWith([productNode(2, 600, 25, () => false)], { [id]: flags });

    const snapshot = await provider.buildSnapshot();
    assert.equal(variantCalls.length, 3, '250 + 250 + 100');
    assert.equal(snapshot.products[0].variants.length, 600);
    assert.equal(snapshot.products[0].variantsTruncated, false);
  });

  it('reads nothing more when a variant in the first 25 is already for sale', async () => {
    const { provider, variantCalls } = providerWith([productNode(3, 40, 25, (index) => index === 0)], {});
    const snapshot = await provider.buildSnapshot();
    assert.equal(variantCalls.length, 0);
    assert.equal(snapshot.products[0].variantsTruncated, true, 'still a sample — the checks say so');
  });

  it('reads nothing more for a product no shopper can reach', async () => {
    const { provider, variantCalls } = providerWith([productNode(4, 40, 25, () => false, { status: 'DRAFT' })], {});
    await provider.buildSnapshot();
    assert.equal(variantCalls.length, 0);
  });

  it('reads nothing more for a product whose every variant was already read', async () => {
    const { provider, variantCalls } = providerWith([productNode(5, 10, 10, () => false)], {});
    await provider.buildSnapshot();
    assert.equal(variantCalls.length, 0);
  });

  it('leaves a product partial, with the reason, when Shopify does not return the rest', async () => {
    const id = 'gid://shopify/Product/6';
    const { provider } = providerWith([productNode(6, 40, 25, () => false)], {}, new Set([id]));

    const snapshot = await provider.buildSnapshot();
    assert.equal(snapshot.products[0].variantsTruncated, true, 'never marked complete on a failed read');
    assert.equal(snapshot.products[0].variants.length, 25);
    assert.ok(snapshot.warnings.some((warning) => /variants: product 6 could not be read in full — .*Internal error/.test(warning)));
  });
});
