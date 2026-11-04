import { z } from 'zod';

export const jobIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export type JobIdParam = z.infer<typeof jobIdParamSchema>;
