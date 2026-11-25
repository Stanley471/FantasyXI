import { prisma } from "../../config/db.js";

/**
 * Notification center (issue #500): creates, lists, and marks read the
 * per-user notifications shown in the navigation drawer (league invites,
 * gameweek finalizations, payment confirmations, ...).
 */

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

export class NotificationService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma
  ) {}

  public async create(input: CreateNotificationInput) {
    return this.db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
      },
    });
  }

  /** Newest-first page of a user's notifications, plus their unread count. */
  public async listForUser(
    userId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<{ notifications: unknown[]; unreadCount: number; nextCursor: string | null }> {
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));

    const [notifications, unreadCount] = await Promise.all([
      this.db.notification.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        ...(options.before ? { cursor: { id: options.before }, skip: 1 } : {}),
      }),
      this.db.notification.count({ where: { userId, isRead: false } }),
    ]);

    return {
      notifications,
      unreadCount,
      nextCursor: notifications.length === limit ? notifications[notifications.length - 1].id : null,
    };
  }

  /** Marks a single notification read; a no-op if it isn't the caller's. */
  public async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await this.db.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
    return result.count > 0;
  }

  public async markAllRead(userId: string): Promise<number> {
    const result = await this.db.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return result.count;
  }

  public async clearAll(userId: string): Promise<number> {
    const result = await this.db.notification.deleteMany({ where: { userId } });
    return result.count;
  }
}

export const notificationService = new NotificationService();
