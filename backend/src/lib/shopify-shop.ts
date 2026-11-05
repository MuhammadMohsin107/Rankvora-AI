/**
 * ─── A store address, as a merchant types it ─────────────────────────
 *
 * Shopify identifies a store by its handle — the `my-store` in `my-store.myshopify.com`. People type it
 * in many shapes, and this reads all of them down to the handle, or to null when the text is not a
 * Shopify store address at all:
 *
 *     my-store                                   my-store.myshopify.com
 *     https://my-store.myshopify.com/admin       admin.shopify.com/store/my-store/apps
 *
 * Nothing else gets through. The handle is the only part of the input that is ever used (it is rebuilt
 * into a Shopify address on the server), so a hostname that merely CONTAINS `.myshopify.com`
 * (`my-store.myshopify.com.example.com`, `example.com/my-store.myshopify.com`) is refused rather than
 * trimmed into something that looks right. A store's own domain (`www.brand.com`) is refused too: it
 * does not name the store, and only the `.myshopify.com` address does.
 */

/** Letters, digits and hyphens, starting with a letter or digit — the shape of every store handle. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const SHOPIFY_ADMIN_HOST = 'admin.shopify.com';
const MYSHOPIFY_SUFFIX = '.myshopify.com';

export function parseShopHandle(input: string): string | null {
  const typed = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (typed === '' || typed.length > 300) return null;

  const [host = '', ...path] = typed.split(/[/?#]/);

  // admin.shopify.com/store/<handle>[/...] — the address the admin itself shows in the browser.
  if (host === SHOPIFY_ADMIN_HOST) {
    return path[0] === 'store' && HANDLE.test(path[1] ?? '') ? path[1]! : null;
  }

  const handle = host.endsWith(MYSHOPIFY_SUFFIX) ? host.slice(0, -MYSHOPIFY_SUFFIX.length) : host;
  return HANDLE.test(handle) ? handle : null;
}

/** The `<handle>.myshopify.com` domain Rankvora AI stores a shop under. */
export function shopDomainOf(handle: string): string {
  return `${handle}${MYSHOPIFY_SUFFIX}`;
}
