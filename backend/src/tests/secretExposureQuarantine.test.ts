import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Writable } from "node:stream";
import { Keypair } from "@stellar/stellar-sdk";
import {
  REDACTED_SECRET,
  extractJwtTokens,
  fingerprintOf,
  isValidStellarSecretKey,
  redactText,
  redactValue,
  sanitizeForResponse,
  sanitizeValue,
  scanValue,
  textContainsSecret,
  valueContainsSecret,
  type SecretDetection,
} from "../services/security/secretScanner.js";
import {
  JwtKeyRotationHook,
  SecretQuarantineTripwire,
  SecretRedactionAuditLog,
  secretRedactionAuditLog,
  type SecretRotationHook,
} from "../services/security/secretExposureQuarantine.js";
import { createSecretSafeLogger, logger } from "../config/logger.js";
import { errorHandler } from "../middleware/error.middleware.js";

/**
 * Issue #456: automated secrets and private key exposure quarantine hook.
 *
 * Every secret below is a dummy value generated for this test run only
 * (random keypairs, throwaway JWTs signed with a test secret, invented
 * passwords). No real credential is ever logged, committed, or asserted on.
 */

const DUMMY_JWT_SECRET = "dummy-test-signing-secret-at-least-32-chars";

/** Fresh dummy Stellar secret key (valid checksum) for each use. */
function dummyStellarSecret(): string {
  return Keypair.random().secret();
}

function dummyJwt(kid?: string): string {
  return jwt.sign(
    { userId: "test-user" },
    DUMMY_JWT_SECRET,
    kid
      ? { algorithm: "HS256", keyid: kid, expiresIn: "1h" }
      : { algorithm: "HS256", expiresIn: "1h" }
  );
}

function dummyRsaPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function dummyEcPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "sec1", format: "pem" }).toString();
}

const DUMMY_CERTIFICATE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7dummyc3J0ZmljYXRl",
  "Y29udGVudHRoYXRpc3B1YmxpY2FuZG5vdGJlYXNlY3JldAo9PQ==",
  "-----END CERTIFICATE-----",
].join("\n");

