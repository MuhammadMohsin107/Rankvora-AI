import { z } from 'zod';

export const integrationProviderSchema = z.object({
  provider: z.string().trim().min(1).max(80),
});

export const updateIntegrationSchema = z.object({
  status: z.enum(['connected', 'needs_attention', 'not_connected']).optional(),
  accountDetail: z.string().trim().max(255).nullable().optional(),
  notice: z.string().trim().max(1000).nullable().optional(),
}).strict();

export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
