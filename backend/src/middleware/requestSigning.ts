import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IRedisCacheClient } from "../config/redis.js";
import {
  API_SIGNING_HEADERS,
  API_SIGNING_TOLERANCE_SECONDS,
  verifyApiRequestSignature,
  type ApiSecretConfig,
} from "../services/apiSigning/requestSigner.js";
import {
  getDefaultApiNonceStore,
  RedisApiNonceStore,
  type ApiNonceStore,
} from "../services/apiSigning/nonceStore.js";

/**
 * HMAC-SHA256 request-signing middleware for public API endpoints (issue #455).
 *
 * Partners sign requests with `X-Signature`, `X-Timestamp` and `X-Nonce`
 * (see `src/sdk/apiSigning.ts` and `services/apiSigning/requestSigner.ts`).
 * Verification order, chosen so a bad signature can never burn a victim's
 * nonce and lock out the legitimate request:
 *
 *   1. Headers present and well-formed, else 401.
 *   2. Timestamp within 300s of the server clock, else 401.
 *   3. HMAC-SHA256 signature verified in constant time, else 401.
 *   4. Nonce atomically claimed in Redis (SET NX EX, TTL = skew window);
 *      an already-consumed nonce is a replay, rejected with 401.
 *
 * Rollout / compatibility:
 * - Enforcement is OFF by default and enabled only when
 *   `API_REQUEST_SIGNING_ENABLED=true`. While off, the middleware is a
 *   pass-through: browser and frontend traffic is untouched.
 * - When on, it applies ONLY to GET requests on the public read prefixes
 *   below (`/api/v1/players`, `/api/v1/fixtures`, …). Auth routes, mutations,
 *   admin/sync routes, webhooks, health checks and `/.well-known/jwks.json`
 *   are never covered, so existing auth flows keep working exactly as before.
 * - Secrets come from `API_SIGNING_SECRET` (+ optional
 *   `API_SIGNING_SECRET_SECONDARY` for rotation). If enforcement is on but
 *   no secret is configured, requests fail closed with 503.
 * - Consumed nonces live in Redis via the shared client in
 *   `config/redis.ts`; when Redis is disabled or unreachable, a bounded
 *   in-memory store is used instead (single-instance replay defense only —
 *   see `services/apiSigning/nonceStore.ts`).
 */

export const API_SIGNING_ENABLED_ENV = "API_REQUEST_SIGNING_ENABLED";
export const API_SIGNING_SECRET_ENV = "API_SIGNING_SECRET";
export const API_SIGNING_SECRET_SECONDARY_ENV = "API_SIGNING_SECRET_SECONDARY";
export const API_SIGNING_TOLERANCE_ENV = "API_SIGNING_TOLERANCE_SECONDS";

/**
 * Public read prefixes covered when signing is enabled, under both mounts
 * (`/api/v1` and `/api` — see `app.ts`).
 */
export const PUBLIC_SIGNED_PATH_PREFIXES: readonly string[] = [
  "/api/v1/players",
  "/api/players",
  "/api/v1/teams",
  "/api/teams",
  "/api/v1/gameweeks",
  "/api/gameweeks",
  "/api/v1/fixtures",
  "/api/fixtures",
  "/api/v1/leaderboard",
  "/api/leaderboard",
  "/api/v1/live",
  "/api/live",
  "/api/v1/analytics",
  "/api/analytics",
  "/api/v1/proof-of-reserve",
  "/api/proof-of-reserve",
];

