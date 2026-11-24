import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  AuthService,
  AuthValidationError,
  AuthConflictError,
  AuthUnauthorizedError,
} from "../services/auth/authService.js";
import { verifyAccessToken } from "../config/jwt.js";

/**
 * Creates an in-memory mock database client for AuthService testing.
 * Allows pure unit testing without external database dependencies.
 */
function createMockAuthDb() {
  const users: Array<{
    id: string;
    email: string;
    passwordHash: string;
    username: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  return {
    users,
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string; username?: string };
      }) => {
        if (where.id) {
          return users.find((u) => u.id === where.id) || null;
        }
        if (where.email) {
          return users.find((u) => u.email === where.email) || null;
        }
        if (where.username) {
          return users.find((u) => u.username === where.username) || null;
        }
        return null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { passwordHash?: string };
      }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) {
          throw new Error("User not found");
        }
        if (data.passwordHash !== undefined) {
          user.passwordHash = data.passwordHash;
        }
        user.updatedAt = new Date();
        return user;
      },
      create: async ({
        data,
      }: {
        data: {
          email: string;
          passwordHash: string;
          username: string;
          name: string | null;
        };
      }) => {
        const record = {
          id: `usr_${users.length + 1}`,
          email: data.email,
          passwordHash: data.passwordHash,
          username: data.username,
          name: data.name,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.push(record);
        return record;
      },
    },
  };
}

describe("AuthService Registration & Login Domain Rules", () => {
  it("should register a user with bcrypt hashed password and return safe user with token", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    const result = await service.register({
      email: "stanley@example.com",
      password: "Password123!",
      name: "Stanley",
    });

    // 1. Safe user returned
    assert.equal(result.user.email, "stanley@example.com");
    assert.equal(result.user.name, "Stanley");
    assert.ok(result.user.id);
    assert.ok(result.user.username);

    // 2. Password hash must NEVER be present in the returned user object
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(result.user.passwordHash, undefined);

    // 3. Password was hashed in the database
    const saved = mockDb.users[0];
    assert.notEqual(saved.passwordHash, "Password123!");
    const isMatch = await bcrypt.compare("Password123!", saved.passwordHash);
    assert.equal(isMatch, true);

    // 4. Token is valid JWT
    assert.ok(result.token);
    const decoded = verifyAccessToken(result.token);
    assert.equal(decoded.userId, result.user.id);
    assert.equal(decoded.email, "stanley@example.com");
  });

  it("should normalize email to lowercase during registration and login", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "  Stanley.Test@EXAMPLE.COM  ",
      password: "Password123!",
    });

    const saved = mockDb.users[0];
    assert.equal(saved.email, "stanley.test@example.com");

    // Login with mixed case should also succeed
    const loginResult = await service.login({
      email: "STANLEY.TEST@example.com",
      password: "Password123!",
    });

    assert.equal(loginResult.user.email, "stanley.test@example.com");
  });

  it("should reject registration with invalid email format", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.register({
          email: "not-an-email",
          password: "Password123!",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /invalid email/i);
        return true;
      }
    );
  });

  it("should reject registration with password shorter than 8 characters", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.register({
          email: "valid@example.com",
          password: "short",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /at least 8 characters/i);
        return true;
      }
    );
  });

  it("should reject duplicate email registration with AuthConflictError", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "Password123!",
    });

    await assert.rejects(
      async () => {
        await service.register({
          email: "USER@example.com",
          password: "AnotherPassword123!",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthConflictError);
        assert.match(err.message, /already exists/i);
        return true;
      }
    );
  });

  it("should authenticate valid user on login and return safe user + token", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "Correct_Password1!",
      name: "Player 1",
    });

    const loginResult = await service.login({
      email: "user@example.com",
      password: "Correct_Password1!",
    });

    assert.equal(loginResult.user.email, "user@example.com");
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(loginResult.user.passwordHash, undefined);
    assert.ok(loginResult.token);

    const decoded = verifyAccessToken(loginResult.token);
    assert.equal(decoded.userId, loginResult.user.id);
  });

  it("should reject login with wrong password using generic error", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await service.register({
      email: "user@example.com",
      password: "Correct_Password1!",
    });

    await assert.rejects(
      async () => {
        await service.login({
          email: "user@example.com",
          password: "wrong_password",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        // Generic error prevents credential enumeration
        assert.equal(err.message, "Invalid email or password");
        return true;
      }
    );
  });

  it("should reject login for nonexistent account with identical generic error", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    await assert.rejects(
      async () => {
        await service.login({
          email: "nonexistent@example.com",
          password: "Password123!",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthUnauthorizedError);
        assert.equal(err.message, "Invalid email or password");
        return true;
      }
    );
  });

  it("should retrieve safe user via getMe", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    const { user } = await service.register({
      email: "user@example.com",
      password: "Password123!",
      name: "Stanley S",
    });

    const me = await service.getMe(user.id);
    assert.equal(me.id, user.id);
    assert.equal(me.email, "user@example.com");
    assert.equal(me.name, "Stanley S");
    // @ts-expect-error - testing absence of passwordHash
    assert.equal(me.passwordHash, undefined);
  });
});