describe("secret scanner: detection (issue #456)", () => {
  it("detects every secret format in the corpus at 100%", () => {
    const stellarSecret = dummyStellarSecret();
    const rsaPem = dummyRsaPrivateKeyPem();
    const ecPem = dummyEcPrivateKeyPem();
    const token = dummyJwt("test-kid-1");
    const hexKey = `0x${crypto.randomBytes(32).toString("hex")}`;
    const corpus: Array<{ label: string; sample: string; type: SecretDetection["type"]; secretPart: string }> = [
      { label: "Stellar secret key", sample: stellarSecret, type: "stellar-secret-key", secretPart: stellarSecret },
      { label: "RSA PEM private key", sample: rsaPem, type: "private-key", secretPart: rsaPem },
      { label: "EC PEM private key", sample: ecPem, type: "private-key", secretPart: ecPem },
      { label: "bare 0x private key", sample: hexKey, type: "private-key", secretPart: hexKey },
      { label: "JWT", sample: token, type: "jwt", secretPart: token },
      {
        label: "postgres connection string",
        sample: "postgres://app:Sup3rSecretDbPass!@db.internal:5432/fantasyxi",
        type: "database-credentials",
        secretPart: "Sup3rSecretDbPass!",
      },
      {
        label: "mysql connection string",
        sample: "mysql://root:An0therDbPass@127.0.0.1:3306/app",
        type: "database-credentials",
        secretPart: "An0therDbPass",
      },
      {
        label: "mongodb+srv connection string",
        sample: "mongodb+srv://user:MongoPass123@cluster.example.net/db",
        type: "database-credentials",
        secretPart: "MongoPass123",
      },
      {
        label: "redis connection string",
        sample: "redis://:RedisPass999@cache.internal:6379/0",
        type: "database-credentials",
        secretPart: "RedisPass999",
      },
      {
        label: "password assignment",
        sample: `password = "Hunter2DbPass!"`,
        type: "database-credentials",
        secretPart: "Hunter2DbPass!",
      },
      {
        label: "db_password assignment",
        sample: `db_password='DbPassw0rd!'`,
        type: "database-credentials",
        secretPart: "DbPassw0rd!",
      },
      {
        label: "Stripe-style test key",
        sample: `sk_test_${"a".repeat(24)}`,
        type: "api-key",
        secretPart: `sk_test_${"a".repeat(24)}`,
      },
      {
        label: "OpenAI-style key",
        sample: `sk-${"a".repeat(32)}`,
        type: "api-key",
        secretPart: `sk-${"a".repeat(32)}`,
      },
      { label: "GitHub PAT", sample: `ghp_${"B".repeat(36)}`, type: "api-key", secretPart: `ghp_${"B".repeat(36)}` },
      { label: "AWS access key id", sample: "AKIAIOSFODNN7EXAMPLE", type: "api-key", secretPart: "AKIAIOSFODNN7EXAMPLE" },
      {
        label: "Slack token",
        sample: `xoxb-${"123456789012"}-${"1234567890123"}-AbCdEfGhIjKlMnOp`,
        type: "api-key",
        secretPart: `xoxb-${"123456789012"}-${"1234567890123"}-AbCdEfGhIjKlMnOp`,
      },
      {
        label: "api_key assignment",
        sample: `api_key = "abcdef1234567890abcdef"`,
        type: "api-key",
        secretPart: "abcdef1234567890abcdef",
      },
      {
        label: "access_token assignment",
        sample: `access_token: abcdef1234567890abcdef`,
        type: "api-key",
        secretPart: "abcdef1234567890abcdef",
      },
    ];

    let detected = 0;
    for (const { label, sample, type, secretPart } of corpus) {
      const detections = scanValue(sample);
      assert.ok(detections.length >= 1, `${label}: expected a detection`);
      assert.ok(
        detections.some((detection) => detection.type === type),
        `${label}: expected type ${type}, got ${detections.map((d) => d.type).join(",")}`
      );
      // The redacted form keeps none of the raw secret (non-secret context
      // such as `postgres://app:` or `password =` is intentionally kept).
      assert.ok(!redactText(sample).includes(secretPart), `${label}: raw secret survived redaction`);
      detected += 1;
    }
    const rate = detected / corpus.length;
    console.log(`[secret-scanner] detection rate: ${detected}/${corpus.length} = ${(rate * 100).toFixed(0)}%`);
    assert.strictEqual(rate, 1, "detection rate on the test corpus must be 100%");
  });

  it("verifies Stellar checksums: valid keys verified, random S-strings not", () => {
    const valid = dummyStellarSecret();
    assert.equal(isValidStellarSecretKey(valid), true);
    assert.equal(scanValue(valid)[0]?.verified, true);

    const invalid = `S${"A".repeat(55)}`;
    assert.equal(isValidStellarSecretKey(invalid), false);
    const detections = scanValue(invalid);
    assert.equal(detections.length, 1, "an S-string is still redacted");
    assert.equal(detections[0]?.verified, false, "but it is not verified");
    assert.equal(redactText(`key ${invalid} here`), `key ${REDACTED_SECRET} here`);
  });

  it("does not flag public material or lookalikes (false positives)", () => {
    const publicKey = Keypair.random().publicKey();
    const lookalikes = [
      publicKey,
      "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qgc3RyaW5nIHdpdGggbm8gc2VjcmV0cw==",
      crypto.randomUUID(),
      crypto.createHash("sha256").update("not a secret").digest("hex"),
      "eyJub3QtdG9rZW4",
      "the quick brown fox jumps over the lazy dog",
      "password: null",
      "api_key = ***",
      DUMMY_CERTIFICATE_PEM,
      "postgres://app@db.internal:5432/fantasyxi",
    ];
    for (const sample of lookalikes) {
      assert.equal(
        textContainsSecret(sample),
        false,
        `false positive on ${JSON.stringify(sample.slice(0, 40))}`
      );
      assert.equal(scanValue(sample).length, 0);
    }
  });

  it("verifies JWT structure: real tokens verified, random segments not", () => {
    const token = dummyJwt();
    assert.equal(scanValue(token)[0]?.verified, true);
    assert.deepEqual(extractJwtTokens(`bearer ${token} end`), [token]);
    assert.deepEqual(extractJwtTokens("no tokens here"), []);
  });
});

