import { Request, Response, NextFunction } from "express";
import { notificationService } from "../services/notifications/notificationService.js";

/** GET /api/v1/notifications (Protected: paginated list + unread count) */
export async function listNotifications(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { limit, before } = req.query;
    const result = await notificationService.listForUser(req.user.id, {
      limit: limit ? parseInt(limit as string, 10) : undefined,
      before: typeof before === "string" ? before : undefined,
    });

    res.json({
      success: true,
      data: result.notifications,
      unreadCount: result.unreadCount,
      pagination: { nextCursor: result.nextCursor },
    });
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/notifications/:id/read (Protected: mark one notification read) */
export async function markNotificationRead(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const found = await notificationService.markRead(req.user.id, req.params.id as string);
    if (!found) {
      res.status(404).json({ success: false, message: "Notification not found" });
      return;
    }

    res.json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    next(error);
  }
}

/** POST /api/v1/notifications/read-all (Protected: mark every notification read) */
export async function markAllNotificationsRead(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const count = await notificationService.markAllRead(req.user.id);
    res.json({ success: true, message: `Marked ${count} notification(s) as read`, count });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/v1/notifications (Protected: clear every notification) */
export async function clearAllNotifications(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const count = await notificationService.clearAll(req.user.id);
    res.json({ success: true, message: `Cleared ${count} notification(s)`, count });
  } catch (error) {
    next(error);
  }
}
