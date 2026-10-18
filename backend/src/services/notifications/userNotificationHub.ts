/**
 * In-process publish/subscribe hub for per-user real-time notifications.
 *
 * Producers (the transaction coordinator, the retroactive scoring engine) call
 * `publish(userId, notification)` without knowing whether the user is online;
 * the notification WebSocket server (realtime/notificationSocketServer.ts)
 * subscribes each authenticated socket to its user's channel.
 *
 * Like ChatHub this is single-process: a multi-instance deployment would put a
 * Redis pub/sub adapter in front of `publish`, without changing call sites.
 */

export interface UserNotification<T = Record<string, unknown>> {
  /** Notification kind, e.g. "transaction.status" or "score.adjusted" */
  type: string;
  data: T;
  createdAt: string;
}

export type UserNotificationListener = (notification: UserNotification) => void;

export class UserNotificationHub {
  private readonly listeners = new Map<string, Set<UserNotificationListener>>();

  public subscribe(userId: string, listener: UserNotificationListener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(userId);
    };
  }

  /**
   * Delivers a notification to every live subscriber of `userId`.
   * Returns the number of listeners reached; never throws.
   */
  public publish<T extends Record<string, unknown>>(userId: string, type: string, data: T): number {
    const set = this.listeners.get(userId);
    if (!set || set.size === 0) return 0;

    const notification: UserNotification = { type, data, createdAt: new Date().toISOString() };
    let delivered = 0;
    for (const listener of [...set]) {
      try {
        listener(notification);
        delivered++;
      } catch (error) {
        console.warn(`[notifications] Listener for user ${userId} failed:`, (error as Error).message);
      }
    }
    return delivered;
  }

  public subscriberCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}

export const userNotificationHub = new UserNotificationHub();
