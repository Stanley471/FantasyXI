import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { verifyAccessToken } from "../config/jwt.js";
import {
  userNotificationHub as defaultHub,
  UserNotificationHub,
} from "../services/notifications/userNotificationHub.js";

/**
 * Per-user notification WebSocket endpoint: ws(s)://<api>/api/v1/notifications/ws
 *
 * Protocol (JSON text frames), mirroring the league chat socket:
 *   client -> server  { type: "auth", token }           must be the first frame
 *   server -> client  { type: "ready", userId }         authenticated and subscribed
 *                     { type: "notification", notification }
 *                     { type: "error", code, message }
 *
 * The socket is read-only after authentication: notifications are pushed by the
 * server (transaction finality, retroactive score adjustments).
 */

export const NOTIFICATION_SOCKET_PATH = /^\/api(?:\/v1)?\/notifications\/ws$/;

export const NotificationCloseCode = {
  UNAUTHORIZED: 4401,
  AUTH_TIMEOUT: 4408,
} as const;

export interface NotificationSocketServerOptions {
  hub?: UserNotificationHub;
  /** Origins allowed to open a socket; defaults to FRONTEND_URL or http://localhost:3000 */
  allowedOrigins?: string[];
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseFrame(data: RawData): { type?: unknown; token?: unknown } | null {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function attachNotificationSocketServer(
  server: Server,
  options: NotificationSocketServerOptions = {}
) {
  const hub = options.hub ?? defaultHub;
  const allowedOrigins = new Set(options.allowedOrigins ?? [process.env.FRONTEND_URL || "http://localhost:3000"]);
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  // Only claims its own path; other upgrade listeners (league chat) handle the rest
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (!NOTIFICATION_SOCKET_PATH.test(pathname)) return;

    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (socket: WebSocket) => {
    let userId: string | null = null;
    let unsubscribe: (() => void) | null = null;

    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    const authTimer = setTimeout(() => {
      if (!userId) socket.close(NotificationCloseCode.AUTH_TIMEOUT, "Authentication timeout");
    }, authTimeoutMs);

    const fail = (reason: string) => {
      send(socket, { type: "error", code: reason, message: reason });
      socket.close(NotificationCloseCode.UNAUTHORIZED, reason);
    };

    socket.on("message", (data) => {
      const frame = parseFrame(data);
      if (!frame) {
        send(socket, { type: "error", code: "bad_request", message: "Frames must be JSON objects" });
        return;
      }
      if (userId) {
        send(socket, { type: "error", code: "bad_request", message: "This socket only receives notifications" });
        return;
      }
      if (frame.type !== "auth" || typeof frame.token !== "string" || frame.token.length === 0) {
        fail("unauthorized");
        return;
      }

      try {
        const payload = verifyAccessToken(frame.token);
        if (!payload.userId) throw new Error("missing userId");
        userId = payload.userId;
      } catch {
        fail("unauthorized");
        return;
      }

      clearTimeout(authTimer);
      unsubscribe = hub.subscribe(userId, (notification) => send(socket, { type: "notification", notification }));
      send(socket, { type: "ready", userId });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
    });
    socket.on("error", () => socket.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    wss,
    close(): Promise<void> {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const socket of wss.clients) socket.close(1001, "Server shutting down");
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
