import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlesRedirectsCheck } from '../audit-engine/checks/seo/handles-redirects.js';
import { fetchAllHandles, fetchUrlRedirects } from '../audit-engine/store-data/shopify.queries.js';
import type { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { StoreDataError, type HandleResourceType, type SnapshotHandle, type SnapshotRedirects, type StoreSnapshot } from '../audit-engine/store-data/types.js';
import type { SubPillarResult } from '../audit-engine/types.js';

// ─── Shopify reads ───────────────────────────────────────────────────

/** A client that serves `pages` of a connection in order, recording every request. */
function pagedClient(key: string, pages: unknown[][], options: { stallAt?: number } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async graphql(_query: string, variables: Record<string, unknown>) {
      calls.push(variables);
      const index = calls.length - 1;
      const last = index === pages.length - 1;
      const cursor = options.stallAt !== undefined && index >= options.stallAt ? `c${options.stallAt}` : `c${index}`;
      return { [key]: { pageInfo: { hasNextPage: !last, endCursor: cursor }, nodes: pages[index] ?? [] } };
    },
  };
  return { client: client as unknown as ShopifyClient, calls };
}

const redirectPage = (page: number, size = 250) =>
  Array.from({ length: size }, (_, index) => ({ id: `gid://shopify/UrlRedirect/${page * 1000 + index}`, path: `/old-${page}-${index}`, target: '/' }));

describe('fetchUrlRedirects', () => {
  it('reads every page Shopify has, well past the old 2,000-redirect cap', async () => {
    const pages = Array.from({ length: 12 }, (_, page) => redirectPage(page));
    const { client, calls } = pagedClient('urlRedirects', pages);
    const result = await fetchUrlRedirects(client);
    assert.equal(result.available, true);
    assert.equal(result.available && result.items.length, 3000);
    assert.equal(result.available && result.truncated, false);
    assert.equal(calls.length, 12);
    assert.equal(calls[1]?.after, 'c0', 'each request continues from the previous endCursor');
    assert.equal(result.available && result.items[0]?.id, 'gid://shopify/UrlRedirect/0');
  });

  it('reports a cursor that stops advancing instead of looping or hiding it', async () => {
    const { client } = pagedClient('urlRedirects', [redirectPage(0, 2), redirectPage(1, 2), redirectPage(2, 2), redirectPage(3, 2)], { stallAt: 1 });
    const result = await fetchUrlRedirects(client);
    assert.equal(result.available && result.truncated, true);
  });

  it('names a denied permission as a scope problem, whatever wording Shopify used', async () => {
    const client = { graphql: async () => { throw new StoreDataError('MISSING_SCOPES', 'Shopify denied access to this resource — the app is missing a required scope', false); } } as unknown as ShopifyClient;
    const result = await fetchUrlRedirects(client);
    assert.deepEqual(result.available ? null : result.reason, 'scope');
  });

  it('returns nothing rather than a partial list when a later page fails', async () => {
    let call = 0;
    const client = { graphql: async () => {
      call += 1;
      if (call === 2) throw new StoreDataError('API_UNAVAILABLE', 'Shopify API error 502', true);
      return { urlRedirects: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: redirectPage(0) } };
    } } as unknown as ShopifyClient;
    const result = await fetchUrlRedirects(client);
    assert.equal(result.available, false);
    assert.equal(!result.available && result.reason, 'error');
  });
});

describe('fetchAllHandles', () => {
  it('reads every handle and maps publication from Shopify’s own fields', async () => {
    const { client } = pagedClient('products', [
      [{ id: 'gid://shopify/Product/1', title: 'A', handle: 'a', status: 'ACTIVE', publishedAt: '2026-01-01T00:00:00Z' }],
      [{ id: 'gid://shopify/Product/2', title: 'B', handle: 'b', status: 'DRAFT', publishedAt: null }],
    ]);
    const { items, stalled } = await fetchAllHandles(client, 'product');
    assert.equal(stalled, false);
    assert.deepEqual(items.map((item) => [item.id, item.handle, item.published]), [['1', 'a', true], ['2', 'b', false]]);
  });
});

// ─── The check ───────────────────────────────────────────────────────

function run(snapshot: StoreSnapshot): SubPillarResult {
  const result = handlesRedirectsCheck.execute(snapshot);
  if (result instanceof Promise) throw new Error('unexpected promise');
  return result;
}

