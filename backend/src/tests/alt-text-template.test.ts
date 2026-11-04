import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_ALT_TEXT_CONFIG,
  MAX_CHARACTER_LIMIT,
  MIN_CHARACTER_LIMIT,
  extractPlaceholders,
  generateAltText,
  placeholderKeys,
  removeDuplicateWords,
  validateTypeConfig,
  type AltTextTypeConfig,
} from '../lib/alt-text/template.js';

/**
 * The alt-text engine is pure — no database, no Shopify, no clock — so it is tested directly.
 * These cover the behaviours the UI promises the merchant: what a template may contain, and what
 * the pipeline does to the value before it would ever reach a store.
 */

const base: AltTextTypeConfig = { ...DEFAULT_ALT_TEXT_CONFIG.products };

const withConfig = (overrides: Partial<AltTextTypeConfig> = {}): AltTextTypeConfig => ({ ...base, ...overrides });

describe('alt-text template validation', () => {
  it('accepts the shipped defaults for every content type', () => {
    assert.deepEqual(validateTypeConfig('products', DEFAULT_ALT_TEXT_CONFIG.products), []);
    assert.deepEqual(validateTypeConfig('articles', DEFAULT_ALT_TEXT_CONFIG.articles), []);
  });

  it('rejects an empty template', () => {
    const issues = validateTypeConfig('products', withConfig({ template: '   ' }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.field, 'template');
  });

  it('rejects an unknown placeholder and names it', () => {
    const issues = validateTypeConfig('products', withConfig({ template: '{{unknown_field}}' }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /\{\{unknown_field\}\}/);
  });

  it("rejects a placeholder belonging to another content type", () => {
    // article_title is real, but there is no article behind a product image.
    const issues = validateTypeConfig('products', withConfig({ template: '{{article_title}}' }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /not available for products/);
  });

  it('rejects malformed placeholder syntax', () => {
    const issues = validateTypeConfig('products', withConfig({ template: '{{product_title}' }));
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /not closed|double braces/);
  });

  it('bounds the character limit', () => {
    assert.equal(validateTypeConfig('products', withConfig({ characterLimit: MIN_CHARACTER_LIMIT - 1 })).length, 1);
    assert.equal(validateTypeConfig('products', withConfig({ characterLimit: MAX_CHARACTER_LIMIT + 1 })).length, 1);
    assert.equal(validateTypeConfig('products', withConfig({ characterLimit: 125 })).length, 0);
  });

  it('refuses to store automatic generation while it cannot run', () => {
    const issues = validateTypeConfig('products', withConfig({ autoGenerate: true }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.field, 'autoGenerate');
  });

  it('only exposes placeholders that exist for the content type', () => {
    assert.ok(placeholderKeys('products').includes('vendor'));
    assert.ok(!placeholderKeys('articles').includes('vendor'));
    assert.deepEqual(extractPlaceholders('{{product_title}} - {{shop_name}}'), ['product_title', 'shop_name']);
  });
});

describe('duplicate-word normalization', () => {
  it('removes a repeated word', () => {
    assert.equal(removeDuplicateWords('Red Red Cotton Shirt Shirt'), 'Red Cotton Shirt');
  });

  it('keeps connecting words that legitimately repeat', () => {
    assert.equal(removeDuplicateWords('Salt and Pepper and Herb Grinder'), 'Salt and Pepper and Herb Grinder');
  });

  it('is case-insensitive but preserves the first spelling', () => {
    assert.equal(removeDuplicateWords('Cotton cotton Shirt'), 'Cotton Shirt');
  });
});

describe('alt-text generation', () => {
  it('resolves placeholders from real values', () => {
    const result = generateAltText(
      '{{product_title}} - {{vendor}}',
      { product_title: 'Classic Cotton Shirt', vendor: 'Acme' },
      withConfig({ autoFormat: 'none' }),
    );
    assert.equal(result.value, 'Classic Cotton Shirt - Acme');
    assert.equal(result.skipped, false);
  });

  it('drops the dangling separator when a value is genuinely missing', () => {
    // A product with no vendor must not produce "Shirt by ".
    const result = generateAltText(
      '{{product_title}} by {{vendor}}',
      { product_title: 'Classic Cotton Shirt', vendor: null },
      withConfig({ autoFormat: 'none' }),
    );
    assert.equal(result.value, 'Classic Cotton Shirt');
  });

  it('applies the selected format', () => {
    const context = { product_title: 'classic cotton shirt' };
    assert.equal(generateAltText('{{product_title}}', context, withConfig({ autoFormat: 'sentence' })).value, 'Classic cotton shirt');
    assert.equal(generateAltText('{{product_title}}', context, withConfig({ autoFormat: 'upper' })).value, 'CLASSIC COTTON SHIRT');
    assert.equal(generateAltText('{{product_title}}', context, withConfig({ autoFormat: 'lower' })).value, 'classic cotton shirt');
  });

  it('honours the character limit without cutting a word in half', () => {
    const result = generateAltText(
      '{{product_title}}',
      { product_title: 'Classic Cotton Shirt With A Very Long Descriptive Name' },
      withConfig({ characterLimit: MIN_CHARACTER_LIMIT, autoFormat: 'none' }),
    );
    assert.ok(result.value.length <= MIN_CHARACTER_LIMIT);
    assert.equal(result.truncated, true);
    assert.ok(!result.value.endsWith(' '));
    // The value stops at a word boundary rather than mid-word.
    assert.ok('Classic Cotton Shirt With A Very Long Descriptive Name'.startsWith(result.value));
  });

  it('preserves existing alt text when skipExisting is on', () => {
    const result = generateAltText(
      '{{product_title}}',
      { product_title: 'Classic Cotton Shirt' },
      withConfig({ skipExisting: true }),
      'Merchant-written description',
    );
    assert.equal(result.skipped, true);
    assert.equal(result.value, 'Merchant-written description');
  });

  it('treats an empty alt attribute as missing, not as existing text', () => {
    // '' marks a decorative image; a product photo is not decorative, so it is generated for.
    const result = generateAltText(
      '{{product_title}}',
      { product_title: 'Classic Cotton Shirt' },
      withConfig({ skipExisting: true }),
      '',
    );
    assert.equal(result.skipped, false);
    assert.equal(result.value, 'Classic Cotton Shirt');
  });

  it('overwrites existing alt text only when skipExisting is off', () => {
    const result = generateAltText(
      '{{product_title}}',
      { product_title: 'Classic Cotton Shirt' },
      withConfig({ skipExisting: false }),
      'Old text',
    );
    assert.equal(result.skipped, false);
    assert.equal(result.value, 'Classic Cotton Shirt');
  });

  it('de-duplicates words across resolved placeholders', () => {
    const result = generateAltText(
      '{{product_title}} - {{vendor}}',
      { product_title: 'Acme Cotton Shirt', vendor: 'Acme' },
      withConfig({ removeDuplicateWords: true, autoFormat: 'none' }),
    );
    assert.equal(result.value, 'Acme Cotton Shirt');
  });
});
