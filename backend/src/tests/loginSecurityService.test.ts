import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import { NoOpMailer } from "../services/security/mailer.js";
import { SecurityAnomalyLog, SecurityAnomalyType } from "../services/security/securityAnomalyLog.js";
import { IRedisCacheClient } from "../config/redis.js";

/**
 * In-memory mock Redis client mirroring the one used for the FPL cache tests
 * (see fplRedisCache.test.ts), so the security service is exercised against
 * the same IRedisCacheClient contract it depends on in production.
 */
class MockRedisClient implements IRedisCacheClient {
  public store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: any, duration?: any): Promise<string> {
    const ttlSeconds = mode === "EX" && typeof duration === "number" ? duration : 600;
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (this.store.delete(key)) count++;
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }
}

function createService(overrides: { redis?: IRedisCacheClient | null } = {}) {
  const mailer = new NoOpMailer();
  const anomalyLog = new SecurityAnomalyLog();
  const service = new LoginSecurityService({
    redis: overrides.redis !== undefined ? overrides.redis : new MockRedisClient(),
    mailer,
    anomalyLog,
    failedLoginThreshold: 5,
    failedLoginWindowMs: 10 * 60 * 1000,
  });
  return { service, mailer, anomalyLog };
}

describe("LoginSecurityService (#117)", () => {
  describe("failed-login spike detection", () => {
    it("does not flag a spike below the threshold", async () => {
      const { service, anomalyLog } = createService();
      for (let i = 0; i < 4; i++) {
        const result = await service.recordFailedLogin("victim@example.com", "203.0.113.5");
        assert.equal(result.spikeDetected, false);
      }
      assert.deepEqual(anomalyLog.query(), []);
    });

    it("flags a spike once failed attempts reach the threshold within the window", async () => {
      const { service, anomalyLog } = createService();
      let lastResult;
      for (let i = 0; i < 5; i++) {
        lastResult = await service.recordFailedLogin("victim@example.com", "203.0.113.5");
      }

      assert.equal(lastResult!.spikeDetected, true);
      assert.equal(lastResult!.recentFailureCount, 5);

      const anomalies = anomalyLog.query({ type: SecurityAnomalyType.FAILED_LOGIN_SPIKE });
      assert.equal(anomalies.length, 1);
      assert.equal(anomalies[0].identifier, "victim@example.com");
      assert.equal(anomalies[0].ip, "203.0.113.5");
    });

    it("tracks distinct identifiers independently", async () => {
      const { service } = createService();
      for (let i = 0; i < 5; i++) {
        await service.recordFailedLogin("attacker-target@example.com", "203.0.113.5");
      }
      const other = await service.recordFailedLogin("someone-else@example.com", "203.0.113.5");
      assert.equal(other.spikeDetected, false);
      assert.equal(other.recentFailureCount, 1);
    });

    it("resetFailedLogins clears the counter after a successful login", async () => {
      const { service } = createService();
      for (let i = 0; i < 4; i++) {
        await service.recordFailedLogin("user@example.com", "203.0.113.5");
      }
      await service.resetFailedLogins("user@example.com");
      const result = await service.recordFailedLogin("user@example.com", "203.0.113.5");
      assert.equal(result.recentFailureCount, 1, "counter should restart from zero after a reset");
    });

    it("does not count attempts outside the sliding window", async () => {
      const { service } = createService();
      // A short window so we can observe expiry deterministically.
      const shortWindowService = new LoginSecurityService({
        redis: new MockRedisClient(),
        mailer: new NoOpMailer(),
        anomalyLog: new SecurityAnomalyLog(),
        failedLoginThreshold: 3,
        failedLoginWindowMs: 20,
      });
      await shortWindowService.recordFailedLogin("user@example.com", "203.0.113.5");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await shortWindowService.recordFailedLogin("user@example.com", "203.0.113.5");
      assert.equal(result.recentFailureCount, 1, "the earlier attempt should have fallen out of the window");
      void service;
    });

    it("gracefully falls back to in-memory tracking when Redis throws", async () => {
      const faultyRedis: IRedisCacheClient = {
        async get() {
          throw new Error("ECONNREFUSED");
        },
        async set() {
          throw new Error("ECONNREFUSED");
        },
        async del() {
          throw new Error("ECONNREFUSED");
        },
        async keys() {
          throw new Error("ECONNREFUSED");
        },
      };
      const { service } = createService({ redis: faultyRedis });

      const first = await service.recordFailedLogin("user@example.com", "203.0.113.5");
      const second = await service.recordFailedLogin("user@example.com", "203.0.113.5");

      assert.equal(first.recentFailureCount, 1);
      assert.equal(second.recentFailureCount, 2, "in-memory fallback should still accumulate across calls");
    });
  });

  describe("new-device / new-IP login alerting", () => {
    it("does not flag the very first login recorded for a user as new", async () => {
      const { service, mailer, anomalyLog } = createService();
      const result = await service.evaluateDeviceNovelty("user-1", "203.0.113.10", "TestAgent/1.0");
      assert.equal(result.isNewDevice, false);
      assert.equal(mailer.sent.length, 0);
      assert.deepEqual(anomalyLog.query(), []);
    });

    it("does not flag a login from a previously seen ip/user-agent pair", async () => {
      const { service } = createService();
      await service.evaluateDeviceNovelty("user-1", "203.0.113.10", "TestAgent/1.0");
      const result = await service.evaluateDeviceNovelty("user-1", "203.0.113.10", "TestAgent/1.0");
      assert.equal(result.isNewDevice, false);
    });

    it("flags a login from a new ip/user-agent pair for a known user", async () => {
      const { service } = createService();
      await service.evaluateDeviceNovelty("user-1", "203.0.113.10", "TestAgent/1.0");
      const result = await service.evaluateDeviceNovelty("user-1", "198.51.100.20", "OtherAgent/2.0");
      assert.equal(result.isNewDevice, true);
    });

    it("handleSuccessfulLogin sends an email alert and logs an anomaly on a new device", async () => {
      const { service, mailer, anomalyLog } = createService();
      await service.evaluateDeviceNovelty("user-1", "203.0.113.10", "TestAgent/1.0");

      await service.handleSuccessfulLogin({
        userId: "user-1",
        email: "user@example.com",
        username: "player1",
        ip: "198.51.100.20",
        userAgent: "OtherAgent/2.0",
      });

      assert.equal(mailer.sent.length, 1);
      assert.equal(mailer.sent[0].to, "user@example.com");
      assert.match(mailer.sent[0].subject, /new sign-in/i);
      assert.match(mailer.sent[0].text, /198\.51\.100\.20/);

      const anomalies = anomalyLog.query({ type: SecurityAnomalyType.NEW_DEVICE_LOGIN });
      assert.equal(anomalies.length, 1);
      assert.equal(anomalies[0].userId, "user-1");
    });

    it("handleSuccessfulLogin does not send an email for a returning device", async () => {
      const { service, mailer } = createService();
      await service.handleSuccessfulLogin({
        userId: "user-2",
        email: "user2@example.com",
        username: "player2",
        ip: "203.0.113.10",
        userAgent: "TestAgent/1.0",
      });
      await service.handleSuccessfulLogin({
        userId: "user-2",
        email: "user2@example.com",
        username: "player2",
        ip: "203.0.113.10",
        userAgent: "TestAgent/1.0",
      });

      assert.equal(mailer.sent.length, 0);
    });

    it("handleSuccessfulLogin also resets the failed-login counter", async () => {
      const { service } = createService();
      await service.recordFailedLogin("user3@example.com", "203.0.113.10");
      await service.recordFailedLogin("user3@example.com", "203.0.113.10");

      await service.handleSuccessfulLogin({
        userId: "user-3",
        email: "user3@example.com",
        username: "player3",
        ip: "203.0.113.10",
        userAgent: "TestAgent/1.0",
      });

      const result = await service.recordFailedLogin("user3@example.com", "203.0.113.10");
      assert.equal(result.recentFailureCount, 1, "counter should have been reset by the successful login");
    });

    it("a mailer failure is caught and does not throw out of handleSuccessfulLogin", async () => {
      const throwingMailer = {
        async send() {
          throw new Error("SMTP unreachable");
        },
      };
      const service = new LoginSecurityService({
        redis: new MockRedisClient(),
        mailer: throwingMailer,
        anomalyLog: new SecurityAnomalyLog(),
      });
      await service.evaluateDeviceNovelty("user-4", "203.0.113.10", "TestAgent/1.0");

      await assert.doesNotReject(() =>
        service.handleSuccessfulLogin({
          userId: "user-4",
          email: "user4@example.com",
          username: "player4",
          ip: "198.51.100.99",
          userAgent: "OtherAgent/9.0",
        })
      );
    });
  });
});
