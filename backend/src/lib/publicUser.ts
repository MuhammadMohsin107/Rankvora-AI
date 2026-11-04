import type { users } from '../db/schema.js';

type UserRow = typeof users.$inferSelect;

/** Strips auth secrets before a user row ever reaches an API response. */
export function toPublicUser(user: UserRow) {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}