/** True when `path` is one of the covered public endpoints (prefix match). */
export function isPublicSignedPath(path: string): boolean {
  return PUBLIC_SIGNED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

export interface RequestSigningOptions {
  /** Secrets, or env (`API_SIGNING_SECRET` / `API_SIGNING_SECRET_SECONDARY`) when omitted. */
  secrets?: ApiSecretConfig;
  /** Defaults to `API_REQUEST_SIGNING_ENABLED === "true"`. */
  enabled?: boolean;
  /** Clock-skew window in seconds; defaults to 300 (`API_SIGNING_TOLERANCE_SECONDS`). */
  toleranceSeconds?: number;
  /** Nonce store or a lazy factory; defaults to Redis, else process memory. */
  nonceStore?: ApiNonceStore | (() => ApiNonceStore);
  /** Redis client for the nonce store; defaults to the shared client. */
  redisClient?: IRedisCacheClient | null;
  /** HTTP methods covered; defaults to GET only (public endpoints are reads). */
  methods?: string[];
  /** Epoch milliseconds; defaults to Date.now(). Injectable for tests. */
  now?: () => number;
  /** Extra per-request bypass (e.g. health probes in tests). */
  skip?: (req: Request) => boolean;
}

export interface ApiSigningRequestData {
  verified: boolean;
  timestamp: string;
  nonce: string;
  usedSecret: "primary" | "secondary";
}

declare global {
  namespace Express {
    interface Request {
      apiSigning?: ApiSigningRequestData;
    }
  }
}

function resolveSecrets(options: RequestSigningOptions): ApiSecretConfig | undefined {
  if (options.secrets !== undefined) return options.secrets;
  const primary = process.env[API_SIGNING_SECRET_ENV];
  if (!primary) return undefined;
  const secondary = process.env[API_SIGNING_SECRET_SECONDARY_ENV];
  return secondary ? { primarySecret: primary, secondarySecret: secondary } : primary;
}

function resolveEnabled(options: RequestSigningOptions): boolean {
  if (options.enabled !== undefined) return options.enabled;
  return process.env[API_SIGNING_ENABLED_ENV] === "true";
}

function resolveToleranceSeconds(options: RequestSigningOptions): number {
  if (options.toleranceSeconds !== undefined) return options.toleranceSeconds;
  const parsed = Number.parseInt(process.env[API_SIGNING_TOLERANCE_ENV] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : API_SIGNING_TOLERANCE_SECONDS;
}

/** The request body as the signer sees it (raw body when captured, else parsed body). */
function requestBodyForSigning(req: Request): unknown {
  const rawBody = (req as unknown as { rawBody?: unknown }).rawBody;
  if (rawBody !== undefined) return rawBody;
  return req.body;
}

function unauthorized(res: Response, code: string, message: string): void {
  res.status(401).json({ success: false, code, message });
}

export function createRequestSigning(options: RequestSigningOptions = {}): RequestHandler {
  const methods = new Set((options.methods ?? ["GET"]).map((m) => m.toUpperCase()));
  const now = options.now ?? Date.now;
  let resolvedStore: ApiNonceStore | null = null;
  const getStore = (): ApiNonceStore => {
    if (!resolvedStore) {
      if (options.nonceStore) {
        resolvedStore = typeof options.nonceStore === "function" ? options.nonceStore() : options.nonceStore;
      } else if (options.redisClient !== undefined) {
        resolvedStore = options.redisClient
          ? new RedisApiNonceStore(options.redisClient)
          : getDefaultApiNonceStore();
      } else {
        resolvedStore = getDefaultApiNonceStore();
      }
    }
    return resolvedStore;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Config is resolved per request (not at import time) so `.env` values
      // loaded by `dotenv.config()` in app.ts are honoured.
      if (!resolveEnabled(options)) return next();
      if (options.skip?.(req)) return next();
      if (!methods.has(req.method)) return next();
      if (!isPublicSignedPath(req.path)) return next();

      const signature = req.get(API_SIGNING_HEADERS.signature);
      const timestamp = req.get(API_SIGNING_HEADERS.timestamp);
      const nonce = req.get(API_SIGNING_HEADERS.nonce);
      if (!signature || !timestamp || !nonce) {
        unauthorized(
          res,
          "API_SIGNING_MISSING_HEADERS",
          "Missing required request signing headers (X-Signature, X-Timestamp, X-Nonce)"
        );
        return;
      }

      const secrets = resolveSecrets(options);
      if (!secrets) {
        console.error("[api-signing] Request signing is enabled but no API signing secret is configured");
        res.status(503).json({
          success: false,
          code: "API_SIGNING_NOT_CONFIGURED",
          message: "Request signing is enabled but no signing secret is configured",
        });
        return;
      }

      const toleranceSeconds = resolveToleranceSeconds(options);
      const verification = verifyApiRequestSignature({
        method: req.method,
        // originalUrl keeps the query string in the signed path.
        path: req.originalUrl || req.path,
        timestamp,
        nonce,
        body: requestBodyForSigning(req),
        signature,
        secrets,
        toleranceSeconds,
        nowMs: now(),
      });
      if (!verification.valid) {
        const code = verification.reason.startsWith("Request timestamp")
          ? "API_SIGNING_TIMESTAMP_EXPIRED"
          : verification.reason.startsWith("Invalid X-Nonce")
            ? "API_SIGNING_INVALID_NONCE"
            : verification.reason.startsWith("Invalid X-Timestamp")
              ? "API_SIGNING_INVALID_TIMESTAMP"
              : "API_SIGNING_INVALID_SIGNATURE";
        unauthorized(res, code, verification.reason);
        return;
      }

      // Signature verified — only now claim the nonce, atomically.
      let nonceFresh: boolean;
      try {
        nonceFresh = await getStore().consume(nonce, toleranceSeconds);
      } catch (error) {
        console.error("[api-signing] Nonce store unavailable", error);
        res.status(503).json({
          success: false,
          code: "API_SIGNING_UNAVAILABLE",
          message: "Request signing service unavailable; retry the request",
        });
        return;
      }
      if (!nonceFresh) {
        unauthorized(
          res,
          "API_SIGNING_NONCE_REPLAYED",
          "Replay attack detected: this nonce has already been used"
        );
        return;
      }

      req.apiSigning = {
        verified: true,
        timestamp,
        nonce,
        usedSecret: verification.usedSecret,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Default middleware instance, driven entirely by environment:
 * `API_REQUEST_SIGNING_ENABLED`, `API_SIGNING_SECRET`,
 * `API_SIGNING_SECRET_SECONDARY`, `API_SIGNING_TOLERANCE_SECONDS`.
 * Pass-through while disabled.
 */
export const requestSigning = createRequestSigning();
