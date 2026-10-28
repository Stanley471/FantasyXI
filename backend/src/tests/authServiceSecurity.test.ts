import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  AuthService,
  AuthLoginBlockedError,
  AuthUnauthorizedError,
  AuthValidationError,
} from "../services/auth/authService.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import { NoOpMailer } from "../services/security/mailer.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";

/**
 * Exercises AuthService.login()'s issue #117 wiring: failed-login spike
 * tracking, new-device step-up challenges and impossible-travel blocking
 * (#331), driven through the public
 * `login(input, context)` API rather than the LoginSecurityService directly.
 */

function createMockAuthDb(seedUsers: Array<{ email: string; password: string }> = []) {
  const users = seedUsers.map((u, i) => ({
    id: `usr_${i + 1}`,
    email: u.email,
    passwordHash: bcrypt.hashSync(u.password, 4),
    username: `user${i + 1}`,
    name: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  return {
    users,
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return users.find((u) => u.id === where.id) || null;
        if (where.email) return users.find((u) => u.email === where.email) || null;
        return null;
      },
    },
  };
}

function createHarness(seedUsers: Array<{ email: string; password: string }>) {
  const db = createMockAuthDb(seedUsers);
  const mailer = new NoOpMailer();
  const anomalyLog = new SecurityAnomalyLog();
  const security = new LoginSecurityService({
    redis: null, // exercise the in-memory fallback path directly
    mailer,
    anomalyLog,
    failedLoginThreshold: 3,
    failedLoginWindowMs: 60_000,
  });
  const events = new InMemoryEventBus();
  const service = new AuthService(db, events, security);
  return { db, mailer, anomalyLog, security, service };
}

describe("AuthService x LoginSecurityService integration (#117)", () => {
  it("does not perform security tracking when no request context is supplied", async () => {
    const { service, mailer } = createHarness([{ email: "user@example.com", password: "correct-horse" }]);

    await service.login({ email: "user@example.com", password: "correct-horse" });

    assert.equal(mailer.sent.length, 0, "no context means no device tracking, by design");
  });

  it("tracks failed login attempts by email and flags a spike after the threshold", async () => {
    const { service, anomalyLog } = createHarness([{ email: "victim@example.com", password: "correct-horse" }]);
    const context = { ip: "203.0.113.9", userAgent: "AttackerBot/1.0" };

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() =>
        service.login({ email: "victim@example.com", password: "wrong-password" }, context)
      );
    }

    const anomalies = anomalyLog.query({ type: SecurityAnomalyType.FAILED_LOGIN_SPIKE });
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].identifier, "victim@example.com");
  });

  it("does not fail login itself when a spike is detected (alerting only, per issue scope)", async () => {
    const { service } = createHarness([{ email: "victim@example.com", password: "correct-horse" }]);
    const context = { ip: "203.0.113.9", userAgent: "AttackerBot/1.0" };

    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => service.login({ email: "victim@example.com", password: "wrong" }, context));
    }

    // A subsequent correct login must still succeed - no automated freezing.
    const result = await service.login(
      { email: "victim@example.com", password: "correct-horse" },
      context
    );
    assert.ok("token" in result, "a known first device is not challenged");
    assert.equal(result.user.email, "victim@example.com");
  });

  it("challenges a login from a new device and issues the token only after the emailed code is verified (#331)", async () => {
    const { service, mailer } = createHarness([{ email: "user@example.com", password: "correct-horse" }]);
    const credentials = { email: "user@example.com", password: "correct-horse" };
    const laptop = { ...credentials, deviceFingerprint: "a".repeat(64) };
    const phone = { ...credentials, deviceFingerprint: "b".repeat(64) };

    // First-ever login: nothing to compare against yet, so no challenge.
    const first = await service.login(laptop, { ip: "203.0.113.10", userAgent: "Chrome/1.0" });
    assert.ok("token" in first);

    // Same device again (even from another IP): still no challenge.
    const again = await service.login(laptop, { ip: "198.51.100.1", userAgent: "Chrome/1.0" });
    assert.ok("token" in again);
    assert.equal(mailer.sent.length, 0);

    // New device: a challenge instead of a token, and a code by email.
    const challenged = await service.login(phone, { ip: "198.51.100.77", userAgent: "SafariMobile/2.0" });
    assert.ok("challengeRequired" in challenged);
    assert.equal(challenged.method, "EMAIL_OTP");
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "user@example.com");
    const code = mailer.sent[0].text.match(/code is: (\d{6})/)![1];

    await assert.rejects(
      () => service.verifyLoginChallenge({ challengeId: challenged.challengeId, code: code === "000000" ? "111111" : "000000" }),
      AuthUnauthorizedError
    );
    await assert.rejects(() => service.verifyLoginChallenge({ challengeId: challenged.challengeId, code: "12" }), AuthValidationError);

    const verified = await service.verifyLoginChallenge({ challengeId: challenged.challengeId, code });
    assert.equal(verified.user.email, "user@example.com");
    assert.ok(verified.token);

    // The verified device is now recognized.
    const trusted = await service.login(phone, { ip: "198.51.100.77", userAgent: "SafariMobile/2.0" });
    assert.ok("token" in trusted);
  });

  it("refuses a correct password from an impossible-travel location (#331)", async () => {
    const { service, anomalyLog } = createHarness([{ email: "user@example.com", password: "correct-horse" }]);
    const credentials = { email: "user@example.com", password: "correct-horse", deviceFingerprint: "a".repeat(64) };

    await service.login(credentials, {
      ip: "203.0.113.10",
      userAgent: "Chrome/1.0",
      location: { latitude: 51.5074, longitude: -0.1278 }, // London
    });
    await assert.rejects(
      () =>
        service.login(credentials, {
          ip: "198.51.100.7",
          userAgent: "Chrome/1.0",
          location: { latitude: -33.8688, longitude: 151.2093 }, // Sydney, moments later
        }),
      AuthLoginBlockedError
    );
    assert.equal(anomalyLog.query({ type: SecurityAnomalyType.IMPOSSIBLE_TRAVEL }).length, 1);
  });

  it("a successful login resets the failed-attempt counter for that email", async () => {
    const { service, security } = createHarness([{ email: "user@example.com", password: "correct-horse" }]);
    const context = { ip: "203.0.113.10", userAgent: "Chrome/1.0" };

    await assert.rejects(() => service.login({ email: "user@example.com", password: "wrong" }, context));
    await assert.rejects(() => service.login({ email: "user@example.com", password: "wrong" }, context));
    await service.login({ email: "user@example.com", password: "correct-horse" }, context);

    const result = await security.recordFailedLogin("user@example.com", context.ip);
    assert.equal(result.recentFailureCount, 1, "counter should have been reset by the successful login");
  });
});
