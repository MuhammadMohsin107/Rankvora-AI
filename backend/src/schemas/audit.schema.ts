import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const auditListQuerySchema = z.object({ ...pagination, ...storeIdQueryShape }).strict();
export const latestAuditQuerySchema = z.object({
  pillar: z.enum(['seo', 'content', 'speed', 'cro', 'ai-discovery']).optional(),
  ...storeIdQueryShape,
}).strict();
export const auditIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export const subPillarParamSchema = z.object({
  pillar: z.enum(['seo', 'content', 'speed', 'cro', 'ai-discovery']),
  subPillar: z.string().trim().min(1).max(120),
}).strict();

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type LatestAuditQuery = z.infer<typeof latestAuditQuerySchema>;
export type SubPillarParam = z.infer<typeof subPillarParamSchema>;