describe("secret scanner: redaction (issue #456)", () => {
  it("redacts secrets inside strings, keeping non-secret context", () => {
    const stellarSecret = dummyStellarSecret();
    assert.equal(
      redactText(`connecting with ${stellarSecret} now`),
      `connecting with ${REDACTED_SECRET} now`
    );
    assert.equal(
      redactText("postgres://app:Sup3rSecretDbPass!@db.internal:5432/fantasyxi"),
      `postgres://app:${REDACTED_SECRET}@db.internal:5432/fantasyxi`
    );
    assert.equal(redactText(`password = "Hunter2DbPass!"`), `password = ${REDACTED_SECRET}`);
    const token = dummyJwt();
    assert.equal(redactText(`Authorization: Bearer ${token}`), `Authorization: Bearer ${REDACTED_SECRET}`);
  });

  it("redacts nested objects, arrays and Error stacks without mutating the input", () => {
    const stellarSecret = dummyStellarSecret();
    const token = dummyJwt();
    const input = {
      user: { id: "u1", password: "Hunter2DbPass!", apiKey: "abcdef1234567890" },
      note: `leaked ${stellarSecret}`,
      tags: [`Bearer ${token}`, "clean"],
      nested: { deep: { refreshToken: token } },
    };
    const redacted = redactValue(input) as typeof input;
    assert.equal(redacted.user.password, REDACTED_SECRET);
    assert.equal(redacted.user.apiKey, REDACTED_SECRET);
    assert.equal(redacted.note, `leaked ${REDACTED_SECRET}`);
    assert.equal(redacted.tags[0], `Bearer ${REDACTED_SECRET}`);
    assert.equal(redacted.tags[1], "clean");
    assert.equal(redacted.nested.deep.refreshToken, REDACTED_SECRET);
    assert.equal(redacted.user.id, "u1");
    // Input untouched.
    assert.equal(input.user.password, "Hunter2DbPass!");
    assert.ok(input.note.includes(stellarSecret));

    const error = new Error(`boom ${stellarSecret}`);
    error.stack = `Error: boom ${stellarSecret}\n    at somewhere`;
    const redactedError = redactValue(error) as { name: string; message: string; stack: string };
    assert.equal(redactedError.name, "Error");
    assert.ok(!redactedError.message.includes(stellarSecret));
    assert.ok(!redactedError.stack.includes(stellarSecret));
    assert.ok(redactedError.stack.includes(REDACTED_SECRET));
  });

  it("redacts values under sensitive field names wholesale", () => {
    for (const key of ["password", "apiKey", "clientSecret", "accessToken", "authorization", "jwtSecret"]) {
      const detections = scanValue({ [key]: "not-a-known-format-value" });
      assert.equal(detections.length, 1, `${key} should be flagged`);
      assert.equal(detections[0]?.type, "sensitive-field");
      assert.equal((redactValue({ [key]: "not-a-known-format-value" }) as Record<string, unknown>)[key], REDACTED_SECRET);
    }
    // Ordinary fields are left alone.
    assert.equal(scanValue({ username: "aimer", tokenCount: 3 }).length, 0);
  });

  it("handles circular references and deep values without throwing", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    const redacted = redactValue(circular) as Record<string, unknown>;
    assert.equal(redacted.self, "[Circular]");
    assert.equal(valueContainsSecret({ a: dummyStellarSecret() }), true);
    assert.equal(valueContainsSecret({ a: "nothing here" }), false);
  });

  it("sanitizes API responses, preserving shape", () => {
    const token = dummyJwt();
    const response = sanitizeForResponse({
      success: false,
      message: `failed with ${token}`,
      data: { userId: "u1" },
    });
    assert.equal(response.success, false);
    assert.equal(response.data.userId, "u1");
    assert.ok(!JSON.stringify(response).includes(token));
    assert.ok(response.message.includes(REDACTED_SECRET));
  });
});

