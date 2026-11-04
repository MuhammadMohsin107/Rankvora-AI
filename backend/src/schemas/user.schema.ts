import { z } from 'zod';

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(254).optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  notifyAnalysisComplete: z.boolean().optional(),
  notifyCriticalIssues: z.boolean().optional(),
  notifyScoreChanges: z.boolean().optional(),
  notifyWeeklySummary: z.boolean().optional(),
  notifyIntegrationAlerts: z.boolean().optional(),
  notifyProductUpdates: z.boolean().optional(),
  density: z.enum(['Comfortable', 'Compact']).optional(),
  reduceMotion: z.boolean().optional(),
}).strict();

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
