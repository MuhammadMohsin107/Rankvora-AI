import { z } from 'zod';
import {
  AUTO_FORMATS,
  MAX_CHARACTER_LIMIT,
  MAX_TEMPLATE_LENGTH,
  MIN_CHARACTER_LIMIT,
} from '../lib/alt-text/template.js';

/**
 * Shape validation only — the request must be a well-formed configuration document before the
 * service looks at it. The MEANING of a template (unknown placeholders, malformed braces, a
 * placeholder belonging to another content type) is judged in lib/alt-text/template.ts, so the
 * rules validation applies at the edge and the rules a save applies are provably the same ones.
 */

const typeConfigSchema = z.object({
  template: z.string().max(MAX_TEMPLATE_LENGTH),
  characterLimit: z.number().int().min(MIN_CHARACTER_LIMIT).max(MAX_CHARACTER_LIMIT),
  autoFormat: z.enum(AUTO_FORMATS),
  skipExisting: z.boolean(),
  removeDuplicateWords: z.boolean(),
  autoGenerate: z.boolean(),
}).strict();

export const altTextConfigSchema = z.object({
  config: z.object({
    products: typeConfigSchema,
    articles: typeConfigSchema,
  }).strict(),
}).strict();

export type AltTextConfigInput = z.infer<typeof altTextConfigSchema>;
