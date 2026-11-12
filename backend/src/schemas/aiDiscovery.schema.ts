import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

/**
 * Request shapes for the AI Discovery settings API.
 *
 * The IndexNow key is validated here AND again in the service. That is not redundancy for its own
 * sake: the key becomes a URL path, and the service is also called from places that do not go
 * through this router. A value that could reach a request builder is checked wherever it enters.
 */

/** Hexadecimal, 8–128 characters, per the IndexNow specification. */
export const setIndexNowKeySchema = z
  .object({
    /** Omitted asks Rankvora AI to generate one. Supplied uses the merchant's existing key. */
    key: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{8,128}$/i, 'An IndexNow key must be 8–128 hexadecimal characters (0-9, a-f).')
      .optional(),
  })
  .strict();

export const addPromptQuerySchema = z
  .object({
    /** The merchant's own question. Never generated — see services/ai-discovery.service.ts. */
    query: z.string().trim().min(3, 'Enter the question you want checked.').max(500),
    /**
     * What counts as a mention. Optional: defaults to the store's name, because that is the only
     * value Rankvora AI actually knows. It is editable because a merchant may trade under a different
     * name, and matching the wrong string would under-report every run while looking healthy.
     */
    brandTerm: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export const updatePromptQuerySchema = z
  .object({ active: z.boolean() })
  .strict();

export const promptQueryParamsSchema = z
  .object({ id: z.coerce.number().int().positive() })
  .strict();

/**
 * A live fetch-as-bot request.
 *
 * `path` is a PATH, not a URL. The controller resolves it against the store's own origin, so the
 * shape here refuses anything that could carry a host: a value starting `//` or with a scheme would
 * otherwise resolve to a third-party server and turn this endpoint into an open request proxy.
 */
export const botTestSchema = z
  .object({
    /** Must be one of the canonical crawler names in audit-engine/storefront/ai-crawlers.ts. */
    bot: z.string().trim().min(1, 'Choose which crawler to test as.').max(64),
    path: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => value === '' || value.startsWith('/'), 'Enter a path beginning with “/”.')
      .refine((value) => !value.startsWith('//'), 'Enter a path on your own store, not another host.')
      .optional(),
  })
  .strict();

/** Days windows are clamped in the services too; this keeps a nonsense value from reaching them. */
export const daysQuerySchema = z
  .object({ ...storeIdQueryShape, days: z.coerce.number().int().min(1).max(365).optional() })
  .strict();

/** Each inspection spends the merchant's own Search Console quota — see url-inspection.service.ts. */
export const indexCoverageQuerySchema = z
  .object({ ...storeIdQueryShape, sample: z.coerce.number().int().min(1).max(25).optional() })
  .strict();

