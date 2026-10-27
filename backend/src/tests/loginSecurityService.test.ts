import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LoginSecurityService, LoginAttempt, deriveDeviceId } from "../services/security/loginSecurityService.js";
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

describe("LoginSecurityService (#117, #331)", () => {
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

  describe("device fingerprinting and step-up challenges (#331)", () => {
    const FINGERPRINT_A = "a".repeat(64);
    const FINGERPRINT_B = "b".repeat(64);
    const attempt = (overrides: Partial<LoginAttempt> = {}): LoginAttempt => ({
      userId: "user-1",
      email: "user@example.com",
      username: "player1",
      ip: "203.0.113.10",
      userAgent: "TestAgent/1.0",
      deviceFingerprint: FINGERPRINT_A,
      ...overrides,
    });
    const codeFrom = (text: string) => text.match(/code is: (\d{6})/)![1];

    it("derives a stable device ID from fingerprint and user agent, ignoring malformed fingerprints", () => {
      assert.equal(deriveDeviceId(FINGERPRINT_A, "UA"), deriveDeviceId(FINGERPRINT_A, "UA"));
      assert.notEqual(deriveDeviceId(FINGERPRINT_A, "UA"), deriveDeviceId(FINGERPRINT_B, "UA"));
      assert.notEqual(deriveDeviceId(FINGERPRINT_A, "UA"), deriveDeviceId(FINGERPRINT_A, "Other UA"));
      assert.equal(deriveDeviceId("<script>", "UA"), deriveDeviceId(null, "UA"));
      assert.match(deriveDeviceId(FINGERPRINT_A, "UA"), /^[0-9a-f]{64}$/);
    });

    it("allows the very first login recorded for an account without a challenge", async () => {
      const { service, mailer, anomalyLog } = createService();
      assert.deepEqual(await service.assessLogin(attempt()), { decision: "ALLOW" });
      assert.equal(mailer.sent.length, 0);
      assert.deepEqual(anomalyLog.query(), []);
    });

    it("allows a returning device even from a new IP address", async () => {
      const { service } = createService();
      await service.assessLogin(attempt());
      const result = await service.assessLogin(attempt({ ip: "198.51.100.20" }));
      assert.equal(result.decision, "ALLOW");
    });

    it("challenges an unrecognized device, emails a one-time code and logs the anomaly", async () => {
      const { service, mailer, anomalyLog } = createService();
      await service.assessLogin(attempt());

      const result = await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B, ip: "198.51.100.20" }));
      assert.equal(result.decision, "CHALLENGE");
      assert.equal(mailer.sent.length, 1);
      assert.equal(mailer.sent[0].to, "user@example.com");
      assert.match(mailer.sent[0].text, /198\.51\.100\.20/);
      assert.match(mailer.sent[0].text, /code is: \d{6}/);

      const anomalies = anomalyLog.query({ type: SecurityAnomalyType.NEW_DEVICE_LOGIN });
      assert.equal(anomalies.length, 1);
      assert.equal(anomalies[0].userId, "user-1");
    });

    it("a verified challenge remembers the device, so the next login is not challenged", async () => {
      const { service, mailer } = createService();
      await service.assessLogin(attempt());
      const challenge = await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }));
      if (challenge.decision !== "CHALLENGE") return assert.fail("expected a challenge");

      const verified = await service.verifyChallenge(challenge.challengeId, codeFrom(mailer.sent[0].text));
      assert.deepEqual(verified, { verified: true, userId: "user-1" });
      assert.equal((await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }))).decision, "ALLOW");
    });

    it("codes are single-use and wrong codes burn the challenge after five attempts", async () => {
      const { service, mailer } = createService();
      await service.assessLogin(attempt());
      const first = await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }));
      if (first.decision !== "CHALLENGE") return assert.fail("expected a challenge");
      const code = codeFrom(mailer.sent[0].text);
      assert.equal((await service.verifyChallenge(first.challengeId, code)).verified, true);
      assert.equal((await service.verifyChallenge(first.challengeId, code)).verified, false, "replay is refused");

      const second = await service.assessLogin(attempt({ deviceFingerprint: "c".repeat(64) }));
      if (second.decision !== "CHALLENGE") return assert.fail("expected a challenge");
      const secondCode = codeFrom(mailer.sent[1].text);
      const wrong = secondCode === "000000" ? "111111" : "000000";
      for (let remaining = 4; remaining >= 1; remaining--) {
        assert.deepEqual(await service.verifyChallenge(second.challengeId, wrong), {
          verified: false,
          attemptsRemaining: remaining,
        });
      }
      assert.deepEqual(await service.verifyChallenge(second.challengeId, wrong), { verified: false, attemptsRemaining: 0 });
      assert.equal(
        (await service.verifyChallenge(second.challengeId, secondCode)).verified,
        false,
        "a burned challenge stays dead"
      );
    });

    it("a code used on one node cannot be replayed on another node sharing Redis", async () => {
      const redis = new MockRedisClient();
      const mailer = new NoOpMailer();
      const nodeA = new LoginSecurityService({ redis, mailer, anomalyLog: new SecurityAnomalyLog() });
      const nodeB = new LoginSecurityService({ redis, mailer, anomalyLog: new SecurityAnomalyLog() });
      await nodeA.assessLogin(attempt());
      const challenge = await nodeA.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }));
      if (challenge.decision !== "CHALLENGE") return assert.fail("expected a challenge");
      const code = codeFrom(mailer.sent[0].text);

      assert.equal((await nodeB.verifyChallenge(challenge.challengeId, code)).verified, true);
      assert.equal(
        (await nodeA.verifyChallenge(challenge.challengeId, code)).verified,
        false,
        "the issuing node must not fall back to its own stale copy"
      );
    });

    it("an expired challenge cannot be verified", async () => {
      let now = Date.now();
      const mailer = new NoOpMailer();
      const service = new LoginSecurityService({
        redis: new MockRedisClient(),
        mailer,
        anomalyLog: new SecurityAnomalyLog(),
        now: () => now,
      });
      await service.assessLogin(attempt());
      const challenge = await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }));
      if (challenge.decision !== "CHALLENGE") return assert.fail("expected a challenge");
      now += 10 * 60 * 1000;
      assert.equal((await service.verifyChallenge(challenge.challengeId, codeFrom(mailer.sent[0].text))).verified, false);
    });

    it("a successful login also resets the failed-login counter", async () => {
      const { service } = createService();
      await service.recordFailedLogin("user@example.com", "203.0.113.10");
      await service.recordFailedLogin("user@example.com", "203.0.113.10");
      await service.assessLogin(attempt());
      const result = await service.recordFailedLogin("user@example.com", "203.0.113.10");
      assert.equal(result.recentFailureCount, 1, "counter should have been reset by the successful login");
    });

    it("a mailer failure is caught and does not throw out of assessLogin", async () => {
      const service = new LoginSecurityService({
        redis: new MockRedisClient(),
        mailer: {
          async send() {
            throw new Error("SMTP unreachable");
          },
        },
        anomalyLog: new SecurityAnomalyLog(),
      });
      await service.assessLogin(attempt());
      const result = await service.assessLogin(attempt({ deviceFingerprint: FINGERPRINT_B }));
      assert.equal(result.decision, "CHALLENGE");
    });
  });

  describe("impossible-travel detection (#331)", () => {
    const LONDON = { latitude: 51.5074, longitude: -0.1278 };
    const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };
    const base: LoginAttempt = {
      userId: "user-9",
      email: "traveller@example.com",
      username: "traveller",
      ip: "203.0.113.10",
      userAgent: "TestAgent/1.0",
      deviceFingerprint: "a".repeat(64),
    };

    function travellingService() {
      const clock = { now: Date.now() };
      const mailer = new NoOpMailer();
      const anomalyLog = new SecurityAnomalyLog();
      const service = new LoginSecurityService({
        redis: new MockRedisClient(),
        mailer,
        anomalyLog,
        now: () => clock.now,
      });
      return { clock, mailer, anomalyLog, service };
    }

    it("blocks Sydney one hour after London, alerts the owner, and keeps London as the baseline", async () => {
      const { clock, mailer, anomalyLog, service } = travellingService();
      assert.equal((await service.assessLogin({ ...base, location: LONDON })).decision, "ALLOW");

      clock.now += 60 * 60 * 1000;
      const blocked = await service.assessLogin({ ...base, ip: "198.51.100.7", location: SYDNEY });
      assert.deepEqual(blocked, { decision: "BLOCK", reason: "IMPOSSIBLE_TRAVEL" });
      assert.equal(mailer.sent.length, 1);
      assert.match(mailer.sent[0].subject, /blocked a sign-in/i);
      const anomaly = anomalyLog.query({ type: SecurityAnomalyType.IMPOSSIBLE_TRAVEL })[0];
      assert.equal(anomaly.userId, "user-9");
      assert.ok((anomaly.detail!.distanceKm as number) > 16_000);

      // The blocked attempt must not become the new baseline: London again is fine
      clock.now += 60 * 1000;
      assert.equal((await service.assessLogin({ ...base, location: LONDON })).decision, "ALLOW");
    });

    it("allows the same journey after a realistic flight time", async () => {
      const { clock, service } = travellingService();
      await service.assessLogin({ ...base, location: LONDON });
      clock.now += 24 * 60 * 60 * 1000;
      assert.equal((await service.assessLogin({ ...base, location: SYDNEY })).decision, "ALLOW");
    });

    it("blocks impossible travel even from a recognized device, and skips the check without location data", async () => {
      const { clock, service } = travellingService();
      await service.assessLogin({ ...base, location: LONDON });
      clock.now += 60 * 1000;
      assert.equal((await service.assessLogin({ ...base, location: SYDNEY })).decision, "BLOCK");
      assert.equal((await service.assessLogin({ ...base, location: null })).decision, "ALLOW");
    });
  });
});
