import { z } from 'zod';
import { storeIdQueryShape } from './common.schema.js';

export const notificationIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * The list was unbounded: every header mount and every visit to /notifications selected every
 * notification the store had ever received. A bell shows the recent ones, so it asks for the
 * recent ones — and the unread COUNT is computed separately, server-side, so truncating the list
 * can never make the badge lie.
 *
 * The ceiling is what "Show older" on /notifications can reach. Notifications are written a few at
 * a time per audit or connection event, so 200 is months of history for a weekly store.
 */
export const NOTIFICATION_LIST_MAX = 200;

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_LIST_MAX).default(30),
  ...storeIdQueryShape,
}).strict();

