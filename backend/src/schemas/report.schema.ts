import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

export const reportTrendQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(12),
  ...storeIdQueryShape,
}).strict();

export type ReportTrendQuery = z.infer<typeof reportTrendQuerySchema>;

/**
 * `auditId` selects one historical report to export. It is a filter, not an authorisation:
 * the service resolves it inside the caller's own store, so an id belonging to another
 * merchant simply does not match and returns 404.
 */
export const reportExportQuerySchema = z.object({
  auditId: z.coerce.number().int().positive().optional(),
  ...storeIdQueryShape,
}).strict();

export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;
