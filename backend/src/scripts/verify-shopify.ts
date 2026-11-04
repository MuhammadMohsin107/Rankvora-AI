/**
 * Read-only verification of every Shopify GraphQL document against a REAL shop.
 *
 *   npm run verify:shopify
 *
 * Why this exists: the queries in shopify.queries.ts are written against a specific Admin API
 * version. A field that was renamed or deprecated between versions does not fail at build time,
 * at type-check time, or in the unit tests (which mock the transport) — it fails at runtime, in a
 * background worker, against a merchant's store. This script is the only thing that proves the
 * documents are actually valid for the version we pin.
 *
 * It issues GET-equivalent GraphQL reads ONLY. It contains no mutation, writes nothing to
 * Shopify, and writes nothing to the database.
 *
 * Two ways to point it at a shop:
 *
 *   1. A store already connected through OAuth — the default. Reads the encrypted token from
 *      shopify_connections and refreshes it if needed, exactly as an audit run would.
 *        npm run verify:shopify
 *
 *   2. A dev store's custom-app Admin API token, before OAuth is wired up. Useful for validating
 *      the documents against a new API version without installing anything:
 *        SHOPIFY_VERIFY_SHOP=my-dev.myshopify.com SHOPIFY_VERIFY_TOKEN=shpat_… npm run verify:shopify
 *      Pass the token via the environment, never as a command-line argument — argv is visible to
 *      other processes and lands in shell history.
 */
import { isNull } from 'drizzle-orm';
import { closeDatabase, db } from '../db/client.js';
import { shopifyConnections } from '../db/schema.js';
import { getValidAccessToken } from '../services/shopify-oauth.service.js';
import { ShopifyClient, SHOPIFY_API_VERSION } from '../audit-engine/store-data/shopify-client.js';
import {
  ARTICLES_QUERY,
  COLLECTIONS_QUERY,
  PAGES_QUERY,
  POLICIES_QUERY,
  PRODUCTS_QUERY,
  SHOP_IDENTITY_QUERY,
} from '../audit-engine/store-data/shopify.queries.js';

interface Check {
  name: string;
  query: string;
  /** Small page size: this verifies that documents PARSE and RESOLVE, not that the store is big. */
  variables?: Record<string, unknown>;
  describe: (data: any) => string;
}

const CHECKS: Check[] = [
  {
    name: 'shop identity',
    query: SHOP_IDENTITY_QUERY,
    describe: (data) => {
      const shop = data.shop;
      return shop ? `${shop.name} (${shop.myshopifyDomain}) · plan ${shop.plan?.displayName ?? '—'} · ${shop.primaryDomain?.url ?? 'no primary domain'}` : 'no shop returned';
    },
  },
  {
    name: 'products',
    query: PRODUCTS_QUERY,
    variables: { first: 3, after: null },
    describe: (data) => {
      const nodes = data.products?.nodes ?? [];
      const withSeo = nodes.filter((node: any) => node.seo?.title || node.seo?.description).length;
      const withMedia = nodes.filter((node: any) => (node.media?.nodes ?? []).some((media: any) => media?.image?.url)).length;
      return `${nodes.length} sampled · ${withSeo} with SEO overrides · ${withMedia} with images · hasNextPage=${data.products?.pageInfo?.hasNextPage}`;
    },
  },
  {
    name: 'collections',
    query: COLLECTIONS_QUERY,
    variables: { first: 3, after: null },
    describe: (data) => `${(data.collections?.nodes ?? []).length} sampled · hasNextPage=${data.collections?.pageInfo?.hasNextPage}`,
  },
  {
    name: 'pages',
    query: PAGES_QUERY,
    variables: { first: 3, after: null },
    describe: (data) => `${(data.pages?.nodes ?? []).length} sampled · hasNextPage=${data.pages?.pageInfo?.hasNextPage}`,
  },
  {
    name: 'articles',
    query: ARTICLES_QUERY,
    variables: { first: 3, after: null },
    describe: (data) => `${(data.articles?.nodes ?? []).length} sampled · hasNextPage=${data.articles?.pageInfo?.hasNextPage}`,
  },
  {
    name: 'policies',
    query: POLICIES_QUERY,
    describe: (data) => `${(data.shop?.shopPolicies ?? []).length} policies`,
  },
];

async function resolveClient(): Promise<{ client: ShopifyClient; shopDomain: string; source: string }> {
  const overrideShop = process.env.SHOPIFY_VERIFY_SHOP;
  const overrideToken = process.env.SHOPIFY_VERIFY_TOKEN;

  if (overrideShop && overrideToken) {
    return {
      client: new ShopifyClient({ shopDomain: overrideShop, accessToken: overrideToken }),
      shopDomain: overrideShop,
      source: 'SHOPIFY_VERIFY_SHOP / SHOPIFY_VERIFY_TOKEN',
    };
  }

  const [connection] = await db.select().from(shopifyConnections).where(isNull(shopifyConnections.uninstalledAt)).limit(1);
  if (!connection) {
    throw new Error(
      'No connected Shopify store found. Connect one through Integrations, or set SHOPIFY_VERIFY_SHOP and SHOPIFY_VERIFY_TOKEN.',
    );
  }

  return {
    client: new ShopifyClient({ shopDomain: connection.shopDomain, accessToken: await getValidAccessToken(connection) }),
    shopDomain: connection.shopDomain,
    source: `shopify_connections (store ${connection.storeId})`,
  };
}

async function main() {
  const { client, shopDomain, source } = await resolveClient();

  console.log(`\nVerifying Shopify GraphQL documents`);
  console.log(`  API version : ${SHOPIFY_API_VERSION}`);
  console.log(`  Shop        : ${shopDomain}`);
  console.log(`  Credential  : ${source}\n`);

  let failures = 0;

  for (const check of CHECKS) {
    try {
      const data = await client.graphql<any>(check.query, check.variables ?? {});
      console.log(`  PASS  ${check.name.padEnd(15)} ${check.describe(data)}`);
    } catch (error) {
      failures += 1;
      // The message names the offending field when Shopify rejects the document, which is
      // exactly what a version bump needs to surface.
      console.error(`  FAIL  ${check.name.padEnd(15)} ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  console.log(
    failures === 0
      ? `\nAll ${CHECKS.length} documents are valid for ${SHOPIFY_API_VERSION}.\n`
      : `\n${failures} of ${CHECKS.length} documents failed. Fix shopify.queries.ts before deploying.\n`,
  );

  return failures;
}

// Never let an open database keep the process alive after the report is printed.
let exitCode = 1;
try {
  exitCode = (await main()) === 0 ? 0 : 1;
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
} finally {
  closeDatabase();
}
process.exit(exitCode);
