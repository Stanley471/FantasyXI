import { Request, Response, NextFunction } from "express";
import { getRedisClient, type IRedisCacheClient } from "../config/redis.js";
import {
  verifyInternalWebhook,
  InternalWebhookSecretConfig,
} from "../services/webhooks/internalWebhookSigner.js";

export interface InternalWebhookAuthOptions {
  secrets?: string | string[] | InternalWebhookSecretConfig;
  toleranceSeconds?: number;
  redisClient?: IRedisCacheClient | null;
}

export interface InternalWebhookRequestData {
  verified: boolean;
  timestamp: string;
  nonce: string;
  signature: string;
  usedSecret?: "primary" | "secondary";
}

declare global {
  namespace Express {
    interface Request {
      internalWebhook?: InternalWebhookRequestData;
    }
  }
}

/**
 * Creates an Express middleware for verifying inter-service internal webhook requests.
 */
export function createInternalWebhookAuth(options: InternalWebhookAuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Extract authentication headers (case-insensitive)
    const signature = (req.headers["x-fantasy-signature"] || req.headers["x-fantasysignature"]) as string | undefined;
    const timestamp = (req.headers["x-fantasy-timestamp"] || req.headers["x-fantasytimestamp"]) as string | undefined;
    const nonce = (req.headers["x-fantasy-nonce"] || req.headers["x-fantasynonce"]) as string | undefined;

    if (!signature || !timestamp || !nonce) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing required internal webhook authentication headers (X-Fantasy-Signature, X-Fantasy-Timestamp, X-Fantasy-Nonce)",
      });
      return;
    }

    // 2. Resolve configured secrets
    const primarySecret =
      process.env.INTERNAL_WEBHOOK_SECRET ||
      process.env.WEBHOOK_SECRET ||
      "default_internal_webhook_secret_key";
    const secondarySecret =
      process.env.INTERNAL_WEBHOOK_SECRET_SECONDARY ||
      process.env.WEBHOOK_SECRET_SECONDARY;

    const secrets: string | string[] | InternalWebhookSecretConfig =
      options.secrets ?? {
        primarySecret,
        ...(secondarySecret ? { secondarySecret } : {}),
      };

    const redisClient = options.redisClient !== undefined ? options.redisClient : getRedisClient();
    const toleranceSeconds = options.toleranceSeconds ?? 300;

    // 3. Determine payload
    const payload = (req as any).rawBody || req.body || "";

    // 4. Verify request
    const verification = await verifyInternalWebhook(
      payload,
      { signature, timestamp, nonce },
      secrets,
      {
        toleranceSeconds,
        redisClient,
      }
    );

    if (!verification.valid) {
      if (verification.status === 409) {
        res.status(409).json({
          error: "Conflict",
          message: verification.error || "Replay attack detected: Nonce already used",
        });
        return;
      }

      res.status(401).json({
        error: "Unauthorized",
        message: verification.error || "Webhook authentication failed",
      });
      return;
    }

    // 5. Store authentication metadata on request
    req.internalWebhook = {
      verified: true,
      timestamp,
      nonce,
      signature,
      usedSecret: verification.usedSecret,
    };

    next();
  };
}

/**
 * Default middleware instance using environment variables and default Redis client.
 */
export const internalWebhookAuth = createInternalWebhookAuth();
