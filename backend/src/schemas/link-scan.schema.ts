import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

export const linkScanIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export const linkScanUrlParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  urlId: z.coerce.number().int().positive(),
}).strict();

/**
 * Which addresses of a scan to list. `view` is what the merchant is looking for:
 *   broken      dead ends                              redirect    links that work but go through a redirect
 *   unverified  could not be tested (blocked, timed out, not requested)
 *   ok          links that work                        all         every address that has been answered
 * `scope` is where the link points: the store itself, other websites, or both.
 */
export const linkScanLinksQuerySchema = z.object({
  view: z.enum(['broken', 'redirect', 'unverified', 'ok', 'all']).default('broken'),
  scope: z.enum(['all', 'internal', 'external']).default('all'),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  ...storeIdQueryShape,
}).strict();

export type LinkScanLinksQuery = z.infer<typeof linkScanLinksQuerySchema>;
