import pino from "pino";
import { extractJwtTokens, sanitizeValue } from "../services/security/secretScanner.js";
import { secretQuarantineTripwire } from "../services/security/secretExposureQuarantine.js";

/**
 * Pino logger with the secret-exposure quarantine hook (issue #456).
 *
 * Every log record passes through `sanitizeValue` in the `logMethod` hook
 * before it is written, so no log call — Pino or Winston-style, stdout or
 * a cloud logger — can emit a Stellar secret key, a private key, a JWT, a
 * database password, or an API key. Matches are replaced with
 * `[REDACTED_SECRET]`; values under sensitive field names
 * (`password`, `apiKey`, `authorization`, ...) are replaced wholesale.
 *
 * Secrets found in a record are also audited, and a *verified* secret
 * trips the quarantine hook: in production the rotation hook fires (for a
 * JWT found in a top-level log string, the raw token is passed along
 * in-memory only so its signing key can be revoked); elsewhere the event
 * is recorded as a dry run. The hook never throws and never blocks the
 * log call — tripwire work is fire-and-forget, and a failure to sanitize
 * falls back to the original arguments rather than dropping the log line.
 */

function sanitizeLogArgs(args: unknown[], level: string): unknown[] {
  const redactedArgs: unknown[] = [];
  try {
    args.forEach((arg, argIndex) => {
      const location = `log:${level}[${argIndex}]`;
      const { value, detections } = sanitizeValue(arg, location);
      redactedArgs.push(value);
      if (detections.length === 0) return;

      secretQuarantineTripwire.recordRedactions(detections, location);
      // A JWT in a top-level log string can be revoked by its `kid`: pair
      // each JWT detection with the raw token from the same string, in
      // match order. Raw tokens stay in this scope only — they are passed
      // to the rotation hook and never logged or audited.
      const rawTokens = typeof arg === "string" ? extractJwtTokens(arg) : [];
      const jwtDetections = detections.filter((detection) => detection.type === "jwt");
      detections
        .filter((detection) => detection.verified)
        .forEach((detection) => {
          const rawSecret =
            detection.type === "jwt"
              ? rawTokens[jwtDetections.indexOf(detection)]
              : undefined;
          secretQuarantineTripwire
            .handleUnredactedSecret(detection, { location, rawSecret })
            .catch((error) => console.error("[secret-quarantine] Tripwire failed:", error));
        });
    });
  } catch (error) {
    // Sanitization must never drop a log line: fall back to the raw args.
    console.error("[secret-quarantine] Log sanitization failed; emitting unredacted args:", error);
    return args;
  }
  return redactedArgs;
}

export function createSecretSafeLogger(
  destination?: pino.DestinationStream,
  options: pino.LoggerOptions = {}
): pino.Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
      timestamp: pino.stdTimeFunctions.isoTime,
      ...options,
      hooks: {
        logMethod(args, method, level) {
          const levelName =
            ({ 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" })[
              level as number
            ] ?? String(level);
          const log = method as unknown as (this: unknown, ...args: unknown[]) => unknown;
          return log.apply(this, sanitizeLogArgs(Array.from(args as unknown[]), levelName));
        },
      },
    },
    destination
  );
}

export const logger = createSecretSafeLogger();

export default logger;
