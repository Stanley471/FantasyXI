import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { verifyAccessToken } from "../config/jwt.js";
import { eventFanout, type EventFanout } from "../services/live/eventFanout.js";
import { sequenceTracker, type SequenceTaggedEvent } from "../services/live/sequenceTracker.js";
import { BoundedSocketSender } from "./boundedSocket.js";

export const LIVE_SOCKET_PATH = /^\/api(?:\/v1)?\/live\/(\d+)\/ws$/;

export function attachLiveSocketServer(server: Server, fanout: EventFanout = eventFanout) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = LIVE_SOCKET_PATH.exec(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!match) return;
    if (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) { socket.destroy(); return; }
    if (req.headers.origin && req.headers.origin !== (process.env.FRONTEND_URL || "http://localhost:3000")) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, String(Number(match[1]))));
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (socket, gameweekId: string) => {
    const sender = new BoundedSocketSender(socket);
    let unsubscribe: (() => void) | undefined;
    let alive = true;
    const authTimer = setTimeout(() => socket.terminate(), 5000);
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 30_000);
    heartbeat.unref();
    socket.on("pong", () => { alive = true; });
    socket.on("message", async (raw) => {
      if (unsubscribe) return;
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "auth") {
          if (!verifyAccessToken(frame.token).userId) throw new Error("Unauthorized");
          clearTimeout(authTimer);
          unsubscribe = fanout.subscribe(`matchday:${gameweekId}`, (deltaFrame) => sender.send(deltaFrame));

          const channel = `matchday:${gameweekId}`;
          const lastSeq = frame.lastSeenSequenceNumber ?? 0;
          const backfill = await sequenceTracker.getBackfillWindow(channel, lastSeq);

          if (backfill.length > 0) {
            sender.send({ type: "backfill", events: backfill });
          }

          const currentSeq = await sequenceTracker.getLastSequenceNumber(channel);
          sender.send({ type: "ready", gameweekId: Number(gameweekId), currentSequence: currentSeq });
        }
      } catch { socket.close(4401, "Unauthorized"); }
    });
    socket.on("close", () => { clearTimeout(authTimer); clearInterval(heartbeat); unsubscribe?.(); });
    socket.on("error", () => socket.terminate());
  });
  return { close: async () => {
    server.off("upgrade", upgrade);
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  } };
}
