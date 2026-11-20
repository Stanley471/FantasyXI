import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthService,
  AuthValidationError,
  AuthForbiddenError,
  AuthNotFoundError,
  toSafeUser,
} from "../services/auth/authService.js";
import { managerAliasForUserId } from "../services/privacy/displayName.js";
import { UserRole } from "../types/index.js";

/**
 * Minimal in-memory mock of the Prisma user delegate, following the pattern
 * in authService.test.ts. Only findUnique / update are needed here.
 */
function createPrivacyDb() {
  const users: Array<{
    id: string;
    email: string;
    username: string;
    name: string | null;
    role: UserRole;
    isAnonymous: boolean;
    passwordHash: string | null;
    googleId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [
    {
      id: "user-alice",
      email: "alice@example.com",
      username: "alice",
      name: "Alice Example",
      role: UserRole.USER,
      isAnonymous: false,
      passwordHash: "x",
      googleId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    {
      id: "user-bob",
      email: "bob@example.com",
      username: "bob",
      name: "Bob Example",
      role: UserRole.USER,
      isAnonymous: false,
      passwordHash: "x",
      googleId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    {
      id: "user-admin",
      email: "admin@example.com",
      username: "admin",
      name: "Admin Example",
      role: UserRole.ADMIN,
      isAnonymous: false,
      passwordHash: "x",
      googleId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    {
      id: "user-mod",
      email: "mod@example.com",
      username: "mod",
      name: "Mod Example",
      role: UserRole.MODERATOR,
      isAnonymous: false,
      passwordHash: "x",
      googleId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ];

  return {
    users,
    user: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { isAnonymous: boolean } }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error("User not found");
        user.isAnonymous = data.isAnonymous;
        return { ...user };
      },
    },
  };
}

describe("toSafeUser privacy fields", () => {
  it("exposes isAnonymous and the deterministic alias", () => {
    const safe = toSafeUser({
      id: "user-alice",
      email: "alice@example.com",
      username: "alice",
      name: "Alice Example",
      role: UserRole.USER,
      isAnonymous: true,
      passwordHash: "x",
      googleId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
    assert.equal(safe.isAnonymous, true);
    assert.equal(safe.anonymousAlias, managerAliasForUserId("user-alice"));
    assert.match(safe.anonymousAlias, /^Manager #\d{4}$/);
  });

  it("defaults a missing flag to false", () => {
    const safe = toSafeUser({
      id: "user-alice",
      email: "alice@example.com",
      username: "alice",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
    assert.equal(safe.isAnonymous, false);
    assert.equal(safe.anonymousAlias, managerAliasForUserId("user-alice"));
  });
});

describe("AuthService.updatePrivacySettings", () => {
  it("lets the owner turn their own toggle on and off", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    const turnedOn = await service.updatePrivacySettings(
      { id: "user-alice", role: UserRole.USER },
      "user-alice",
      true
    );
    assert.equal(turnedOn.isAnonymous, true);
    assert.equal(turnedOn.anonymousAlias, managerAliasForUserId("user-alice"));
    assert.equal(db.users.find((u) => u.id === "user-alice")!.isAnonymous, true);

    const turnedOff = await service.updatePrivacySettings(
      { id: "user-alice", role: UserRole.USER },
      "user-alice",
      false
    );
    assert.equal(turnedOff.isAnonymous, false);
  });

  it("lets a platform admin flip another manager's toggle", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    const updated = await service.updatePrivacySettings(
      { id: "user-admin", role: UserRole.ADMIN },
      "user-alice",
      true
    );
    assert.equal(updated.id, "user-alice");
    assert.equal(updated.isAnonymous, true);
  });

  it("rejects another regular user flipping someone else's toggle", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    await assert.rejects(
      service.updatePrivacySettings({ id: "user-bob", role: UserRole.USER }, "user-alice", true),
      AuthForbiddenError
    );
    assert.equal(db.users.find((u) => u.id === "user-alice")!.isAnonymous, false);
  });

  it("rejects a moderator flipping someone else's toggle (moderators are not platform admins)", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    await assert.rejects(
      service.updatePrivacySettings({ id: "user-mod", role: UserRole.MODERATOR }, "user-alice", true),
      AuthForbiddenError
    );
  });

  it("rejects non-boolean values", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    for (const bad of ["true", 1, 0, null, undefined, {}]) {
      await assert.rejects(
        service.updatePrivacySettings({ id: "user-alice", role: UserRole.USER }, "user-alice", bad),
        AuthValidationError
      );
    }
    assert.equal(db.users.find((u) => u.id === "user-alice")!.isAnonymous, false);
  });

  it("returns 404 for an unknown target user", async () => {
    const db = createPrivacyDb();
    const service = new AuthService(db);
    await assert.rejects(
      service.updatePrivacySettings({ id: "user-admin", role: UserRole.ADMIN }, "user-ghost", true),
      AuthNotFoundError
    );
  });
});
