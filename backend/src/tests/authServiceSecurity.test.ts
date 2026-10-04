import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { AuthService } from "../services/auth/authService.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import { NoOpMailer } from "../services/security/mailer.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";

/**
 * Exercises AuthService.login()'s issue #117 wiring: failed-login spike
 * tracking and new-device email alerting, driven through the public
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
    assert.equal(result.user.email, "victim@example.com");
  });

  it("sends a new-device alert email on a first login and again from a different device", async () => {
    const { service, mailer } = createHarness([{ email: "user@example.com", password: "correct-horse" }]);

    // First-ever login: nothing to compare against yet, so no alert.
    await service.login(
      { email: "user@example.com", password: "correct-horse" },
      { ip: "203.0.113.10", userAgent: "Chrome/1.0" }
    );
    assert.equal(mailer.sent.length, 0);

    // Same device again: still no alert.
    await service.login(
      { email: "user@example.com", password: "correct-horse" },
      { ip: "203.0.113.10", userAgent: "Chrome/1.0" }
    );
    assert.equal(mailer.sent.length, 0);

    // New IP and user agent: alert.
    await service.login(
      { email: "user@example.com", password: "correct-horse" },
      { ip: "198.51.100.77", userAgent: "SafariMobile/2.0" }
    );
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, "user@example.com");
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
