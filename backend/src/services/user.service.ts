import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { updateReturning } from '../db/returning.js';
import { users } from '../db/schema.js';
import { ApiError } from '../middleware/error.js';
import { toPublicUser } from '../lib/publicUser.js';
import type { UpdateUserInput } from '../schemas/user.schema.js';

export async function getUserById(id: number) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  return toPublicUser(user);
}

export async function updateUserById(id: number, input: UpdateUserInput) {
  // `users.email` is UNIQUE, so writing an address another account already holds is refused by the
  // database — which the error handler can only render as a 500 "Internal server error". That is
  // the wrong answer for an ordinary, correctable mistake made in Settings → Profile, so the
  // collision is detected here and refused with a 409 the UI can explain.
  //
  // Compared ignoring case: an inbox does not care. SQLite's unique index is case-sensitive (MySQL's
  // was not), so without lower() "Ada@x.com" would slip past "ada@x.com".
  //
  // Two concurrent updates could still both pass this check and let the unique index decide;
  // that race ends in the same 500 as before, but it is no longer the everyday path.
  if (input.email !== undefined) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${input.email})`)
      .limit(1);
    if (existing && existing.id !== id) {
      throw new ApiError(409, 'That email address is already in use.', 'EMAIL_IN_USE');
    }
  }

  const [user] = await updateReturning(users, input, eq(users.id, id));
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');
  return toPublicUser(user);
}
