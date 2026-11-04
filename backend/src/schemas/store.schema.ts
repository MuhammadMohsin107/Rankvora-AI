import { z } from 'zod';

export const updateStoreSchema = z.object({
  workspaceName: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  url: z.string().trim().url().max(2048).optional(),
  platform: z.string().trim().min(1).max(80).optional(),
  industry: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  currency: z.string().trim().min(1).max(80).optional(),
  autoAnalysis: z.boolean().optional(),
  analysisFrequency: z.enum(['Daily', 'Weekly', 'Fortnightly', 'Monthly']).optional(),
  crawlScope: z.enum(['Entire store', 'Products & collections only', 'Key templates only']).optional(),
  pageLimit: z.number().int().min(1).max(100000).optional(),
  includeBlog: z.boolean().optional(),
  includeCollections: z.boolean().optional(),
  respectRobots: z.boolean().optional(),
}).strict();

export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
