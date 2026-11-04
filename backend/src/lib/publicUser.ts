import type { users } from '../db/schema.js';

type UserRow = typeof users.$inferSelect;

/**
 * The user as an API response carries it.
 *
 * The users table holds no credential — no password, no second factor, no token — because Shopify,
 * not this app, proves who is calling, so there is nothing to strip. Every user going to a browser
 * still passes through here, so that if a column that must not be sent is ever added, this is the one
 * place to remove it from (and shopify-embedded.test.ts fails if a field that looks like a credential
 * appears).
 */
export function toPublicUser(user: UserRow): UserRow {
  return user;
}
