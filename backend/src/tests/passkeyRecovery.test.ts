import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { PasskeyRecoveryService } from "../services/auth/passkeyRecoveryService.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");

describe("Passkey recovery", () => {
  it("verifies a one-time proof and invalidates passkeys, refresh tokens, and sessions", async () => {
    const keyPair = ed25519.keygen(new Uint8Array(32).fill(7));
    const challenges = new Map<string, any>();
    let recoveryKey: any;
    let deletedPasskeys = 0;
    let revokedRefreshTokens = 0;
    let revokedSessions = 0;
    const events: any[] = [];
    const emails: any[] = [];
    const user = {
      id: "user-1",
      email: "manager@example.test",
      username: "manager",
      role: "USER",
      passwordHash: "never-return-this",
      createdAt: new Date(),
    };
    const tx = {
      passkeyRecoveryKey: {
        upsert: async ({ create, update }: any) => {
          recoveryKey = recoveryKey ? { ...recoveryKey, ...update } : create;
        },
        update: async ({ data }: any) => Object.assign(recoveryKey, data),
      },
      passkeyRecoveryChallenge: {
        deleteMany: async () => challenges.clear(),
        updateMany: async ({ where, data }: any) => {
          const entry = challenges.get(where.id);
          if (!entry || entry.usedAt) return { count: 0 };
          Object.assign(entry, data);
          return { count: 1 };
        },
      },
      webAuthnCredential: { deleteMany: async () => { deletedPasskeys++; } },
      refreshToken: { updateMany: async () => { revokedRefreshTokens++; } },
      accountSecurityEvent: { create: async ({ data }: any) => events.push(data) },
    };
    const db = {
      webAuthnCredential: { count: async () => 2 },
      passkeyRecoveryKey: tx.passkeyRecoveryKey,
      passkeyRecoveryChallenge: {
        ...tx.passkeyRecoveryChallenge,
        create: async ({ data }: any) => challenges.set(data.id, { ...data, usedAt: null }),
        findUnique: async ({ where }: any) => {
          const entry = challenges.get(where.id);
          return entry ? { ...entry, user: { ...user, passkeyRecoveryKey: recoveryKey } } : null;
        },
      },
      accountSecurityEvent: tx.accountSecurityEvent,
      refreshToken: tx.refreshToken,
      user: {
        findUnique: async ({ where }: any) =>
          where.email === user.email ? { id: user.id, passkeyRecoveryKey: recoveryKey } : null,
      },
      $transaction: async (callback: (client: any) => unknown) => callback(tx),
    };
    const anomalies = new SecurityAnomalyLog();
    const service = new PasskeyRecoveryService({
      db,
      sessions: {
        revokeAllUserSessions: async () => { revokedSessions++; return 2; },
        createSession: async () => ({ id: "new-session" }),
      } as any,
      refreshTokens: { issue: async () => ({ token: "new-token", refreshToken: "new-refresh" }) } as any,
      email: { getProvider: () => ({ sendEmail: async (message: any) => { emails.push(message); return { success: true }; } }) } as any,
      anomalyLog: anomalies,
    });

    await service.configure(user.id, encode(keyPair.publicKey));
    const begun = await service.begin(user.email);
    const signature = encode(ed25519.sign(Buffer.from(begun.challenge, "base64url"), keyPair.secretKey));
    const result = await service.complete({ ...begun, signature }, { ip: "203.0.113.9", userAgent: "test" });

    assert.equal(result.token, "new-token");
    assert.equal("passwordHash" in result.user, false);
    assert.equal("passkeyRecoveryKey" in result.user, false);
    assert.equal(deletedPasskeys, 1);
    assert.equal(revokedRefreshTokens, 1);
    assert.equal(revokedSessions, 1);
    assert.ok(recoveryKey.usedAt instanceof Date);
    assert.deepEqual(events.map((event) => event.type), ["PASSKEY_RECOVERY_CONFIGURED", "PASSKEY_RECOVERY_COMPLETED"]);
    assert.equal(emails.length, 1);
    assert.equal(anomalies.query({ type: SecurityAnomalyType.PASSKEY_RECOVERY_COMPLETED }).length, 1);
    await assert.rejects(
      () => service.complete({ ...begun, signature }, { ip: "203.0.113.9" }),
      /invalid or expired/
    );
  });

  it("returns an indistinguishable challenge shape for an unknown account", async () => {
    let persisted = 0;
    const service = new PasskeyRecoveryService({
      db: {
        user: { findUnique: async () => null },
        passkeyRecoveryChallenge: { create: async () => { persisted++; } },
      },
    });
    const result = await service.begin("unknown@example.test");
    assert.match(result.challengeId, /^[0-9a-f-]{36}$/);
    assert.ok(result.challenge.length >= 40);
    assert.equal(persisted, 0);
  });
});