function handle(type: HandleResourceType, id: string, handleValue: string, extra: Partial<SnapshotHandle> = {}): SnapshotHandle {
  return { id, type, title: `Title ${id}`, handle: handleValue, blogHandle: type === 'article' ? 'news' : null, published: type === 'collection' ? null : true, ...extra };
}

function snapshot(redirects: SnapshotRedirects, handles: SnapshotHandle[] = [], complete: Partial<Record<HandleResourceType, boolean>> = { product: true, collection: true, page: true, article: true }): StoreSnapshot {
  return {
    storeId: 1,
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    shop: { domain: 'shop.myshopify.com', primaryUrl: 'https://shop.example', name: 'Shop', email: null, currency: 'USD', country: 'US', timezone: 'UTC', planName: null },
    products: [], collections: [], pages: [], articles: [], policies: [],
    policyAccess: { available: true }, theme: null, storefront: null,
    redirects,
    handleIndex: { handles, complete, gaps: {} },
    crawl: null,
    coverage: { shop: true, products: true, collections: true, pages: true, articles: true, policies: true, metafields: false, theme: false, storefront: false, crawl: false },
    scope: { productLimit: 2000, productsAvailable: null, collectionsAvailable: null, productsTruncated: false, collectionsTruncated: false, pagesTruncated: false, articlesTruncated: false },
    warnings: [],
  };
}

let seq = 0;
const r = (path: string, target: string) => ({ id: `gid://shopify/UrlRedirect/${++seq}`, path, target });
const ok = (items: Array<{ id: string; path: string; target: string }>): SnapshotRedirects => ({ available: true, items, truncated: false });
const rowFor = (result: SubPillarResult, path: string) => result.details.evidenceRows.find((row) => row.cells.path === path);

