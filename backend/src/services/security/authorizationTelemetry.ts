import type { Request } from "express";
import { securityAnomalyLog, SecurityAnomalyType } from "./securityAnomalyLog.js";

/** No tokens, query strings, request bodies, or arbitrary client role claims. */
export function recordPermissionDenial(req: Pick<Request, "user" | "ip" | "method" | "path">, kind: string, required: readonly string[]) {
  securityAnomalyLog.record({
    type: SecurityAnomalyType.PERMISSION_DENIED,
    identifier: req.user?.id ?? "anonymous",
    userId: req.user?.id, ip: req.ip ?? "unknown",
    detail: { kind, role: req.user?.role, required: [...required], method: req.method, path: (req.path ?? "").slice(0, 256) },
  });
}
