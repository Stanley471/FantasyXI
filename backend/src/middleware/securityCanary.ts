import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { getRedisClient } from "../config/redis.js";
import { adminAlertNotifier } from "../services/notifications/adminAlertNotifier.js";

export interface CanaryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
}

/** Shared lockouts are checked before routing, including on the public GraphQL endpoint. */
export function createSecurityCanary(options: {
  store: () => CanaryStore | null;
  alert: (event: { ipHash: string; actorId?: string; path: string }) => Promise<unknown>;
  ttlSeconds?: number;
}) {
  const ttl = options.ttlSeconds ?? 900;
  const keyFor = (ip: string) => "security:canary:" + crypto.createHash("sha256").update(ip).digest("hex");
  const guard: RequestHandler = async (req, res, next) => {
    const store = options.store();
    if (!store) { next(); return; }
    try {
      if (await store.get(keyFor(req.ip ?? req.socket.remoteAddress ?? "unknown"))) {
        res.status(403).json({ success: false, message: "Access denied.", code: "SECURITY_LOCKOUT" });
        return;
      }
      next();
    } catch { res.status(503).json({ success: false, message: "Security checks unavailable." }); }
  };
  const trigger: RequestHandler = async (req, res) => {
    const key = keyFor(req.ip ?? req.socket.remoteAddress ?? "unknown");
    const store = options.store();
    // Never claim a cluster lockout when its authoritative shared store is unavailable.
    if (!store) { res.status(503).json({ success: false, message: "Security checks unavailable." }); return; }
    try {
      await store.set(key, "1", "EX", ttl);
      await options.alert({ ipHash: key.split(":").at(-1)!, actorId: req.user?.id, path: req.path });
      res.status(403).json({ success: false, message: "Access denied.", code: "SECURITY_LOCKOUT" });
    } catch { res.status(503).json({ success: false, message: "Security checks unavailable." }); }
  };
  return { guard, trigger };
}

export const securityCanary = createSecurityCanary({
  store: () => getRedisClient() as CanaryStore | null,
  alert: async ({ ipHash, actorId, path }) => adminAlertNotifier.notify({
    title: "Privilege escalation canary accessed", severity: "critical",
    text: JSON.stringify({ ipHash, actorId, path }),
  }),
});
