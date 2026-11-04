// ─── Missing images: upload, AI drawing, attach (npm test) ───────────
//
// What can be proven without a store or an AI account: the file checks that decide what may reach a
// storefront, the signed receipt that decides which file may be attached to which product, how
// Rankvora AI reads Shopify's and the AI vendors' answers (with their transports stubbed), and the
// prompt — built from the product's own words and nothing else.
//
// The stubs prove Rankvora AI's handling of each answer, not that Shopify or the vendor answers that
// way: the real upload, attach and drawing are verified live on staging.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ShopifyClient } from '../audit-engine/store-data/shopify-client.js';
import { checkProductImage, safeImageFilename, sniffImage, MAX_IMAGE_BYTES } from '../lib/images/image-file.js';
import { signStagedImage, verifyStagedImage, STAGED_IMAGE_TTL_SECONDS } from '../lib/images/staged-image-token.js';
import {
  attachImage,
  MediaUploadError,
  scanProductsWithoutImages,
  stageImage,
  titleSearchQuery,
} from '../services/shopify-media.service.js';
import { buildProductImagePrompt, generateProductImage, imageGenerationStatus } from '../lib/ai/image-provider.js';
import { openAiImageProvider } from '../lib/ai/openai.image.js';
import { geminiImageProvider } from '../lib/ai/gemini.image.js';
import { aiImageFailureMessage } from '../services/product-image.service.js';
import { env } from '../config/env.js';

// ─── Image bytes, built header-first ─────────────────────────────────

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const text = (value: string) => [...Buffer.from(value, 'latin1')];

