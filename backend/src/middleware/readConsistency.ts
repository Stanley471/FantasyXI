import { Request, Response, NextFunction } from "express";
import { readConsistencyStorage, runWithReplicaReads, runOnPrimary } from "../config/readReplicas.js";

import { verifyAccessToken } from "../config/jwt.js";

/** Establish identity before optional route auth; the verified token is used only for routing. */
export function requestReadConsistency(req: Request, _res: Response, next: NextFunction): void {
  let verifiedUserId: string | undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  if (match) {
    try { verifiedUserId = verifyAccessToken(match[1]).userId; } catch { /* auth guards reject invalid tokens */ }
  }
  readConsistencyStorage.run({
    allowReplica: false, hasWritten: false, userId: () => req.user?.id ?? verifiedUserId,
  }, next);
}

/**
 * Read-consistency middleware for multi-region read replicas.
 *
 * Replica reads are opt-in: only routers mounted with `replicaReads` (read-heavy
 * public data such as players, fixtures and leagues) may be served by a replica.
 * Every other route (auth, payments, admin tooling) and every background job
 * uses the primary.
 *
 * Clients that must observe their own recent write can send
 * `X-Read-Consistency: strong` to force the primary.
 */

function wantsStrongReads(req: Request): boolean {
  return String(req.headers["x-read-consistency"] ?? "").toLowerCase() === "strong";
}

/**
 * GET/HEAD requests on this router may read from the nearest replica; other
 * methods stay on the primary.
 */
export function replicaReads(req: Request, _res: Response, next: NextFunction): void {
  const safeMethod = req.method === "GET" || req.method === "HEAD";
  if (safeMethod && !wantsStrongReads(req)) {
    runWithReplicaReads(next);
  } else {
    runOnPrimary(next);
  }
}

/**
 * For endpoints that are read-only regardless of HTTP method (e.g. the GraphQL
 * endpoint, whose schema exposes queries only).
 */
export function preferReplicaReads(req: Request, _res: Response, next: NextFunction): void {
  if (wantsStrongReads(req)) {
    runOnPrimary(next);
  } else {
    runWithReplicaReads(next);
  }
}

/**
 * Pins a route to the primary, overriding an outer `replicaReads`. Used for GET
 * endpoints that write or feed financial decisions (e.g. payment requirements).
 */
export function primaryReads(_req: Request, _res: Response, next: NextFunction): void {
  runOnPrimary(next);
}