describe('seo.handles-redirects · permission and failure states', () => {
  it('is not scored when the redirect permission is missing, and names the scope', () => {
    const result = run(snapshot({ available: false, reason: 'scope', detail: 'Access denied for urlRedirects field.' }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.details.requiredScope, 'read_online_store_navigation');
    assert.match(result.details.unavailableReason ?? '', /read_online_store_navigation/);
    assert.equal(result.findings.length, 0);
  });

  it('is not scored when Shopify errors, and does not pretend the store has no redirects', () => {
    const result = run(snapshot({ available: false, reason: 'error', detail: 'Shopify API error 502' }));
    assert.equal(result.status, 'unavailable');
    assert.match(result.details.unavailableReason ?? '', /error while Rankvora AI was reading/);
    assert.equal(result.details.requiredScope, undefined);
  });

  it('reports a store with no redirects as measured, not as unavailable', () => {
    const result = run(snapshot(ok([]), [handle('product', '1', 'shirt')]));
    assert.equal(result.status, 'ok');
    assert.equal(result.details.contextValue, '0');
    assert.match(result.details.summary, /no URL redirects/);
    assert.equal(result.analyzedCount, 1);
  });
});

describe('seo.handles-redirects · redirects', () => {
  const catalogue = [handle('product', '1', 'shirt'), handle('product', '2', 'draft-hat', { published: false }), handle('collection', '3', 'sale'), handle('page', '4', 'about')];

  it('passes a redirect that lands straight on a live page', () => {
    const result = run(snapshot(ok([r('/old-shirt', '/products/shirt')]), catalogue));
    assert.equal(rowFor(result, '/old-shirt')?.status, 'Healthy');
    assert.equal(rowFor(result, '/old-shirt')?.cells.hops, 1);
  });

  it('follows a chain to its end, counts the real hops and names the final page', () => {
    const result = run(snapshot(ok([r('/a', '/b'), r('/b', '/c'), r('/c', 'https://shop.example/products/shirt')]), catalogue));
    const row = rowFor(result, '/a');
    assert.equal(row?.status, 'Redirect Chain');
    assert.equal(row?.cells.hops, 3);
    assert.equal(row?.suggested?.value, '/products/shirt');
  });

  it('detects loops of any length, including a redirect to itself', () => {
    const result = run(snapshot(ok([r('/x', '/y'), r('/y', '/z'), r('/z', '/x'), r('/self', '/self/')]), catalogue));
    for (const path of ['/x', '/y', '/z', '/self']) assert.equal(rowFor(result, path)?.status, 'Redirect Loop', path);
  });

  it('flags a redirect ending on a missing or unpublished resource as broken', () => {
    const result = run(snapshot(ok([r('/gone', '/products/no-such-thing'), r('/hat', '/products/draft-hat'), r('/via', '/gone')]), catalogue));
    assert.equal(rowFor(result, '/gone')?.status, 'Broken Redirect');
    assert.match(rowFor(result, '/hat')?.current?.meta ?? '', /not published/);
    assert.equal(rowFor(result, '/via')?.status, 'Broken Redirect', 'a chain that ends broken is broken');
    assert.equal(result.findings[0]?.severity, 'critical');
  });

  it('never calls a destination missing when that type could not be read completely', () => {
    const result = run(snapshot(ok([r('/gone', '/products/no-such-thing')]), catalogue, { product: false, collection: true, page: true, article: true }));
    assert.equal(rowFor(result, '/gone')?.status, 'Healthy');
    assert.match(result.details.summary, /could not confirm/);
  });

  it('does not judge other websites or non-resource paths', () => {
    const result = run(snapshot(ok([r('/ext', 'https://other.example/page'), r('/fr', '/fr/products/shirt'), r('/app-a', '/apps/indexgpt/a'), r('/app-b', '/apps/indexgpt/b')]), catalogue));
    assert.equal(rowFor(result, '/ext')?.status, 'Healthy');
    assert.equal(rowFor(result, '/fr')?.status, 'Healthy');
    assert.match(result.details.summary, /1 redirect leads to other websites/);
    assert.match(result.details.summary, /1 redirect ends on a path that is not a product/);
    // App-proxy targets are named as such, not lumped in with unknown paths.
    assert.match(result.details.summary, /2 redirects go to app pages \(\/apps\/…\)/);
    assert.match(rowFor(result, '/app-a')?.current?.meta ?? '', /app page served by an app installed on your store/);
    assert.equal(rowFor(result, '/app-a')?.status, 'Healthy');
  });

  it('flags a redirect whose source is a live published page as inactive — but not an unpublished one', () => {
    const result = run(snapshot(ok([r('/products/shirt', '/pages/about'), r('/products/draft-hat', '/products/shirt'), r('/collections/sale', '/pages/about')]), catalogue));
    assert.equal(rowFor(result, '/products/shirt')?.status, 'Inactive Redirect');
    assert.equal(rowFor(result, '/products/draft-hat')?.status, 'Healthy', 'an unpublished page 404s, so its redirect applies');
    assert.equal(rowFor(result, '/collections/sale')?.status, 'Healthy', 'collection publication is unknown, so it is not claimed inactive');
  });

  it('flags two redirects for the same path', () => {
    const result = run(snapshot(ok([r('/dup', '/products/shirt'), r('/DUP/', '/pages/about')]), catalogue));
    assert.equal(result.findings.find((finding) => finding.details.issueType === 'Duplicate Source')?.affectedCount, 2);
  });

  it('flags an unusable target', () => {
    const result = run(snapshot(ok([r('/bad', '   ')]), catalogue));
    assert.equal(rowFor(result, '/bad')?.status, 'Invalid Target');
  });
});

describe('seo.handles-redirects · handles', () => {
  it('flags copy-of handles and badly formatted handles, suggesting a free replacement', () => {
    const result = run(snapshot(ok([]), [
      handle('product', '1', 'copy-of-shirt'),
      handle('page', '2', 'Shipping_Info'),
      handle('page', '3', 'Size_Guide'),
      handle('page', '4', 'size-guide'),
    ]));
    assert.equal(rowFor(result, '/products/copy-of-shirt')?.status, 'Copy Handle');
    assert.equal(rowFor(result, '/pages/Shipping_Info')?.suggested?.value, 'shipping-info');
    assert.equal(rowFor(result, '/pages/Size_Guide')?.suggested, undefined, 'no suggestion that collides with an existing handle');
  });

  it('skips unpublished items and does not treat numbered handles as a problem', () => {
    const result = run(snapshot(ok([]), [handle('product', '1', 'whey-protein-2'), handle('product', '2', 'copy-of-x', { published: false })]));
    assert.equal(result.findings.length, 0);
    assert.equal(result.analyzedCount, 1);
    assert.match(result.details.summary, /1 unpublished item was not checked/);
  });
});
