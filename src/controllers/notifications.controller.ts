import { Request, Response } from 'express';
import { InAppNotificationService } from '../services/inAppNotification.service';
import { ResponseUtil } from '../utils/response.utils';
import { asyncHandler } from '../utils/asyncHandler.utils';

/**
 * Notifications Controller - Handles in-app notification CRUD operations
 */
export const NotificationsController = {
  /**
   * GET /api/v1/notifications
   * Paginated list of notifications for the authenticated user (unread first).
   */
  getNotifications: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) return ResponseUtil.error(res, 'Unauthorized', 401);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const result = await InAppNotificationService.list(userId, page, limit);

    ResponseUtil.success(
      res,
      result,
      'Notifications retrieved',
      200,
      {
        page: result.page,
        limit,
        total: result.total,
        totalPages: result.totalPages,
        hasNext: result.page < result.totalPages,
        hasPrev: result.page > 1,
      },
    );
  }),

  /**
   * GET /api/v1/notifications/unread-count
   * Lightweight unread count for badge display.
   */
  getUnreadCount: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) return ResponseUtil.error(res, 'Unauthorized', 401);

    const count = await InAppNotificationService.unreadCount(userId);
    ResponseUtil.success(res, { unreadCount: count }, 'Unread count retrieved');
  }),

  /**
   * PUT /api/v1/notifications/:id/read
   * Mark a single notification as read.
   */
  markAsRead: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    const { id } = req.params as Record<string, string>;
    if (!userId) return ResponseUtil.error(res, 'Unauthorized', 401);

    const updated = await InAppNotificationService.markRead(id, userId);
    if (!updated) return ResponseUtil.error(res, 'Notification not found', 404);

    ResponseUtil.success(res, null, 'Notification marked as read');
  }),

  /**
   * PUT /api/v1/notifications/read-all
   * Mark all notifications as read for the authenticated user.
   */
  markAllAsRead: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    if (!userId) return ResponseUtil.error(res, 'Unauthorized', 401);

    const count = await InAppNotificationService.markAllRead(userId);
    ResponseUtil.success(
      res,
      { markedRead: count },
      `${count} notification${count !== 1 ? 's' : ''} marked as read`,
    );
  }),

  /**
   * DELETE /api/v1/notifications/:id
   * Dismiss (soft-delete) a notification.
   */
  deleteNotification: asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?.id;
    const { id } = req.params as Record<string, string>;
    if (!userId) return ResponseUtil.error(res, 'Unauthorized', 401);

    const dismissed = await InAppNotificationService.dismiss(id, userId);
    if (!dismissed) return ResponseUtil.error(res, 'Notification not found', 404);

    ResponseUtil.success(res, null, 'Notification dismissed');
  }),

  /**
   * POST /api/v1/notifications/push/send-rich
   * Send rich mobile push notification with deep link and actions
   */
  sendRichNotification: asyncHandler(async (req: Request, res: Response) => {
    const { PushNotificationService } = await import('../services/push-notification.service');
    const { userId, title, body, imageUrl, deepLink, actions, data, priority, sound, badge } = req.body;
    const targetUserId = userId || (req as any).user?.id;

    if (!targetUserId) {
      return ResponseUtil.error(res, 'Target userId is required', 400);
    }
    if (!title || !body) {
      return ResponseUtil.error(res, 'Title and body are required', 400);
    }

    const result = await PushNotificationService.sendToUser(targetUserId, {
      title,
      body,
      imageUrl,
      deepLink,
      actions,
      data,
      priority,
      sound,
      badge,
    });

    ResponseUtil.success(res, result, 'Rich push notification processed', result.success ? 200 : 207);
  }),

  /**
   * POST /api/v1/notifications/push/send-segment
   * Send targeted push notifications to user segments (role, tier, activity)
   */
  sendToSegment: asyncHandler(async (req: Request, res: Response) => {
    const { PushNotificationService } = await import('../services/push-notification.service');
    const { segment, title, body, imageUrl, deepLink, actions, data } = req.body;

    if (!segment || typeof segment !== 'object') {
      return ResponseUtil.error(res, 'Segment criteria object is required', 400);
    }
    if (!title || !body) {
      return ResponseUtil.error(res, 'Title and body are required', 400);
    }

    const result = await PushNotificationService.sendToSegment(segment, {
      title,
      body,
      imageUrl,
      deepLink,
      actions,
      data,
    });

    ResponseUtil.success(res, result, 'Segment push notifications processed');
  }),

  /**
   * GET /api/v1/notifications/push/analytics
   * Get push notification delivery metrics and analytics
   */
  getPushAnalytics: asyncHandler(async (req: Request, res: Response) => {
    const { PushNotificationService } = await import('../services/push-notification.service');
    const { startDate, endDate, segment } = req.query;

    const analytics = PushNotificationService.getAnalytics({
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      segment: segment as string | undefined,
    });

    ResponseUtil.success(res, analytics, 'Push notification delivery analytics retrieved');
  }),

  /**
   * POST /api/v1/notifications/push/track-open
   * Track when a push notification is opened/clicked by the user
   */
  trackNotificationOpened: asyncHandler(async (req: Request, res: Response) => {
    const { PushNotificationService } = await import('../services/push-notification.service');
    const userId = (req as any).user?.id;
    const { notificationId } = req.body;

    if (!notificationId) {
      return ResponseUtil.error(res, 'Notification ID is required', 400);
    }

    PushNotificationService.recordNotificationOpened(notificationId, userId || 'anonymous');
    ResponseUtil.success(res, { tracked: true }, 'Notification open tracked');
  }),
};

export default NotificationsController;