describe("quarantine tripwire and audit trail (issue #456)", () => {
  let audit: SecretRedactionAuditLog;
  let hookCalls: Array<{ detection: SecretDetection; context: unknown }>;
  let stubHook: SecretRotationHook;
  let nowMs: number;

  beforeEach(() => {
    audit = new SecretRedactionAuditLog();
    hookCalls = [];
    stubHook = {
      rotate: async (detection, context) => {
        hookCalls.push({ detection, context });
        return { rotated: true, detail: "stub rotated" };
      },
    };
    nowMs = 1_000_000;
  });

  function productionTripwire(): SecretQuarantineTripwire {
    return new SecretQuarantineTripwire({
      auditLog: audit,
      rotationHook: stubHook,
      now: () => nowMs,
      isProduction: () => true,
    });
  }

  it("fires the rotation hook once per verified secret in production, then honors the cooldown", async () => {
    const tripwire = productionTripwire();
    const stellarSecret = dummyStellarSecret();
    const [detection] = scanValue(stellarSecret);
    assert.ok(detection?.verified);

    const first = await tripwire.handleUnredactedSecret(detection, { location: "$" });
    assert.equal(first.quarantined, true);
    assert.equal(first.rotationAttempted, true);
    assert.equal(first.rotated, true);
    assert.equal(hookCalls.length, 1);

    // Same secret again inside the cooldown: no second rotation.
    const second = await tripwire.handleUnredactedSecret(detection, { location: "$" });
    assert.equal(second.rotationAttempted, false);
    assert.equal(hookCalls.length, 1);

    // After the cooldown, it fires again.
    nowMs += 61_000;
    await tripwire.handleUnredactedSecret(detection, { location: "$" });
    assert.equal(hookCalls.length, 2);

    // A different secret is not deduped against the first.
    const other = scanValue(dummyStellarSecret())[0]!;
    await tripwire.handleUnredactedSecret(other, { location: "$" });
    assert.equal(hookCalls.length, 3);
  });

  it("does not rotate unverified matches or outside production", async () => {
    const tripwire = productionTripwire();
    const unverified = scanValue(`S${"A".repeat(55)}`)[0]!;
    assert.equal(unverified.verified, false);
    const result = await tripwire.handleUnredactedSecret(unverified, { location: "$" });
    assert.equal(result.rotationAttempted, false);
    assert.equal(hookCalls.length, 0);
    assert.equal(audit.query({ action: "REDACTED" }).length, 1);

    const nonProduction = new SecretQuarantineTripwire({
      auditLog: audit,
      rotationHook: stubHook,
      now: () => nowMs,
      isProduction: () => false,
    });
    const verified = scanValue(dummyStellarSecret())[0]!;
    const dry = await nonProduction.handleUnredactedSecret(verified, { location: "$" });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.rotationAttempted, false);
    assert.equal(hookCalls.length, 0);
    assert.equal(audit.query({ action: "QUARANTINE_DRY_RUN" }).length, 1);
  });

  it("respects NODE_ENV for the production gate with the default tripwire", async () => {
    const prevEnv = process.env.NODE_ENV;
    const localAudit = new SecretRedactionAuditLog();
    try {
      process.env.NODE_ENV = "production";
      const prodTripwire = new SecretQuarantineTripwire({ auditLog: localAudit, rotationHook: stubHook });
      const verified = scanValue(dummyStellarSecret())[0]!;
      await prodTripwire.handleUnredactedSecret(verified, { location: "$" });
      assert.equal(hookCalls.length, 1);

      process.env.NODE_ENV = "test";
      hookCalls.length = 0;
      const testTripwire = new SecretQuarantineTripwire({ auditLog: localAudit, rotationHook: stubHook });
      await testTripwire.handleUnredactedSecret(verified, { location: "$" });
      assert.equal(hookCalls.length, 0);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("quarantineValue redacts, audits, and trips in one call", async () => {
    const tripwire = productionTripwire();
    const stellarSecret = dummyStellarSecret();
    const { value, detections, results } = await tripwire.quarantineValue(
      { note: `leaked ${stellarSecret}` },
      { location: "$" }
    );
    assert.ok(!JSON.stringify(value).includes(stellarSecret));
    assert.equal(detections.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.rotated, true);
    assert.equal(audit.query().length, 2); // REDACTED + QUARANTINED
  });

  it("audit entries never contain raw secret material", async () => {
    const tripwire = productionTripwire();
    const stellarSecret = dummyStellarSecret();
    const token = dummyJwt();
    const pem = dummyRsaPrivateKeyPem();
    await tripwire.quarantineValue(
      { a: stellarSecret, b: token, c: pem, d: "postgres://app:Sup3rSecretDbPass!@db.internal/db" },
      { location: "$" }
    );
    const serialized = JSON.stringify(audit.query({ limit: 100 }));
    for (const raw of [stellarSecret, token, pem, "Sup3rSecretDbPass!"]) {
      assert.ok(!serialized.includes(raw), "audit trail leaked raw secret material");
    }
    for (const entry of audit.query({ limit: 100 })) {
      assert.ok(entry.fingerprint.length === 64, "fingerprint is a sha256 hex digest");
      assert.ok(entry.timestamp);
      assert.ok(entry.location);
      assert.ok(entry.patternType);
      assert.ok(entry.action);
    }
    // Fingerprints identify what was found without exposing it.
    assert.ok(
      audit.query().some((entry) => entry.fingerprint === fingerprintOf(stellarSecret)),
      "audit entry fingerprint matches the detected secret"
    );
  });

  it("rotation hook: JWTs revoke by kid, other types report no provider", async () => {
    const revoked: Array<{ kid: string; reason: string }> = [];
    const hook = new JwtKeyRotationHook(async (kid, reason) => {
      revoked.push({ kid, reason });
      return { kid, replacementKid: "replacement-kid-1" };
    });

    const token = dummyJwt("test-kid-99");
    const jwtDetection = scanValue(token)[0]!;
    assert.equal(jwtDetection.type, "jwt");
    const rotated = await hook.rotate(jwtDetection, { location: "$", rawSecret: token });
    assert.equal(rotated.rotated, true);
    assert.deepEqual(revoked, [{ kid: "test-kid-99", reason: "exposed in $" }]);
    assert.ok(rotated.detail.includes("replacement-kid-1"));

    // Without the raw token the kid cannot be recovered from a fingerprint.
    const noRaw = await hook.rotate(jwtDetection, { location: "$" });
    assert.equal(noRaw.rotated, false);
    assert.equal(revoked.length, 1);

    // A JWT with no kid cannot be revoked.
    const kidless = await hook.rotateFromToken(dummyJwt(), "exposed");
    assert.equal(kidless.rotated, false);
    assert.equal(revoked.length, 1);

    // Non-JWT secrets have no automated rotation provider.
    const stellarDetection = scanValue(dummyStellarSecret())[0]!;
    const other = await hook.rotate(stellarDetection, { location: "$" });
    assert.equal(other.rotated, false);
    assert.match(other.detail, /no automated rotation provider/);
  });
});

describe("logger redaction hook (issue #456)", () => {
  it("redacts secrets from Pino output and audits the redaction", async () => {
    secretRedactionAuditLog.clear();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const captureLogger = createSecretSafeLogger(stream, { level: "info" });

    const stellarSecret = dummyStellarSecret();
    const token = dummyJwt();
    captureLogger.info({ userId: "u1", note: `key is ${stellarSecret}` }, `login with ${token}`);
    captureLogger.error({ err: new Error(`db failed ${stellarSecret}`) }, "failure");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const output = lines.join("");
    assert.ok(lines.length >= 2, `expected log lines, got ${lines.length}`);
    assert.ok(!output.includes(stellarSecret), "stellar secret leaked to log output");
    assert.ok(!output.includes(token), "jwt leaked to log output");
    assert.ok(output.includes(REDACTED_SECRET), "expected redaction marker in log output");

    const entries = secretRedactionAuditLog.query({ limit: 100 });
    assert.ok(entries.length >= 2, "expected audit entries for the redactions");
    assert.ok(!JSON.stringify(entries).includes(stellarSecret));
    assert.ok(entries.some((entry) => entry.fingerprint === fingerprintOf(stellarSecret)));
  });
});

describe("error middleware redaction (issue #456)", () => {
  it("sanitizes the logged error and the response when they carry a secret", () => {
    const stellarSecret = dummyStellarSecret();
    const token = dummyJwt();
    const error = new Error(`connect failed with ${stellarSecret}`);
    error.stack = `Error: connect failed with ${stellarSecret}\n    at handler\n    token ${token}`;

    const captured: { loggedObj: unknown; loggedMsg: string | null } = { loggedObj: null, loggedMsg: null };
    const originalError = logger.error.bind(logger);
    (logger as unknown as { error: (obj: unknown, msg?: string) => void }).error = (obj, msg) => {
      captured.loggedObj = obj;
      captured.loggedMsg = msg ?? null;
    };

    const req = {
      method: "GET",
      url: `/api/v1/players?api_key=${"abcdef1234567890"}`,
      originalUrl: `/api/v1/players?api_key=${"abcdef1234567890"}`,
      ip: "127.0.0.1",
      headers: { "user-agent": "test-agent" },
    } as never;
    let statusReceived: number | null = null;
    let jsonReceived: any = null;
    const res = {
      headersSent: false,
      status: (code: number) => {
        statusReceived = code;
        return res;
      },
      json: (data: { success: boolean; message: string }) => {
        jsonReceived = data;
        return res;
      },
    } as never;

    try {
      errorHandler(error, req, res, () => {});
    } finally {
      (logger as unknown as { error: (obj: unknown, msg?: string) => void }).error = originalError;
    }

    assert.equal(statusReceived, 500);
    assert.ok(jsonReceived);
    assert.ok(!jsonReceived.message.includes(stellarSecret), "secret leaked in error response");
    assert.ok(jsonReceived.message.includes(REDACTED_SECRET));
    const logged = JSON.stringify(captured.loggedObj);
    assert.ok(!logged.includes(stellarSecret), "secret leaked in logged error");
    assert.ok(!logged.includes(token), "jwt leaked in logged error stack");
    assert.ok(!logged.includes("abcdef1234567890"), "api key leaked in logged url");
    assert.ok(logged.includes(REDACTED_SECRET));
    assert.ok(captured.loggedMsg);
    assert.ok(!captured.loggedMsg.includes(stellarSecret));
  });
});

describe("redaction overhead (issue #456)", () => {
  it("sanitizes a hot logging path without blowing up (timing reported, not thresholded)", () => {
    const sample = {
      level: 30,
      msg: "request completed",
      req: { method: "GET", url: "/api/v1/players?page=2", ip: "127.0.0.1" },
      res: { statusCode: 200 },
      durationMs: 12,
      user: { id: "u1", username: "aimer" },
    };
    const iterations = 5000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const { value } = sanitizeValue(sample);
      assert.equal((value as typeof sample).msg, "request completed");
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perCallUs = (elapsedMs * 1000) / iterations;
    console.log(
      `[secret-scanner] overhead: ${iterations} sanitizeValue calls in ${elapsedMs.toFixed(1)}ms ` +
        `(${perCallUs.toFixed(2)}us per call)`
    );
    // Smoke bound only: the run must finish promptly, not meet a brittle
    // per-call threshold on shared CI hardware.
    assert.ok(elapsedMs < 5000, `sanitizeValue took ${elapsedMs.toFixed(1)}ms for ${iterations} calls`);
  });
});
