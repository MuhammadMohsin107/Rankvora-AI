// ─── Workspace & store · filled from the connected shop (npm test) ───
//
// THE PROPERTIES THESE TESTS PROTECT:
//   · Every value written comes from what Shopify reported. Nothing Shopify did not say is filled.
//   · A value the merchant edited by hand is never overwritten by a later refresh.
//   · The stand-ins earlier builds wrote before a shop was connected ("My store", example.com, a
//     UTC timezone, the first entries of hand-written option lists) are replaced, because they
//     were never anyone's answer.
//
// planProfileUpdate is pure, so every rule is asserted without a database or a network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { factsFromShop, planProfileUpdate, storedFacts, type ShopifyStoreFacts } from '../services/store-profile.service.js';

const SHOP = 'ayra-dev.myshopify.com';

function facts(overrides: Partial<ShopifyStoreFacts> = {}): ShopifyStoreFacts {
  return {
    shopDomain: SHOP,
    name: 'Ayra Dev Asad',
    url: 'https://ayra.example-store.com',
    country: 'Pakistan',
    currency: 'PKR',
    timezone: 'Asia/Karachi',
    readAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    workspaceName: 'Ahmad Naeem\'s workspace',
    name: '',
    url: '',
    country: 'Unspecified',
    currency: 'Unspecified',
    timezone: 'Unspecified',
    shopifyProfile: null as unknown,
    ...overrides,
  };
}

describe('filling a store that holds nothing real yet', () => {
  it('fills every field Shopify reported', () => {
    const updates = planProfileUpdate(row(), facts(), 'Ahmad Naeem\'s workspace');
    assert.deepEqual(updates, {
      workspaceName: 'Ayra Dev Asad',
      name: 'Ayra Dev Asad',
      url: 'https://ayra.example-store.com',
      country: 'Pakistan',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
    });
  });

  it('replaces the stand-ins earlier builds wrote at signup', () => {
    const updates = planProfileUpdate(
      row({ name: 'My store', url: 'https://example.com', timezone: '(UTC+00:00) UTC', currency: 'USD — US Dollar' }),
      facts(),
      null,
    );
    assert.equal(updates.name, 'Ayra Dev Asad');
    assert.equal(updates.url, 'https://ayra.example-store.com');
    assert.equal(updates.timezone, 'Asia/Karachi');
    assert.equal(updates.currency, 'PKR');
  });

  it('replaces the myshopify address Rankvora AI wrote at connect time with the primary domain', () => {
    const updates = planProfileUpdate(row({ url: `https://${SHOP}` }), facts(), null);
    assert.equal(updates.url, 'https://ayra.example-store.com');
  });
});

describe('never inventing a value', () => {
  it('leaves a field alone when Shopify did not report it', () => {
    const updates = planProfileUpdate(row(), facts({ country: null, timezone: null }), null);
    assert.equal('country' in updates, false, 'no country was reported, so none is written');
    assert.equal('timezone' in updates, false);
  });

  it('builds no fact from an empty or blank value', () => {
    const built = factsFromShop({ shopDomain: SHOP, name: '   ', primaryUrl: null, country: '', currency: null, timezone: null });
    assert.equal(built.name, null);
    assert.equal(built.country, null);
    // The myshopify address is Shopify's own answer for where the store lives.
    assert.equal(built.url, `https://${SHOP}`);
  });

  it('reads nothing from a malformed stored profile', () => {
    assert.equal(storedFacts('not an object'), null);
    assert.equal(storedFacts({ name: 'x' }), null, 'a profile without its shop and read time is not trusted');
  });
});

describe('keeping what the merchant edited', () => {
  it('never overwrites a hand-edited value on a later refresh', () => {
    // Shopify said "Ayra Dev Asad" last time; the merchant has since typed their own name.
    const updates = planProfileUpdate(
      row({ name: 'Ayra Snow Co.', shopifyProfile: facts() }),
      facts(),
      null,
    );
    assert.equal('name' in updates, false);
  });

  it('keeps a value typed before Shopify was ever read', () => {
    // e.g. guided setup's old habit of writing its answer into the store name.
    const updates = planProfileUpdate(row({ name: 'fdfd' }), facts(), null);
    assert.equal('name' in updates, false, 'a value somebody typed is theirs until they change it');
  });

  it('follows Shopify for a value nobody touched', () => {
    // Currency still equals what Shopify said last time; the merchant has since switched to USD.
    const updates = planProfileUpdate(
      row({ currency: 'PKR', shopifyProfile: facts() }),
      facts({ currency: 'USD' }),
      null,
    );
    assert.equal(updates.currency, 'USD');
  });

  it('keeps a workspace name the merchant chose, and replaces only the generated one', () => {
    assert.equal('workspaceName' in planProfileUpdate(row({ workspaceName: 'Tetralogix' }), facts(), 'Ahmad Naeem\'s workspace'), false);
    assert.equal(planProfileUpdate(row(), facts(), 'Ahmad Naeem\'s workspace').workspaceName, 'Ayra Dev Asad');
  });
});

describe('a different shop connected to the same workspace', () => {
  it('replaces the old shop’s details but keeps the organisation’s name', () => {
    const updates = planProfileUpdate(
      row({
        workspaceName: 'Tetralogix',
        name: 'Old Shop',
        url: 'https://old-shop.com',
        country: 'Canada',
        currency: 'CAD',
        timezone: 'America/Toronto',
        shopifyProfile: facts({ shopDomain: 'old-shop.myshopify.com', name: 'Old Shop', url: 'https://old-shop.com', country: 'Canada', currency: 'CAD', timezone: 'America/Toronto' }),
      }),
      facts(),
      null,
    );
    assert.equal(updates.name, 'Ayra Dev Asad');
    assert.equal(updates.url, 'https://ayra.example-store.com');
    assert.equal(updates.currency, 'PKR');
    assert.equal('workspaceName' in updates, false);
  });
});