function png(width: number, height: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...text('IHDR'), ...u32be(width), ...u32be(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, ...u16be(16), ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

function gif(width: number, height: number): Buffer {
  return Buffer.from([...text('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

function webpVp8x(width: number, height: number): Buffer {
  return Buffer.from([...text('RIFF'), ...u32le(22), ...text('WEBP'), ...text('VP8X'), ...u32le(10), 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

function webpVp8l(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return Buffer.from([...text('RIFF'), ...u32le(17), ...text('WEBP'), ...text('VP8L'), ...u32le(5), 0x2f, ...u32le(bits)]);
}

function webpVp8(width: number, height: number): Buffer {
  return Buffer.from([...text('RIFF'), ...u32le(22), ...text('WEBP'), ...text('VP8 '), ...u32le(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
}

describe('image file checks', () => {
  it('reads the real type and size from each accepted format', () => {
    assert.deepEqual(sniffImage(png(800, 600)), { mimeType: 'image/png', width: 800, height: 600 });
    assert.deepEqual(sniffImage(jpeg(1200, 900)), { mimeType: 'image/jpeg', width: 1200, height: 900 });
    assert.deepEqual(sniffImage(gif(64, 32)), { mimeType: 'image/gif', width: 64, height: 32 });
    assert.deepEqual(sniffImage(webpVp8x(2048, 1536)), { mimeType: 'image/webp', width: 2048, height: 1536 });
    assert.deepEqual(sniffImage(webpVp8l(300, 200)), { mimeType: 'image/webp', width: 300, height: 200 });
    assert.deepEqual(sniffImage(webpVp8(640, 480)), { mimeType: 'image/webp', width: 640, height: 480 });
  });

  it('refuses bytes that are not an accepted image, whatever they are called', () => {
    const pdf = Buffer.from('%PDF-1.7\n...', 'latin1');
    const check = checkProductImage(pdf, 'image/jpeg');
    assert.equal(check.ok, false);
    assert.equal(!check.ok && check.code, 'IMAGE_TYPE_UNSUPPORTED');
    assert.equal(checkProductImage(Buffer.alloc(0)).ok, false);
  });

  it('refuses a declared type that disagrees with the bytes', () => {
    const check = checkProductImage(png(100, 100), 'image/jpeg');
    assert.equal(!check.ok && check.code, 'IMAGE_TYPE_MISMATCH');
    // A charset or other parameter on the header is not a disagreement.
    assert.equal(checkProductImage(png(100, 100), 'image/png; charset=binary').ok, true);
  });

  it('holds images to Shopify’s size, pixel and aspect limits', () => {
    assert.equal(checkProductImage(jpeg(4472, 4472)).ok, true);
    const tooWide = checkProductImage(jpeg(4473, 100));
    assert.equal(!tooWide.ok && tooWide.code, 'IMAGE_DIMENSIONS');
    const tooThin = checkProductImage(png(2000, 10));
    assert.equal(!tooThin.ok && tooThin.code, 'IMAGE_DIMENSIONS');
    const tooBig = checkProductImage(Buffer.concat([png(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]));
    assert.equal(!tooBig.ok && tooBig.code, 'IMAGE_TOO_LARGE');
  });

  it('names the stored file safely, with the extension the bytes call for', () => {
    assert.equal(safeImageFilename('My Photo (1).JPEG', 'image/png', 'x'), 'my-photo-1.png');
    assert.equal(safeImageFilename('../../etc/passwd', 'image/jpeg', 'x'), 'etc-passwd.jpg');
    assert.equal(safeImageFilename(undefined, 'image/webp', 'Blue Snowboard'), 'blue-snowboard.webp');
    assert.equal(safeImageFilename('', 'image/gif', ''), 'product-image.gif');
  });
});

// ─── The signed receipt for a staged drawing ─────────────────────────

describe('staged image receipt', () => {
  const claims = { storeId: 7, productId: '123', resourceUrl: 'https://shopify-staged-uploads.storage.googleapis.com/tmp/1/a.jpg', mimeType: 'image/jpeg', width: 1024, height: 1024 };

  it('verifies for the store and product it was issued for', () => {
    const { token } = signStagedImage(claims);
    const verdict = verifyStagedImage(token, { storeId: 7, productId: '123' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.claims.resourceUrl, claims.resourceUrl);
  });

  it('refuses another store or another product', () => {
    const { token } = signStagedImage(claims);
    assert.deepEqual(verifyStagedImage(token, { storeId: 8, productId: '123' }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(verifyStagedImage(token, { storeId: 7, productId: '124' }), { ok: false, reason: 'mismatch' });
  });

  it('refuses a receipt whose contents were changed — the URL cannot be swapped', () => {
    const { token } = signStagedImage(claims);
    const [payload, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    forged.resourceUrl = 'https://attacker.example/evil.jpg';
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    assert.deepEqual(verifyStagedImage(tampered, { storeId: 7, productId: '123' }), { ok: false, reason: 'signature' });
    assert.deepEqual(verifyStagedImage('not-a-token', { storeId: 7, productId: '123' }), { ok: false, reason: 'malformed' });
  });

  it('expires after the hour', () => {
    const issuedAt = Date.now();
    const { token } = signStagedImage(claims, issuedAt);
    assert.equal(verifyStagedImage(token, { storeId: 7, productId: '123' }, issuedAt + (STAGED_IMAGE_TTL_SECONDS - 1) * 1000).ok, true);
    assert.deepEqual(verifyStagedImage(token, { storeId: 7, productId: '123' }, issuedAt + (STAGED_IMAGE_TTL_SECONDS + 1) * 1000), { ok: false, reason: 'expired' });
  });
});

// ─── Shopify: finding, staging and attaching ─────────────────────────

type GraphqlHandler = (query: string, variables: Record<string, unknown>) => unknown;

function shopify(handler: GraphqlHandler) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new ShopifyClient({
    shopDomain: 'test.myshopify.com',
    accessToken: 'token',
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      return new Response(JSON.stringify({ data: handler(body.query, body.variables) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { client, calls };
}

const productNode = (id: number, images: number, extra: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  handle: `product-${id}`,
  status: 'ACTIVE',
  productType: '',
  vendor: 'Acme',
  updatedAt: '2026-09-01T00:00:00Z',
  images: { nodes: Array.from({ length: images }, (_, i) => ({ id: `gid://shopify/MediaImage/${id}${i}` })) },
  mediaCount: { count: images },
  ...extra,
});

describe('finding products with no image', () => {
  it('keeps only products with no image, across pages, and hands back where it stopped', async () => {
    const pages: Record<string, unknown> = {
      start: { products: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [productNode(1, 0), productNode(2, 3), productNode(3, 0, { mediaCount: { count: 1 } })] } },
      c1: { products: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes: [productNode(4, 1), productNode(5, 0)] } },
      c2: { products: { pageInfo: { hasNextPage: false, endCursor: 'c3' }, nodes: [productNode(6, 0)] } },
    };
    const { client, calls } = shopify((_query, variables) => pages[(variables.after as string | null) ?? 'start']);

    const first = await scanProductsWithoutImages(client, { want: 3 });
    assert.deepEqual(first.products.map((p) => p.id), ['1', '3', '5']);
    // A video-only product has no image — and the video is reported, not hidden.
    assert.equal(first.products[1].otherMedia, 1);
    assert.equal(first.nextCursor, 'c2');
    assert.equal(first.scanned, 5);

    const rest = await scanProductsWithoutImages(client, { after: first.nextCursor, want: 3 });
    assert.deepEqual(rest.products.map((p) => p.id), ['6']);
    assert.equal(rest.nextCursor, null);
    // The image filter is Shopify's own media_type, the same definition the audit uses.
    assert.match(calls[0].query, /media\(first: 1, query: "media_type:IMAGE"\)/);
  });

  it('turns search words into a title-only prefix search that cannot reach other fields', () => {
    assert.equal(titleSearchQuery('  snow board '), 'title:snow* AND title:board*');
    assert.equal(titleSearchQuery('status:draft OR vendor:x'), 'title:status* AND title:draft* AND title:OR* AND title:vendor* AND title:x*');
    assert.equal(titleSearchQuery('"*()'), null);
    assert.equal(titleSearchQuery(undefined), null);
  });
});

describe('staging an image in Shopify’s storage', () => {
  const target = {
    url: 'https://shopify-staged-uploads.storage.googleapis.com/',
    resourceUrl: 'https://shopify-staged-uploads.storage.googleapis.com/tmp/1/products/abc/photo.png',
    parameters: [{ name: 'key', value: 'tmp/1/products/abc/photo.png' }, { name: 'policy', value: 'p' }, { name: 'x-goog-signature', value: 's' }],
  };

  it('asks for an IMAGE target, then posts every parameter before the file', async () => {
    const { client, calls } = shopify(() => ({ stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } }));
    let posted: FormData | null = null;
    let postedTo = '';
    const result = await stageImage(client, { bytes: png(10, 10), mimeType: 'image/png', filename: 'photo.png' }, async (url, init) => {
      postedTo = url;
      posted = init.body;
      return new Response(null, { status: 204 });
    });

    assert.equal(result.resourceUrl, target.resourceUrl);
    assert.deepEqual((calls[0].variables.input as Array<Record<string, unknown>>)[0], { resource: 'IMAGE', filename: 'photo.png', mimeType: 'image/png', httpMethod: 'POST', fileSize: String(png(10, 10).length) });
    assert.equal(postedTo, target.url);
    const names = [...(posted as unknown as FormData).keys()];
    assert.deepEqual(names, ['key', 'policy', 'x-goog-signature', 'file']);
    const file = (posted as unknown as FormData).get('file') as File;
    assert.equal(file.type, 'image/png');
    assert.equal(file.size, png(10, 10).length);
  });

  it('reports Shopify’s refusal and the storage’s refusal in their own words', async () => {
    const refused = shopify(() => ({ stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ['input', '0', 'mimeType'], message: 'photo.bmp: (image/bmp) is not a recognized format' }] } }));
    await assert.rejects(stageImage(refused.client, { bytes: png(1, 1), mimeType: 'image/png', filename: 'a.png' }), (error: unknown) =>
      error instanceof MediaUploadError && error.stage === 'stage' && /not a recognized format/.test(error.message));

    const ok = shopify(() => ({ stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } }));
    await assert.rejects(
      stageImage(ok.client, { bytes: png(1, 1), mimeType: 'image/png', filename: 'a.png' }, async () =>
        new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Invalid according to Policy</Message></Error>', { status: 403 })),
      (error: unknown) => error instanceof MediaUploadError && error.stage === 'upload' && /HTTP 403: Invalid according to Policy/.test(error.message),
    );
  });
});

describe('attaching the image to the product', () => {
  const resourceUrl = 'https://shopify-staged-uploads.storage.googleapis.com/tmp/1/a.png';

  it('finds the NEW media by comparing ids, and waits until Shopify says READY', async () => {
    let polls = 0;
    const { client, calls } = shopify((query) => {
      if (query.includes('ScoreloProductMediaIds')) return { product: { id: 'gid://shopify/Product/9', media: { nodes: [{ id: 'gid://shopify/Video/1' }] } } };
      if (query.includes('ScoreloAttachProductImage')) {
        return { productUpdate: { product: { id: 'gid://shopify/Product/9', media: { nodes: [{ id: 'gid://shopify/Video/1' }, { id: 'gid://shopify/MediaImage/55' }] } }, userErrors: [] } };
      }
      polls += 1;
      return polls < 3
        ? { node: { id: 'gid://shopify/MediaImage/55', status: 'PROCESSING', alt: 'Blue mug', image: null, mediaErrors: [] } }
        : { node: { id: 'gid://shopify/MediaImage/55', status: 'READY', alt: 'Blue mug', image: { url: 'https://cdn.shopify.com/s/files/1/blue-mug.png', width: 800, height: 800 }, mediaErrors: [] } };
    });

    const outcome = await attachImage(client, { productId: '9', resourceUrl, alt: 'Blue mug' }, { sleep: async () => {}, waitMs: 60_000 });
    assert.equal(outcome.mediaId, '55');
    assert.equal(outcome.status, 'READY');
    assert.equal(outcome.url, 'https://cdn.shopify.com/s/files/1/blue-mug.png');

    const attach = calls.find((call) => call.query.includes('ScoreloAttachProductImage'));
    assert.deepEqual(attach?.variables, {
      product: { id: 'gid://shopify/Product/9' },
      media: [{ originalSource: resourceUrl, mediaContentType: 'IMAGE', alt: 'Blue mug' }],
    });
  });

  it('reports Shopify’s userErrors as a failure — never as applied', async () => {
    const { client } = shopify((query) => query.includes('ScoreloProductMediaIds')
      ? { product: { id: 'gid://shopify/Product/9', media: { nodes: [] } } }
      : { productUpdate: { product: null, userErrors: [{ field: ['media'], message: 'Media processing limit reached' }] } });
    await assert.rejects(attachImage(client, { productId: '9', resourceUrl, alt: 'x' }), (error: unknown) =>
      error instanceof MediaUploadError && /Media processing limit reached/.test(error.message));
  });

  it('reports FAILED processing with Shopify’s reasons', async () => {
    const { client } = shopify((query) => {
      if (query.includes('ScoreloProductMediaIds')) return { product: { id: 'gid://shopify/Product/9', media: { nodes: [] } } };
      if (query.includes('ScoreloAttachProductImage')) return { productUpdate: { product: { id: 'gid://shopify/Product/9', media: { nodes: [{ id: 'gid://shopify/MediaImage/56' }] } }, userErrors: [] } };
      return { node: { id: 'gid://shopify/MediaImage/56', status: 'FAILED', alt: null, image: null, mediaErrors: [{ code: 'INVALID_IMAGE_FILE', details: null, message: 'Image could not be processed' }] } };
    });
    const outcome = await attachImage(client, { productId: '9', resourceUrl, alt: 'x' }, { sleep: async () => {} });
    assert.equal(outcome.status, 'FAILED');
    assert.deepEqual(outcome.errors, ['Image could not be processed']);
  });

  it('refuses a product this store does not have', async () => {
    const { client } = shopify(() => ({ product: null }));
    await assert.rejects(attachImage(client, { productId: '404', resourceUrl, alt: 'x' }), /no longer exists/);
  });

  it('returns PROCESSING honestly when Shopify has not finished within the wait', async () => {
    const { client } = shopify((query) => {
      if (query.includes('ScoreloProductMediaIds')) return { product: { id: 'gid://shopify/Product/9', media: { nodes: [] } } };
      if (query.includes('ScoreloAttachProductImage')) return { productUpdate: { product: { id: 'gid://shopify/Product/9', media: { nodes: [{ id: 'gid://shopify/MediaImage/57' }] } }, userErrors: [] } };
      return { node: { id: 'gid://shopify/MediaImage/57', status: 'PROCESSING', alt: null, image: null, mediaErrors: [] } };
    });
    const outcome = await attachImage(client, { productId: '9', resourceUrl, alt: 'x' }, { sleep: async () => {}, waitMs: 0 });
    assert.equal(outcome.status, 'PROCESSING');
    assert.equal(outcome.url, null);
  });
});

// ─── The AI drawing ──────────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const KEY = 'sk-test-not-a-real-key-123';

describe('the prompt', () => {
  it('is built from the product’s own words, leaving out what the product does not have', () => {
    const prompt = buildProductImagePrompt({
      title: 'Ceramic Pour-Over Coffee Dripper',
      description: 'Hand-glazed   stoneware\nin matte sage green.',
      productType: 'Coffee gear',
      vendor: 'Kiln & Co',
      tags: ['coffee', ' ', 'ceramic'],
      direction: 'on a light oak counter',
    });
    assert.match(prompt, /Product: Ceramic Pour-Over Coffee Dripper/);
    assert.match(prompt, /Description: Hand-glazed stoneware in matte sage green\./);
    assert.match(prompt, /Product type: Coffee gear/);
    assert.match(prompt, /Brand: Kiln & Co/);
    assert.match(prompt, /Tags: coffee, ceramic/);
    assert.match(prompt, /Merchant's direction for this photo: on a light oak counter/);

    const bare = buildProductImagePrompt({ title: 'Gift Card', description: '', productType: '', vendor: '', tags: [], direction: '' });
    assert.doesNotMatch(bare, /Description:|Product type:|Brand:|Tags:|direction/);
  });
});

describe('OpenAI image provider', () => {
  it('sends one JPEG request with the key only in the header, and decodes the image', async () => {
    const image = jpeg(1024, 1024);
    const calls = stubFetch(() => json({ data: [{ b64_json: image.toString('base64') }], output_format: 'jpeg' }));
    const result = await openAiImageProvider.draw('draw a mug', 'gpt-image-2.5-flare', KEY, 5_000);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.mimeType, 'image/jpeg');
    assert.deepEqual(result.ok && result.bytes, image);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'gpt-image-2.5-flare');
    assert.equal(body.output_format, 'jpeg');
    assert.equal(String(calls[0].init.body).includes(KEY), false);
  });

  it('classifies the refusals that mean "update the AI key", without echoing the key', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } }, 'key_rejected'],
      [429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 'quota'],
      [403, { error: { message: 'Your organization must be verified to use the model gpt-image-2.5-flare' } }, 'model_unavailable'],
      [404, { error: { message: 'The model does not exist', code: 'model_not_found' } }, 'model_unavailable'],
      [400, { error: { message: 'Your request was rejected by the safety system', code: 'moderation_blocked' } }, 'refused'],
      [429, { error: { message: 'Rate limit reached for images per minute', code: 'rate_limit_exceeded' } }, 'rate_limited'],
    ];
    for (const [status, body, code] of cases) {
      stubFetch(() => json(body, status));
      const result = await openAiImageProvider.draw('p', 'm', KEY, 5_000);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, code, `HTTP ${status} should be ${code}`);
      assert.equal(!result.ok && result.detail.includes(KEY), false, 'the key must never be in the detail');
    }
  });
});

describe('Gemini image provider', () => {
  it('asks for an image with the key in its header and reads the inline image', async () => {
    const image = png(1024, 1024);
    const calls = stubFetch(() => json({ candidates: [{ content: { parts: [{ text: 'Here it is' }, { inlineData: { mimeType: 'image/png', data: image.toString('base64') } }] } }] }));
    const result = await geminiImageProvider.draw('draw a mug', 'gemini-3.1-flash-image', KEY, 5_000);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.mimeType, 'image/png');
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-goog-api-key'], KEY);
    assert.equal(calls[0].url.includes(KEY), false);
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  });

  it('reads a free-tier key meeting a paid-only model as "update the key", not as "try later"', async () => {
    stubFetch(() => json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image' } }, 429));
    const quota = await geminiImageProvider.draw('p', 'gemini-3.1-flash-image', KEY, 5_000);
    assert.equal(!quota.ok && quota.code, 'quota');

    stubFetch(() => json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }, 429));
    const busy = await geminiImageProvider.draw('p', 'gemini-3.1-flash-image', KEY, 5_000);
    assert.equal(!busy.ok && busy.code, 'rate_limited');

    stubFetch(() => json({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }, 400));
    const bad = await geminiImageProvider.draw('p', 'm', KEY, 5_000);
    assert.equal(!bad.ok && bad.code, 'key_rejected');

    stubFetch(() => json({ error: { status: 'NOT_FOUND', message: 'models/x is not found for API version v1beta' } }, 404));
    const missing = await geminiImageProvider.draw('p', 'x', KEY, 5_000);
    assert.equal(!missing.ok && missing.code, 'model_unavailable');
  });

  it('names a refusal, and passes on what the model said when it answered without an image', async () => {
    stubFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    const blocked = await geminiImageProvider.draw('p', 'm', KEY, 5_000);
    assert.equal(!blocked.ok && blocked.code, 'refused');

    stubFetch(() => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I can only describe it.' }] } }] }));
    const words = await geminiImageProvider.draw('p', 'm', KEY, 5_000);
    assert.equal(!words.ok && words.code, 'failed');
    assert.match(!words.ok ? words.detail : '', /I can only describe it/);
  });
});

describe('image generation configuration', () => {
  const mutable = env as unknown as { aiImageProvider: string; aiImageModel?: string; openaiApiKey?: string; geminiApiKey?: string; aiRecommendationsEnabled: boolean; aiImageEnabled: boolean };
  const saved = { ...mutable };
  afterEach(() => Object.assign(mutable, saved));

  it('says plainly when no key is set, and draws nothing', async () => {
    Object.assign(mutable, { aiImageProvider: 'gemini', geminiApiKey: undefined, aiRecommendationsEnabled: true, aiImageEnabled: true });
    const calls = stubFetch(() => json({}));
    const status = imageGenerationStatus();
    assert.equal(status.configured, false);
    assert.match(status.reason ?? '', /AI_API_KEY/);
    const result = await generateProductImage({ title: 't', description: '', productType: '', vendor: '', tags: [], direction: '' });
    assert.equal(!result.ok && result.code, 'not_configured');
    assert.equal(calls.length, 0);
  });

  it('uses the provider’s default model unless AI_IMAGE_MODEL names one', () => {
    Object.assign(mutable, { aiImageProvider: 'openai', aiImageModel: undefined, openaiApiKey: KEY, aiRecommendationsEnabled: true, aiImageEnabled: true });
    assert.deepEqual(imageGenerationStatus(), { configured: true, provider: 'openai', model: 'gpt-image-2.5-flare', reason: null });
    Object.assign(mutable, { aiImageModel: 'gpt-image-1.5' });
    assert.equal(imageGenerationStatus().model, 'gpt-image-1.5');
  });

  it('honours the kill switches', () => {
    Object.assign(mutable, { aiImageProvider: 'openai', openaiApiKey: KEY, aiRecommendationsEnabled: true, aiImageEnabled: false });
    assert.equal(imageGenerationStatus().configured, false);
    Object.assign(mutable, { aiImageEnabled: true, aiRecommendationsEnabled: false });
    assert.equal(imageGenerationStatus().configured, false);
  });

  it('tells the merchant to update the AI key for exactly the failures a new key fixes', () => {
    for (const code of ['not_configured', 'key_rejected', 'quota', 'model_unavailable'] as const) {
      assert.match(aiImageFailureMessage(code, 'gemini', 'gemini-3.1-flash-image', 'detail'), /Update the AI key/, code);
    }
    for (const code of ['rate_limited', 'refused', 'timeout', 'failed'] as const) {
      assert.doesNotMatch(aiImageFailureMessage(code, 'openai', 'gpt-image-2.5-flare', 'detail'), /Update the AI key/, code);
    }
  });
});
