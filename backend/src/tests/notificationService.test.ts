import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { NotificationService } from "../services/notifications/notificationService.js";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearAllNotifications,
} from "../controllers/notification.controller.js";

/**
 * Notification center drawer backend (issue #500): create/list/mark-read/
 * clear-all for a user's own notifications.
 */

function createMockDb() {
  const rows: any[] = [];
  let seq = 0;

  return {
    rows,
    notification: {
      create: async ({ data }: any) => {
        const record = {
          id: `notif_${++seq}`,
          isRead: false,
          readAt: null,
          createdAt: new Date(Date.now() + seq),
          ...data,
        };
        rows.push(record);
        return record;
      },
      findMany: async ({ where, take, cursor, skip }: any) => {
        let filtered = rows
          .filter((r) => r.userId === where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        let start = 0;
        if (cursor?.id) {
          start = filtered.findIndex((r) => r.id === cursor.id) + (skip || 0);
        }
        return filtered.slice(start, take !== undefined ? start + take : undefined);
      },
      count: async ({ where }: any) =>
        rows.filter((r) => r.userId === where.userId && r.isRead === where.isRead).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) {
          const matchesId = where.id === undefined || r.id === where.id;
          const matchesUser = where.userId === undefined || r.userId === where.userId;
          const matchesRead = where.isRead === undefined || r.isRead === where.isRead;
          if (matchesId && matchesUser && matchesRead) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].userId === where.userId) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

describe("NotificationService (issue #500)", () => {
  it("lists a user's notifications newest-first with an accurate unread count", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    await service.create({ userId: "u1", type: "league_invite", title: "You were invited" });
    await service.create({ userId: "u1", type: "payment_confirmed", title: "Payment confirmed" });
    await service.create({ userId: "u2", type: "league_invite", title: "Other user's notification" });

    const page = await service.listForUser("u1");
    assert.equal(page.notifications.length, 2);
    assert.equal(page.unreadCount, 2);
    assert.equal((page.notifications[0] as any).title, "Payment confirmed");
  });

  it("decrements the unread count when a notification is marked read", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    const notif = await service.create({ userId: "u1", type: "league_invite", title: "Invite" });
    await service.create({ userId: "u1", type: "league_invite", title: "Another invite" });

    const marked = await service.markRead("u1", notif.id);
    assert.equal(marked, true);

    const page = await service.listForUser("u1");
    assert.equal(page.unreadCount, 1);
    assert.equal((page.notifications.find((n: any) => n.id === notif.id) as any).isRead, true);
  });

  it("never marks another user's notification as read", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    const notif = await service.create({ userId: "u1", type: "league_invite", title: "Invite" });

    const marked = await service.markRead("intruder", notif.id);
    assert.equal(marked, false);
    assert.equal((await service.listForUser("u1")).unreadCount, 1);
  });

  it("marks every notification read with markAllRead", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    await service.create({ userId: "u1", type: "a", title: "A" });
    await service.create({ userId: "u1", type: "b", title: "B" });
    await service.create({ userId: "u1", type: "c", title: "C" });

    const count = await service.markAllRead("u1");
    assert.equal(count, 3);
    assert.equal((await service.listForUser("u1")).unreadCount, 0);
  });

  it("removes every notification with clearAll", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    await service.create({ userId: "u1", type: "a", title: "A" });
    await service.create({ userId: "u1", type: "b", title: "B" });

    const count = await service.clearAll("u1");
    assert.equal(count, 2);
    assert.equal((await service.listForUser("u1")).notifications.length, 0);
  });

  it("carries the deep-link through to the stored notification", async () => {
    const db = createMockDb();
    const service = new NotificationService(db as any);
    await service.create({
      userId: "u1",
      type: "league_invite",
      title: "You were invited",
      link: "/leagues/abc123",
    });

    const page = await service.listForUser("u1");
    assert.equal((page.notifications[0] as any).link, "/leagues/abc123");
  });
});

function createMockReqRes(options: { user?: { id: string }; query?: Record<string, string>; params?: Record<string, string> }) {
  let statusCode = 200;
  let jsonResponse: any = null;

  const req = {
    user: options.user,
    query: options.query || {},
    params: options.params || {},
  } as unknown as Request;

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: any) => {
      jsonResponse = payload;
      return res;
    },
  } as unknown as Response;

  const next: NextFunction = () => {};

  return { req, res, next, getStatusCode: () => statusCode, getJsonResponse: () => jsonResponse };
}

describe("Notification Controllers (issue #500)", () => {
  it("rejects listNotifications without authentication", async () => {
    const { req, res, next, getStatusCode } = createMockReqRes({ user: undefined });
    await listNotifications(req, res, next);
    assert.equal(getStatusCode(), 401);
  });

  it("rejects markNotificationRead without authentication", async () => {
    const { req, res, next, getStatusCode } = createMockReqRes({ user: undefined, params: { id: "x" } });
    await markNotificationRead(req, res, next);
    assert.equal(getStatusCode(), 401);
  });

  it("rejects markAllNotificationsRead without authentication", async () => {
    const { req, res, next, getStatusCode } = createMockReqRes({ user: undefined });
    await markAllNotificationsRead(req, res, next);
    assert.equal(getStatusCode(), 401);
  });

  it("rejects clearAllNotifications without authentication", async () => {
    const { req, res, next, getStatusCode } = createMockReqRes({ user: undefined });
    await clearAllNotifications(req, res, next);
    assert.equal(getStatusCode(), 401);
  });
});
