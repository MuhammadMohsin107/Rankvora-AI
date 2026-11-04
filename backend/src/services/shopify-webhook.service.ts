import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrations, shopifyConnections } from '../db/schema.js';
import { NOTIFICATION_LINKS, createNotification } from './notification.service.js';
import { env } from '../config/env.js';

/**
 * ─── Which webhooks reach this file, and how they are subscribed ─────
 *
 * Every subscription is declared in shopify.app.toml and delivered to /api/shopify/webhooks/*:
 *
 *   app/uninstalled     the merchant removed the app            → handleAppUninstalled
 *   app/scopes_update   the granted access scopes changed        → handleAppScopesUpdate
 *   customers/data_request, customers/redact, shop/redact       → the three mandatory privacy handlers
 *
 * Nothing registers a subscription at runtime. The app used to create an app/uninstalled subscription
 * through the Admin API at install; with the toml declaring the same topic that would deliver every
 * uninstall twice, and a subscription made in code cannot be seen or changed from the app's config.
 */

/** Shopify webhook HMAC: base64 HMAC-SHA256 of the raw request body, using the app secret. */
export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader || !env.shopifyApiSecret) return false;
  const digest = createHmac('sha256', env.shopifyApiSecret).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmacHeader, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleAppUninstalled(shopDomain: string) {
  const [connection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shopDomain)).limit(1);
  if (!connection) return;

  await db
    .update(shopifyConnections)
    .set({ uninstalledAt: new Date(), lastWebhookAt: new Date() })
    .where(eq(shopifyConnections.id, connection.id));

  // The merchant did this in Shopify's admin, not in Rankvora AI, so nothing on screen would ever
  // tell them their audits have stopped. This is exactly the event the bell exists for.
  await createNotification({
    storeId: connection.storeId,
    type: 'integration_alert',
    title: 'Shopify app uninstalled',
    message: `Rankvora AI was uninstalled from ${shopDomain}. Audits and fixes are paused until you reconnect the store.`,
    tone: 'critical',
    // Reconnecting is the only thing that answers this, and Integrations is where it happens.
    link: NOTIFICATION_LINKS.integrations,
  });

  // Scoped to the shopify row. Without the provider predicate this marked EVERY integration on
  // the store disconnected, so uninstalling the Shopify app also reported Search Console,
  // Analytics and PageSpeed as disconnected when nothing had changed about them.
  await db
    .update(integrations)
    .set({ status: 'not_connected', notice: 'App was uninstalled from Shopify admin.' })
    .where(and(eq(integrations.storeId, connection.storeId), eq(integrations.provider, 'shopify')));

  console.log(`[scorelo-api] shopify: webhook app/uninstalled processed for ${shopDomain}`);
}

/**
 * The merchant approved a change to the access scopes (or Shopify applied one from a new app version).
 * `current` is the complete list now granted. Recording it keeps `shopify_connections.scope` — which
 * fixability.service.ts compares against before it offers an Apply — equal to what the shop actually
 * granted, instead of what it granted at install.
 *
 * A payload without a usable `current` is ignored rather than guessed at: the stored scopes stay what
 * they were, which is the safe direction to be wrong (Apply is refused, never wrongly offered).
 */
export async function handleAppScopesUpdate(shopDomain: string, payload: unknown) {
  const current = (payload as { current?: unknown } | null)?.current;
  if (!Array.isArray(current) || !current.every((scope) => typeof scope === 'string')) return;

  await db
    .update(shopifyConnections)
    .set({ scope: current.join(','), lastWebhookAt: new Date() })
    .where(eq(shopifyConnections.shopDomain, shopDomain));
  console.log(`[scorelo-api] shopify: webhook app/scopes_update processed for ${shopDomain}`);
}

/** GDPR mandatory webhook — Rankvora AI stores no customer PII beyond what audits reference, so
 * this is an acknowledgement + audit-trail stamp, not a data export. */
export async function handleCustomersDataRequest(shopDomain: string) {
  await stampWebhook(shopDomain);
}

/** GDPR mandatory webhook — no customer PII is retained, so there is nothing to redact per customer. */
export async function handleCustomersRedact(shopDomain: string) {
  await stampWebhook(shopDomain);
}

/**
 * GDPR mandatory webhook, fires ~48h after uninstall. Hard-deletes the shop's OAuth connection,
 * which is where the access token lives — after this Rankvora AI holds no credential for the shop.
 *
 * Audits, findings and reports are deliberately NOT deleted: they hang off `stores`, not off this
 * row, and they are the merchant's own analysis history rather than Shopify customer data. Wiping
 * them is a data-retention decision, not a side effect of a redact webhook.
 */
export async function handleShopRedact(shopDomain: string) {
  const [connection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shopDomain)).limit(1);
  if (!connection) return;
  await db.delete(shopifyConnections).where(eq(shopifyConnections.id, connection.id));
  console.log(`[scorelo-api] shopify: webhook shop/redact processed for ${shopDomain}`);
}

async function stampWebhook(shopDomain: string) {
  const [connection] = await db.select().from(shopifyConnections).where(eq(shopifyConnections.shopDomain, shopDomain)).limit(1);
  if (!connection) return;
  await db.update(shopifyConnections).set({ lastWebhookAt: new Date() }).where(eq(shopifyConnections.id, connection.id));
}
