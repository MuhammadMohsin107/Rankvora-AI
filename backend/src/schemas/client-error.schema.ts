import { z } from 'zod';

/**
 * A crash report from the browser (frontend ErrorBoundary). Every field is capped: this is text a
 * browser chose to send, and it is going into a log file.
 *
 * `path` is the page's pathname only. The frontend never sends the query string or the hash —
 * a Shopify sign-in carries its grant in the hash.
 */
export const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(4000).optional(),
  path: z.string().startsWith('/').max(300),
}).strict();

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;
