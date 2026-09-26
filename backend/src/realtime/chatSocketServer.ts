import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { verifyAccessToken } from "../config/jwt.js";
import {
  chatService as defaultChatService,
  ChatService,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatRateLimitError,
  ChatValidationError,
} from "../services/chat/chatService.js";

/**
 * League chat WebSocket endpoint: ws(s)://<api>/api/v1/leagues/:leagueId/chat/ws
 *
 * Protocol (JSON text frames):
 *   client -> server  { type: "auth", token }                 must be the first frame
 *                     { type: "message", body, clientId? }    post a message
 *   server -> client  { type: "ready", leagueId, userId }     authenticated and subscribed
 *                     { type: "message", message }            broadcast to everyone in the league
 *                     { type: "ack", clientId, message }      sender's confirmation
 *                     { type: "error", code, message, clientId?, retryAfterMs? }
 *
 * Browsers cannot set an Authorization header on a WebSocket, and a token in the
 * URL would end up in proxy logs, so the JWT is sent in the first frame instead.
 */

export const CHAT_SOCKET_PATH = /^\/api(?:\/v1)?\/leagues\/([^/]+)\/chat\/ws$/;

/** Application close codes (4000-4999 are reserved for applications) */
export const CloseCode = {
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  NOT_FOUND: 4404,
  AUTH_TIMEOUT: 4408,
} as const;

export interface ChatSocketServerOptions {
  service?: ChatService;
  /** Origins allowed to open a socket; defaults to FRONTEND_URL or http://localhost:3000 */
  allowedOrigins?: string[];
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

interface ClientFrame {
  type?: unknown;
  token?: unknown;
  body?: unknown;
  clientId?: unknown;
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

function parseFrame(data: RawData): ClientFrame | null {
  try {
    const parsed = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? (parsed as ClientFrame) : null;
  } catch {
    return null;
  }
}

/** Client-supplied correlation id, echoed back so the UI can reconcile optimistic messages */
function readClientId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
}

export function attachChatSocketServer(server: Server, options: ChatSocketServerOptions = {}) {
  const service = options.service ?? defaultChatService;
  const allowedOrigins = new Set(options.allowedOrigins ?? [process.env.FRONTEND_URL || "http://localhost:3000"]);
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const match = CHAT_SOCKET_PATH.exec(pathname);
    // This is the API's only WebSocket endpoint; other upgrade requests are refused
    if (!match) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    // Only our own frontend may open sockets (cross-site WebSocket hijacking protection)
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    let leagueId: string;
    try {
      leagueId = decodeURIComponent(match[1]);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, leagueId));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (socket: WebSocket, leagueId: string) => {
    let userId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let authenticating = false;

    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    const authTimer = setTimeout(() => {
      if (!userId) socket.close(CloseCode.AUTH_TIMEOUT, "Authentication timeout");
    }, authTimeoutMs);

    const fail = (code: number, reason: string) => {
      send(socket, { type: "error", code: reason, message: reason });
      socket.close(code, reason);
    };

    const authenticate = async (token: unknown) => {
      if (typeof token !== "string" || token.length === 0) {
        fail(CloseCode.UNAUTHORIZED, "unauthorized");
        return;
      }
      let candidate: string;
      try {
        const payload = verifyAccessToken(token);
        if (!payload.userId) throw new Error("missing userId");
        candidate = payload.userId;
      } catch {
        fail(CloseCode.UNAUTHORIZED, "unauthorized");
        return;
      }

      try {
        await service.assertCanAccess(leagueId, candidate);
      } catch (error) {
        if (error instanceof ChatNotFoundError) return fail(CloseCode.NOT_FOUND, "not_found");
        if (error instanceof ChatForbiddenError) return fail(CloseCode.FORBIDDEN, "forbidden");
        console.error("[chat] Access check failed:", error);
        return fail(1011, "server_error");
      }

      if (socket.readyState !== WebSocket.OPEN) return;
      clearTimeout(authTimer);
      userId = candidate;
      unsubscribe = service.hub.subscribe(leagueId, (message) => send(socket, { type: "message", message }));
      send(socket, { type: "ready", leagueId, userId });
    };

    const postMessage = async (frame: ClientFrame) => {
      const clientId = readClientId(frame.clientId);
      try {
        const message = await service.postMessage(leagueId, userId!, frame.body);
        send(socket, { type: "ack", clientId, message });
      } catch (error) {
        if (error instanceof ChatValidationError) {
          send(socket, { type: "error", code: "invalid_message", message: error.message, clientId });
        } else if (error instanceof ChatRateLimitError) {
          send(socket, {
            type: "error",
            code: "rate_limited",
            message: error.message,
            clientId,
            retryAfterMs: error.retryAfterMs,
          });
        } else if (error instanceof ChatForbiddenError || error instanceof ChatNotFoundError) {
          // Membership was revoked (or the league deleted) while connected
          fail(CloseCode.FORBIDDEN, "forbidden");
        } else {
          console.error("[chat] Failed to post message:", error);
          send(socket, { type: "error", code: "server_error", message: "Message could not be sent", clientId });
        }
      }
    };

    socket.on("message", (data) => {
      const frame = parseFrame(data);
      if (!frame) {
        send(socket, { type: "error", code: "bad_request", message: "Frames must be JSON objects" });
        return;
      }

      if (!userId) {
        if (authenticating) {
          send(socket, { type: "error", code: "not_ready", message: "Wait for the ready frame before sending" });
          return;
        }
        if (frame.type !== "auth") {
          fail(CloseCode.UNAUTHORIZED, "unauthorized");
          return;
        }
        authenticating = true;
        void authenticate(frame.token);
        return;
      }

      if (frame.type === "message") {
        void postMessage(frame);
      } else {
        send(socket, { type: "error", code: "bad_request", message: "Unknown frame type" });
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
    });
    socket.on("error", () => socket.terminate());
  });

  // Drop connections that stop answering pings (sleeping laptops, dropped mobile networks)
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
