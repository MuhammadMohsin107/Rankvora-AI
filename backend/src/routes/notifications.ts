import { Router } from 'express';
import { clearRead, dismissNotification, getNotifications, markAllNotificationsAsRead, markNotificationAsRead } from '../controllers/notification.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate } from '../middleware/authenticate.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { notificationIdSchema, notificationListQuerySchema } from '../schemas/notification.schema.js';
import { storeIdQuerySchema } from '../schemas/common.schema.js';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.get('/', validateRequest({ query: notificationListQuerySchema }), asyncHandler(getNotifications));
notificationsRouter.patch('/read-all', validateRequest({ query: storeIdQuerySchema }), asyncHandler(markAllNotificationsAsRead));
notificationsRouter.patch('/:id/read', validateRequest({ params: notificationIdSchema, query: storeIdQuerySchema }), asyncHandler(markNotificationAsRead));
// '/read' is declared BEFORE '/:id' — Express matches in order, so the other way round this path
// hits the id route and notificationIdSchema rejects "read" as a 400 before the handler runs.
notificationsRouter.delete('/read', validateRequest({ query: storeIdQuerySchema }), asyncHandler(clearRead));
notificationsRouter.delete('/:id', validateRequest({ params: notificationIdSchema, query: storeIdQuerySchema }), asyncHandler(dismissNotification));
