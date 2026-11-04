import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { toGid } from '../services/fix-apply.service.js';
import { applyFixProposalsSchema } from '../schemas/finding.schema.js';
import { SEO_RESOURCE_TYPES } from '../lib/ai/fix-policy.js';

/**
 * ─── Applying a fix to Shopify · what can be proven without a store ──
 *
 * The mutations themselves need a real shop with write scopes, so they are not faked here — a stub
 * would only prove the stub. What IS provable is the layer where this feature actually broke, and
 * the boundary that decides what may reach a live storefront:
 *
 *   · the GID REBUILD, which is where the first real apply failed outright
 *   · the INPUT CONTRACT that decides what a request may carry
 *   · the WRITE-vs-READ agreement, checked against the source, because its failure is silent:
 *     writing a field the audit does not read produces a "successful" fix and an unmoved score
 */

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('gid rebuilding', () => {
  it('builds a full gid from the numeric id the snapshot stores', () => {
    // THE BUG THIS EXISTS FOR. shopify.provider.ts strips gids to their numeric suffix on purpose,
    // so every resourceId reaching the apply path is "123". Passing that to `$id: ID!` fails at
    // Shopify's variable coercion with "provided invalid value" — which is exactly what the first
    // real apply returned, before any mutation ran.
    assert.equal(toGid('product', '123'), 'gid://shopify/Product/123');
    assert.equal(toGid('collection', '456'), 'gid://shopify/Collection/456');
    assert.equal(toGid('page', '789'), 'gid://shopify/Page/789');
    assert.equal(toGid('article', '1011'), 'gid://shopify/Article/1011');
  });

  it('leaves an id that is already a gid untouched', () => {
    // `id()` returns its input unchanged when the tail is not numeric, so both shapes can arrive.
    // Rebuilding an existing gid would produce gid://shopify/Product/gid://shopify/Product/123.
    assert.equal(toGid('product', 'gid://shopify/Product/123'), 'gid://shopify/Product/123');
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(toGid('product', ' 123 '), 'gid://shopify/Product/123');
  });

  it('covers every page-like resource type', () => {
    // A resource type added to the allow-list without a GID_TYPE entry would build
    // `gid://shopify/undefined/123` and be rejected by Shopify at runtime rather than here.
    //
    // `productImage` is deliberately outside this list and outside toGid's type: its id names two
    // resources (`<productId>/<mediaId>`), so it builds its two gids in the media branch of
    // writeField rather than through a single-id helper that would silently mangle it.
    for (const resourceType of SEO_RESOURCE_TYPES) {
      assert.match(toGid(resourceType, '1'), /^gid:\/\/shopify\/[A-Z][A-Za-z]+\/1$/, `bad gid for ${resourceType}`);
    }
  });
});

describe('apply contract', () => {
  it('takes an existing proposal, with or without an edited value', () => {
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: [{ proposalId: 1 }] }).success, true);
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: [{ proposalId: 1, value: 'A better description' }] }).success, true);
  });

  it('takes a hand-written value for a resource that was never drafted', () => {
    // Without this shape, typing a value yourself had nowhere to go — the apply path could only
    // accept rows the model had already proposed.
    assert.equal(
      applyFixProposalsSchema.safeParse({
        fixes: [{ findingId: 7, resourceRef: 'product:123', value: 'Written by hand' }],
      }).success,
      true,
    );
  });

  it('refuses an entry that names both a proposal and a resource', () => {
    // Ambiguous about which resource is meant, and guessing is how the wrong thing gets written.
    assert.equal(
      applyFixProposalsSchema.safeParse({
        fixes: [{ proposalId: 1, findingId: 7, resourceRef: 'product:123', value: 'x' }],
      }).success,
      false,
    );
  });

  it('refuses a manual entry with no value', () => {
    assert.equal(
      applyFixProposalsSchema.safeParse({ fixes: [{ findingId: 7, resourceRef: 'product:123' }] }).success,
      false,
    );
  });

  it('refuses an entry that names neither', () => {
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: [{ value: 'x' }] }).success, false);
  });

  it('refuses a body that tries to name the resource type or field directly', () => {
    // WHICH resource and WHICH field are read from the stored row, never from the request — that is
    // what stops a caller writing an arbitrary field on an arbitrary resource.
    for (const extra of [{ resourceType: 'product' }, { field: 'seo.title' }, { storeId: 2 }]) {
      assert.equal(
        applyFixProposalsSchema.safeParse({ fixes: [{ proposalId: 1, ...extra }] }).success,
        false,
        `accepted ${JSON.stringify(extra)}`,
      );
    }
  });

  it('bounds the batch so one request cannot exceed Shopify\'s budget', () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ proposalId: index + 1 }));
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: many }).success, false);
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: many.slice(0, 100) }).success, true);
  });

  it('requires at least one fix', () => {
    assert.equal(applyFixProposalsSchema.safeParse({ fixes: [] }).success, false);
  });
});

describe('write and read agree', () => {
  it('writes Page and Article SEO to the metafields the audit reads', () => {
    // THE INVARIANT THE WHOLE FEATURE RESTS ON. Page and Article have no `seo` field on their
    // update inputs, so their listing lives in `global.title_tag` / `global.description_tag` — and
    // that is what PAGES_QUERY/ARTICLES_QUERY already read. Writing anywhere else would apply
    // cleanly, report success, and leave the score exactly where it was.
    const apply = source('../services/fix-apply.service.ts');
    assert.ok(apply.includes("'title_tag'"), 'apply no longer writes global.title_tag');
    assert.ok(apply.includes("'description_tag'"), 'apply no longer writes global.description_tag');
    assert.ok(apply.includes("SEO_METAFIELD_NAMESPACE = 'global'"), 'apply no longer writes the global namespace');

    const queries = source('../audit-engine/store-data/shopify.queries.ts');
    assert.ok(queries.includes('namespace: "global"'), 'the audit no longer reads the global namespace');
  });

  it('never logs a proposed value', () => {
    // A proposed value can quote merchant copy, and logs are read by more people than the database.
    const apply = source('../services/fix-apply.service.ts');
    for (const line of apply.split('\n')) {
      if (!/console\.(log|warn|error|info|debug)/.test(line)) continue;
      assert.equal(
        /proposedValue|check\.value|\bvalue\b/.test(line),
        false,
        `logs a value: ${line.trim()}`,
      );
    }
  });
});
