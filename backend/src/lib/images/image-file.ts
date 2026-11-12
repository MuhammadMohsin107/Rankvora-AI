/**
 * ─── What a product image file has to be ─────────────────────────────
 *
 * Shopify's own limits for a product image (shopify.dev, "Manage media for products and
 * collections": MediaImage — PNG, GIF, JPEG, WEBP, HEIC; max 20 MB; max 4472 x 4472 px, 20 MP;
 * aspect ratio 100:1 to 1:100). Checked HERE, on the bytes, before anything is sent to Shopify:
 * a file Shopify would refuse after the upload is a merchant waiting for a failure Rankvora AI could
 * have named straight away.
 *
 * HEIC is the one format Shopify takes that this does not. Most browsers cannot display it, so the
 * merchant could not preview what they are about to put on their storefront; they are asked to save
 * it as JPEG first instead.
 *
 * THE TYPE COMES FROM THE BYTES, never from the file name or the declared Content-Type alone. A
 * renamed file is caught here; a declared type that disagrees with the bytes is refused.
 */

export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ProductImageType = (typeof PRODUCT_IMAGE_TYPES)[number];

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4472;
export const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_ASPECT = 100;

const EXTENSION: Record<ProductImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function extensionFor(type: ProductImageType): string {
  return EXTENSION[type];
}

export interface ImageFacts {
  mimeType: ProductImageType;
  width: number;
  height: number;
  bytes: number;
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);

const ascii = (buffer: Buffer, offset: number, text: string) =>
  buffer.length >= offset + text.length && buffer.toString('latin1', offset, offset + text.length) === text;

/** Width and height of a JPEG, from its first start-of-frame marker. */
function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1];
    // Fill bytes: any number of 0xFF may pad before a marker.
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    // Markers with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** Width and height of a WebP, from whichever of its three bitstream headers it carries. */
function webpSize(buffer: Buffer): { width: number; height: number } | null {
  if (ascii(buffer, 12, 'VP8 ') && buffer.length >= 30) {
    // Lossy: a 3-byte frame tag, the start code 9D 01 2A, then 14-bit width and height.
    if (!startsWith(buffer, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (ascii(buffer, 12, 'VP8L') && buffer.length >= 25) {
    // Lossless: signature 0x2F, then width-1 and height-1 packed into 14 bits each.
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (ascii(buffer, 12, 'VP8X') && buffer.length >= 30) {
    // Extended: 24-bit canvas width-1 and height-1.
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * The image's real type and size, read from its bytes. Null when the bytes are not one of the four
 * accepted formats or their header cannot be read.
 */
export function sniffImage(buffer: Buffer): { mimeType: ProductImageType; width: number; height: number } | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(buffer);
    return size ? { mimeType: 'image/jpeg', ...size } : null;
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && ascii(buffer, 12, 'IHDR') && buffer.length >= 24) {
    return { mimeType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ((ascii(buffer, 0, 'GIF87a') || ascii(buffer, 0, 'GIF89a')) && buffer.length >= 10) {
    return { mimeType: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ascii(buffer, 0, 'RIFF') && ascii(buffer, 8, 'WEBP')) {
    const size = webpSize(buffer);
    return size ? { mimeType: 'image/webp', ...size } : null;
  }
  return null;
}

export type ImageCheck =
  | { ok: true; facts: ImageFacts }
  | { ok: false; code: 'IMAGE_EMPTY' | 'IMAGE_TOO_LARGE' | 'IMAGE_TYPE_UNSUPPORTED' | 'IMAGE_TYPE_MISMATCH' | 'IMAGE_DIMENSIONS'; message: string };

/**
 * Whether these bytes may become a product image, judged by Shopify's own limits.
 *
 * @param declared The Content-Type the caller sent, when there was one. It must agree with the
 *   bytes: a PNG labelled image/jpeg would be stored under the wrong type.
 */
export function checkProductImage(buffer: Buffer, declared?: string): ImageCheck {
  if (buffer.length === 0) return { ok: false, code: 'IMAGE_EMPTY', message: 'The file is empty.' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'Shopify accepts product images up to 20 MB. Choose a smaller file.' };
  }

  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    return {
      ok: false,
      code: 'IMAGE_TYPE_UNSUPPORTED',
      message: 'This file is not a JPEG, PNG, WebP or GIF image. (HEIC photos need saving as JPEG first.)',
    };
  }
  const normalizedDeclared = declared?.split(';')[0].trim().toLowerCase();
  if (normalizedDeclared && normalizedDeclared !== sniffed.mimeType) {
    return {
      ok: false,
      code: 'IMAGE_TYPE_MISMATCH',
      message: `The file says it is ${normalizedDeclared}, but its contents are ${sniffed.mimeType}. Save it again in one format and retry.`,
    };
  }

  const { width, height } = sniffed;
  if (width < 1 || height < 1) {
    return { ok: false, code: 'IMAGE_DIMENSIONS', message: 'The image has no readable width or height.' };
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    return {
      ok: false,
      code: 'IMAGE_DIMENSIONS',
      message: `The image is ${width} x ${height} px. Shopify accepts up to ${MAX_IMAGE_SIDE} x ${MAX_IMAGE_SIDE} px (20 megapixels).`,
    };
  }
  if (width / height > MAX_ASPECT || height / width > MAX_ASPECT) {
    return { ok: false, code: 'IMAGE_DIMENSIONS', message: `The image is ${width} x ${height} px; Shopify needs an aspect ratio between 100:1 and 1:100.` };
  }

  return { ok: true, facts: { mimeType: sniffed.mimeType, width, height, bytes: buffer.length } };
}

/**
 * A file name Shopify will store, built from the merchant's own name for the file where there is
 * one. Only letters, digits, dots, dashes and underscores survive; the extension always matches the
 * bytes, whatever the original name said.
 */
export function safeImageFilename(requested: string | undefined, type: ProductImageType, fallbackStem: string): string {
  const stemOf = (value: string) =>
    value
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80);
  const stem = (requested ? stemOf(requested) : '') || stemOf(fallbackStem) || 'product-image';
  return `${stem}.${extensionFor(type)}`;
}
