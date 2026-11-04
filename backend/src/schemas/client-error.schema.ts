import { z } from 'zod';

/**
 * A crash report from the browser (frontend ErrorBoundary). Every field is capped: this is text a
 * browser chose to send, and it is going into a log file.
 *
 * `path` is the page's pathname only. The frontend never sends the query string or the hash —
 * Shopify puts the shop, host and an ID token in the query when it opens the app.
 */
export const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(4000).optional(),
  path: z.string().startsWith('/').max(300),
}).strict();

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;
