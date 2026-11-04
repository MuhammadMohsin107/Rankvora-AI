import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyClient, SHOPIFY_API_VERSION, type Connection } from '../audit-engine/store-data/shopify-client.js';
import { StoreDataError } from '../audit-engine/store-data/types.js';

function gqlResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function clientWith(fetchImpl: Parameters<typeof makeClient>[0], maxRetries = 3) {
  return makeClient(fetchImpl, maxRetries);
}

function makeClient(
  fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>,
  maxRetries = 3,
) {
  const sleeps: number[] = [];
  const client = new ShopifyClient({
    shopDomain: 'test.myshopify.com',
    accessToken: 'token',
    maxRetries,
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, sleeps };
}

const THROTTLE_OK = { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1900, restoreRate: 100 } } };

describe('ShopifyClient transport', () => {
  it('targets the GraphQL endpoint on a currently supported API version', async () => {
    // 2025-01 stopped being accessible in January 2026; a stale pin here fails every call.
    assert.match(SHOPIFY_API_VERSION, /^\d{4}-\d{2}$/);
    assert.ok(SHOPIFY_API_VERSION >= '2026-01', `API version ${SHOPIFY_API_VERSION} is out of support`);

    let seenUrl = '';
    let seenMethod = '';
    let seenToken = '';
    const { client } = makeClient(async (url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? '';
      seenToken = init?.headers?.['X-Shopify-Access-Token'] ?? '';
      return gqlResponse({ data: { ok: true }, extensions: THROTTLE_OK });
    });

    await client.graphql('query { ok }');
    assert.equal(seenUrl, `https://test.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    assert.equal(seenMethod, 'POST');
    assert.equal(seenToken, 'token');
  });

  it('sends the query and variables as the JSON body', async () => {
    let body: unknown;
    const { client } = makeClient(async (_url, init) => {
      body = JSON.parse(init?.body ?? '{}');
      return gqlResponse({ data: { ok: 1 } });
    });

    await client.graphql('query Q($first: Int!) { x }', { first: 50 });
    assert.deepEqual(body, { query: 'query Q($first: Int!) { x }', variables: { first: 50 } });
  });

  it('treats 401 as a revoked token and does not retry it', async () => {
    let calls = 0;
    const { client } = makeClient(async () => {
      calls += 1;
      return gqlResponse({}, 401);
    });

    const error = await client.graphql('query { x }').catch((e) => e);
    assert.ok(error instanceof StoreDataError);
    assert.equal(error.code, 'TOKEN_REVOKED');
    assert.equal(error.retryable, false);
    assert.equal(calls, 1, 'a revoked token is permanent — retrying only wastes the run');
  });

  it('treats 403 as a missing scope', async () => {
    const { client } = makeClient(async () => gqlResponse({}, 403));
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MISSING_SCOPES');
  });

  it('retries 429 using Retry-After and then succeeds', async () => {
    let calls = 0;
    const { client, sleeps } = makeClient(async () => {
      calls += 1;
      return calls === 1 ? gqlResponse({}, 429, { 'Retry-After': '3' }) : gqlResponse({ data: { ok: 1 } });
    });

    assert.deepEqual(await client.graphql('query { x }'), { ok: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [3000]);
  });

  it('gives up on 429 after maxRetries with a retryable rate-limit error', async () => {
    const { client } = makeClient(async () => gqlResponse({}, 429), 2);
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'RATE_LIMITED');
    assert.equal((error as StoreDataError).retryable, true);
  });

  it('retries 5xx and network failures with exponential backoff', async () => {
    let calls = 0;
    const { client, sleeps } = makeClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      if (calls === 2) return gqlResponse({}, 503);
      return gqlResponse({ data: { ok: 1 } });
    });

    await client.graphql('query { x }');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [500, 1000], 'backoff must grow, not hammer a struggling API');
  });

  it('backs off and retries a THROTTLED GraphQL error rather than failing the run', async () => {
    let calls = 0;
    const { client, sleeps } = makeClient(async () => {
      calls += 1;
      return calls === 1
        ? gqlResponse({
            errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
            extensions: { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 } } },
          })
        : gqlResponse({ data: { ok: 1 } });
    });

    assert.deepEqual(await client.graphql('query { x }'), { ok: 1 });
    assert.equal(calls, 2);
    assert.ok(sleeps[0] >= 1000, 'must wait for the cost bucket to refill');
  });

  it('maps an ACCESS_DENIED GraphQL error to a missing scope', async () => {
    const { client } = makeClient(async () =>
      gqlResponse({ errors: [{ message: 'Access denied for pages field', extensions: { code: 'ACCESS_DENIED' } }] }),
    );
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MISSING_SCOPES');
    assert.match((error as StoreDataError).message, /Access denied for pages field/);
  });

  it('surfaces a schema error message so a bad query is diagnosable', async () => {
    const { client } = makeClient(async () => gqlResponse({ errors: [{ message: "Field 'bodyHtml' doesn't exist" }] }));
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MALFORMED_RESPONSE');
    assert.match((error as StoreDataError).message, /bodyHtml/);
  });

  it('handles the bare-string errors shape Shopify returns for auth failures', async () => {
    const { client } = makeClient(async () => gqlResponse({ errors: '[API] Invalid API key or access token' }));
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MALFORMED_RESPONSE');
    assert.match((error as StoreDataError).message, /Invalid API key/);
  });

  it('rejects a non-JSON body instead of crashing the worker', async () => {
    const { client } = makeClient(async () => new Response('<html>maintenance</html>', { status: 200 }));
    const error = await client.graphql('query { x }').catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MALFORMED_RESPONSE');
  });

  it('pauses when the shop cost bucket runs low', async () => {
    const { client, sleeps } = makeClient(async () =>
      gqlResponse({
        data: { ok: 1 },
        extensions: { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } } },
      }),
    );

    await client.graphql('query { x }');
    // Bucket is at 5% of maximum, below the 20% floor — refilling to the floor takes 3s.
    assert.deepEqual(sleeps, [3000]);
  });

  it('does not pause while the cost bucket is healthy', async () => {
    const { client, sleeps } = makeClient(async () => gqlResponse({ data: { ok: 1 }, extensions: THROTTLE_OK }));
    await client.graphql('query { x }');
    assert.deepEqual(sleeps, []);
  });
});

/** Builds a fake paginated connection over `total` items, `pageSize` at a time. */
function paginatedFetch(total: number) {
  const requests: Array<{ first: number; after: string | null }> = [];
  const fetchImpl = async (_url: string, init?: { body?: string }) => {
    const { variables } = JSON.parse(init?.body ?? '{}') as { variables: { first: number; after: string | null } };
    requests.push({ first: variables.first, after: variables.after });
    const start = variables.after ? Number(variables.after) : 0;
    const end = Math.min(total, start + variables.first);
    const nodes = Array.from({ length: end - start }, (_, index) => ({ id: `gid://shopify/Product/${start + index}` }));
    return gqlResponse({
      data: { products: { nodes, pageInfo: { hasNextPage: end < total, endCursor: end < total ? String(end) : null } } },
      extensions: THROTTLE_OK,
    });
  };
  return { fetchImpl, requests };
}

type ProductsData = { products: Connection<{ id: string }> };

describe('ShopifyClient.paginate', () => {
  it('walks every page until hasNextPage is false', async () => {
    const { fetchImpl, requests } = paginatedFetch(600);
    const { client } = clientWith(fetchImpl);

    const result = await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 1000);
    assert.equal(result.items.length, 600);
    assert.equal(result.truncated, false);
    assert.equal(requests.length, 3, '600 items at 250/page is three round trips');
    assert.deepEqual(requests.map((request) => request.after), [null, '250', '500']);
  });

  it('never asks for more than Shopify allows per page', async () => {
    const { fetchImpl, requests } = paginatedFetch(400);
    const { client } = clientWith(fetchImpl);
    await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 1000);
    assert.ok(requests.every((request) => request.first <= 250));
  });

  it('stops at the limit and reports truncation honestly', async () => {
    const { fetchImpl } = paginatedFetch(1000);
    const { client } = clientWith(fetchImpl);

    const result = await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 300);
    assert.equal(result.items.length, 300);
    assert.equal(result.truncated, true, 'a partial scan must never be presented as complete');
  });

  it('does not claim truncation when the limit exactly matches the catalogue', async () => {
    const { fetchImpl } = paginatedFetch(250);
    const { client } = clientWith(fetchImpl);
    const result = await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 250);
    assert.equal(result.items.length, 250);
    assert.equal(result.truncated, false);
  });

  it('requests only the remainder on the final page', async () => {
    const { fetchImpl, requests } = paginatedFetch(1000);
    const { client } = clientWith(fetchImpl);
    await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 260);
    assert.deepEqual(requests.map((request) => request.first), [250, 10]);
  });

  it('breaks out if the cursor ever stops advancing', async () => {
    let calls = 0;
    const { client } = makeClient(async () => {
      calls += 1;
      return gqlResponse({
        // A stuck cursor would otherwise loop forever inside a background worker.
        data: { products: { nodes: [{ id: '1' }], pageInfo: { hasNextPage: true, endCursor: 'same' } } },
        extensions: THROTTLE_OK,
      });
    });

    const result = await client.paginate<{ id: string }, ProductsData>('query', (data) => data.products, 5000);
    assert.equal(calls, 2, 'second identical cursor must end the walk');
    assert.equal(result.items.length, 2);
  });

  it('rejects a response whose connection is missing rather than returning an empty list', async () => {
    const { client } = makeClient(async () => gqlResponse({ data: {}, extensions: THROTTLE_OK }));
    const error = await client
      .paginate<{ id: string }, ProductsData>('query', (data) => data.products, 100)
      .catch((e) => e);
    assert.equal((error as StoreDataError).code, 'MALFORMED_RESPONSE');
  });
});
