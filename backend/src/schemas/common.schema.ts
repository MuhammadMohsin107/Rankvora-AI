import { z } from 'zod';

/** Merge into any `.strict()` query schema to accept an optional active-store selector. */
export const storeIdQueryShape = {
  storeId: z.coerce.number().int().positive().optional(),
};

/** For routes with no other query params, beyond the optional active-store selector. */
export const storeIdQuerySchema = z.object(storeIdQueryShape).strict();
