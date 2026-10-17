import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import supertest from "supertest";
import express from "express";

import { AuthService, AuthValidationError } from "../services/auth/authService.js";
import { passwordResetRateLimiter } from "../middleware/rateLimiter.js";
import { InMemoryEventBus } from "../services/events/eventBus.js";
import { LoginSecurityService } from "../services/security/loginSecurityService.js";
import { NoOpMailer } from "../services/security/mailer.js";
import { SecurityAnomalyLog } from "../services/security/securityAnomalyLog.js";

function createPasswordResetHarness(seedUsers: Array<{ email: string; password: string }> = []) {
  const users = seedUsers.map((user, index) => ({
    id: `user_${index + 1}`,
    email: user.email,
    passwordHash: bcrypt.hashSync(user.password, 4),
    username: `user_${index + 1}`,
    name: null,
    role: "USER",
    googleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const tokens: Array<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    usedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  const db = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return users.find((user) => user.email === where.email) ?? null;
        }
        if (where.id) {
          return users.find((user) => user.id === where.id) ?? null;
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = users.find((entry) => entry.id === where.id);
        if (!user) throw new Error("User not found");
        Object.assign(user, data);
        return user;
      },
    },
    passwordResetToken: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = {
          id: `reset_${tokens.length + 1}`,
          userId: String(data.userId),
          tokenHash: String(data.tokenHash),
          expiresAt: data.expiresAt as Date,
          usedAt: data.usedAt as Date | null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tokens.push(record);
        return record;
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const exact = tokens.find((token) => {
          if (where.tokenHash && token.tokenHash !== String(where.tokenHash)) return false;
          return true;
        });
        return exact ?? null;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const exact = tokens.find((token) => {
          if (where.tokenHash && token.tokenHash !== String(where.tokenHash)) return false;
          if (where.userId && token.userId !== String(where.userId)) return false;
          if (where.usedAt === null && token.usedAt !== null) return false;
          if (where.expiresAt && token.expiresAt.getTime() <= (where.expiresAt as { gt?: Date }).gt?.getTime()) {
            return false;
          }
          return true;
        });
        return exact ?? null;
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const token = tokens.find((entry) => {
          if (where.id && entry.id !== String(where.id)) return false;
          if (where.tokenHash && entry.tokenHash !== String(where.tokenHash)) return false;
          return true;
        });
        if (!token) throw new Error("Password reset token not found");
        Object.assign(token, data);
        return token;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = tokens.length;
        for (const token of [...tokens]) {
          if (where.userId && token.userId !== String(where.userId)) continue;
          if (where.id && typeof where.id === "object" && "not" in where.id && token.id === String((where.id as { not: string }).not)) {
            continue;
          }
          const index = tokens.indexOf(token);
          if (index >= 0) tokens.splice(index, 1);
        }
        return { count: before - tokens.length };
      },
    },
  } as any;

  const service = new AuthService(
    db,
    new InMemoryEventBus(),
    new LoginSecurityService({
      redis: null,
      mailer: new NoOpMailer(),
      anomalyLog: new SecurityAnomalyLog(),
      failedLoginThreshold: 3,
      failedLoginWindowMs: 60_000,
    })
  );

  return { service, db, tokens };
}

describe("password reset security", () => {
  it("expires tokens after 15 minutes and rejects expired / invalid tokens", async () => {
    const { service, tokens } = createPasswordResetHarness([
      { email: "user@example.com", password: "correct-horse" },
    ]);

    const result = await service.requestPasswordReset("user@example.com");
    assert.ok(result.token.length > 0);

    const tokenRecord = tokens[0];
    tokenRecord.expiresAt = new Date(Date.now() - 1000);

    await assert.rejects(
      () => service.resetPassword(result.token, "new-password-123"),
      (error: unknown) => {
        assert.ok(error instanceof AuthValidationError);
        assert.equal(error.message, "Token already redeemed or invalid");
        return true;
      }
    );
  });

  it("invalidates a token immediately after a successful password reset", async () => {
    const { service, tokens } = createPasswordResetHarness([
      { email: "user@example.com", password: "correct-horse" },
    ]);

    const result = await service.requestPasswordReset("user@example.com");
    await service.resetPassword(result.token, "new-password-123");

    assert.equal(tokens[0].usedAt instanceof Date, true);

    await assert.rejects(
      () => service.resetPassword(result.token, "new-password-456"),
      (error: unknown) => {
        assert.ok(error instanceof AuthValidationError);
        assert.equal(error.message, "Token already redeemed or invalid");
        return true;
      }
    );
  });

  it("rate limits password reset requests per IP and email", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/v1/auth/password/reset/request", (req, res, next) => {
      passwordResetRateLimiter(req, res, next);
    }, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const agent = supertest.agent(app);
    const headers = { "X-Forwarded-For": "203.0.113.42" };

    for (let i = 0; i < 3; i++) {
      const response = await agent
        .post("/api/v1/auth/password/reset/request")
        .set(headers)
        .send({ email: "user@example.com" });
      assert.equal(response.status, 200, `request ${i + 1} should be allowed`);
    }

    const blocked = await agent
      .post("/api/v1/auth/password/reset/request")
      .set(headers)
      .send({ email: "user@example.com" });

    assert.equal(blocked.status, 429, "4th request should be blocked by the reset limiter");
    assert.equal(blocked.body.message, "Too many password reset requests. Please wait before trying again.");
  });
});
