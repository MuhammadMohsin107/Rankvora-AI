import { z } from 'zod';

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
}).strict();

/**
 * Logout body.
 *
 * `refreshToken` is OPTIONAL and is used for exactly one thing: identifying WHICH session is
 * ending. An access token carries no session identifier, so without this the server cannot tell
 * one device from another and falls back to revoking every session — never to revoking none.
 *
 * This is the same credential the client already posts to /auth/refresh, over the same origin and
 * the same TLS, so no new exposure is introduced. It is hashed for a lookup and never stored,
 * logged or echoed.
 */
export const logoutSchema = z.object({
  refreshToken: z.string().min(1).max(4096).optional(),
}).strict();

export type RefreshInput = z.infer<typeof refreshSchema>;
