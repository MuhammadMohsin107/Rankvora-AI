import type { Request, Response } from 'express';
import {
  clearReadNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/notification.service.js';
import { optionalStoreId, requireUserId } from '../lib/requestContext.js';

export async function getNotifications(req: Request, res: Response) {
  res.json({ data: await listNotifications(requireUserId(req), req.query as never, optionalStoreId(req)) });
}

export async function markNotificationAsRead(req: Request, res: Response) {
  res.json({ data: await markNotificationRead(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function markAllNotificationsAsRead(req: Request, res: Response) {
  res.json({ data: await markAllNotificationsRead(requireUserId(req), optionalStoreId(req)) });
}

export async function dismissNotification(req: Request, res: Response) {
  res.json({ data: await deleteNotification(requireUserId(req), Number(req.params.id), optionalStoreId(req)) });
}

export async function clearRead(req: Request, res: Response) {
  res.json({ data: await clearReadNotifications(requireUserId(req), optionalStoreId(req)) });
}
