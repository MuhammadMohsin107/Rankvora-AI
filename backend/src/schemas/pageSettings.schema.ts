
import { z } from 'zod';

export const pageSettingsSlugSchema = z.object({
  slug: z.string().trim().min(1).max(200),
});

/**
 * The two-segment form, `/:pillar/:subPillar`.
 *
 * Both segments are bounded and restricted to the slug alphabet the routes actually use. The
 * joined value becomes a database key, so this is the boundary where a path segment stops being
 * arbitrary request input.
 */
export const pageSettingsPathSchema = z.object({
  pillar: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i),
  subPillar: z.string().trim().min(1).max(134).regex(/^[a-z0-9-]+$/i),
});

export const upsertPageSettingsSchema = z.object({
  values: z.record(z.string(), z.any()).default({}),
}).strict();

export type UpsertPageSettingsInput = z.infer<typeof upsertPageSettingsSchema>;