describe("AuthService Password Complexity Validation", () => {
  it("should accept compliant passwords with uppercase, digit, special character, and >= 8 chars", () => {
    const service = new AuthService(createMockAuthDb());
    const compliantPasswords = [
      "Password1!",
      "Str0ng@Pass",
      "A1!aaaaa",
      "My-Super-Secret-99",
      "Complex_Pass#2026",
    ];

    for (const password of compliantPasswords) {
      assert.doesNotThrow(() => service.validatePassword(password));
    }
  });

  it("should reject missing or empty passwords", () => {
    const service = new AuthService(createMockAuthDb());

    for (const invalid of ["", undefined, null, 12345678]) {
      assert.throws(
        () => service.validatePassword(invalid),
        (err: unknown) => {
          assert.ok(err instanceof AuthValidationError);
          assert.match(err.message, /password is required/i);
          return true;
        }
      );
    }
  });

  it("should reject password missing an uppercase letter and report the specific rule", () => {
    const service = new AuthService(createMockAuthDb());

    assert.throws(
      () => service.validatePassword("lowercase1!"),
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /uppercase letter/i);
        assert.doesNotMatch(err.message, /digit/i);
        assert.doesNotMatch(err.message, /special character/i);
        assert.doesNotMatch(err.message, /at least 8 characters/i);
        return true;
      }
    );
  });

  it("should reject password missing a digit and report the specific rule", () => {
    const service = new AuthService(createMockAuthDb());

    assert.throws(
      () => service.validatePassword("NoDigitsHere!"),
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /digit/i);
        assert.doesNotMatch(err.message, /uppercase letter/i);
        assert.doesNotMatch(err.message, /special character/i);
        return true;
      }
    );
  });

  it("should reject password missing a special character (including whitespace-only non-alphanumerics)", () => {
    const service = new AuthService(createMockAuthDb());

    for (const password of ["NoSpecial123", "HasSpace123 "]) {
      assert.throws(
        () => service.validatePassword(password),
        (err: unknown) => {
          assert.ok(err instanceof AuthValidationError);
          assert.match(err.message, /special character/i);
          assert.doesNotMatch(err.message, /uppercase letter/i);
          assert.doesNotMatch(err.message, /digit/i);
          return true;
        }
      );
    }
  });

  it("should enumerate all failed complexity rules when multiple criteria are missing", () => {
    const service = new AuthService(createMockAuthDb());

    assert.throws(
      () => service.validatePassword("weak"),
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /at least 8 characters/i);
        assert.match(err.message, /uppercase letter/i);
        assert.match(err.message, /digit/i);
        assert.match(err.message, /special character/i);
        return true;
      }
    );
  });

  it("should enforce complexity rules consistently on setPassword", async () => {
    const mockDb = createMockAuthDb();
    const service = new AuthService(mockDb);

    const { user } = await service.register({
      email: "reset@example.com",
      password: "OldPassword1!",
    });

    await assert.rejects(
      async () => {
        await service.setPassword(user.id, {
          currentPassword: "OldPassword1!",
          password: "weakpassword",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthValidationError);
        assert.match(err.message, /uppercase letter/i);
        assert.match(err.message, /digit/i);
        assert.match(err.message, /special character/i);
        return true;
      }
    );

    const updated = await service.setPassword(user.id, {
      currentPassword: "OldPassword1!",
      password: "NewPassword2@",
    });
    assert.equal(updated.id, user.id);
    const isMatch = await bcrypt.compare("NewPassword2@", mockDb.users[0].passwordHash);
    assert.equal(isMatch, true);
  });

  it("should return HTTP 400 with enumerated rules from register controller on weak password", async () => {
    const { register } = await import("../controllers/auth.controller.js");
    let statusCode = 0;
    let body: { success?: boolean; message?: string } = {};

    const req = {
      body: {
        email: "weak@example.com",
        password: "weakpassword",
      },
    } as Parameters<typeof register>[0];

    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: { success?: boolean; message?: string }) {
        body = payload;
        return this;
      },
    } as unknown as Parameters<typeof register>[1];

    await register(req, res, () => {});

    assert.equal(statusCode, 400);
    assert.equal(body.success, false);
    assert.match(body.message ?? "", /uppercase letter/i);
    assert.match(body.message ?? "", /digit/i);
    assert.match(body.message ?? "", /special character/i);
  });
});
