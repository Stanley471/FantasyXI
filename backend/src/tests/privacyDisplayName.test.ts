import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayUsername,
  managerAliasForUserId,
  canSeeRealName,
  isPlatformAdmin,
  normalizeViewer,
} from "../services/privacy/displayName.js";

const ALIAS_PATTERN = /^Manager #\d{4}$/;

describe("managerAliasForUserId", () => {
  it("returns a Manager #XXXX alias with exactly four digits", () => {
    const alias = managerAliasForUserId("user-alice");
    assert.match(alias, ALIAS_PATTERN);
    const digits = Number(alias.slice("Manager #".length));
    assert.ok(digits >= 1000 && digits <= 9999);
  });

  it("is deterministic: the same user id always maps to the same alias", () => {
    const first = managerAliasForUserId("user-alice");
    for (let i = 0; i < 5; i++) {
      assert.equal(managerAliasForUserId("user-alice"), first);
    }
  });

  it("is stable for an empty id and does not throw", () => {
    assert.match(managerAliasForUserId(""), ALIAS_PATTERN);
    assert.equal(managerAliasForUserId(""), managerAliasForUserId(""));
  });
});

describe("isPlatformAdmin / canSeeRealName", () => {
  it("treats only ADMIN as a platform admin", () => {
    assert.equal(isPlatformAdmin("ADMIN"), true);
    assert.equal(isPlatformAdmin("MODERATOR"), false);
    assert.equal(isPlatformAdmin("USER"), false);
    assert.equal(isPlatformAdmin(undefined), false);
    assert.equal(isPlatformAdmin(null), false);
  });

  it("lets the owner themselves see their real name", () => {
    assert.equal(canSeeRealName("u-1", { id: "u-1", role: "USER" }), true);
  });

  it("lets a platform admin see anyone's real name", () => {
    assert.equal(canSeeRealName("u-1", { id: "u-2", role: "ADMIN" }), true);
  });

  it("denies other regular users and moderators", () => {
    assert.equal(canSeeRealName("u-1", { id: "u-2", role: "USER" }), false);
    assert.equal(canSeeRealName("u-1", { id: "u-2", role: "MODERATOR" }), false);
  });

  it("denies signed-out viewers", () => {
    assert.equal(canSeeRealName("u-1", undefined), false);
    assert.equal(canSeeRealName("u-1", null), false);
  });
});

describe("displayUsername", () => {
  const anon = { id: "user-alice", username: "alice", isAnonymous: true };
  const pub = { id: "user-bob", username: "bob", isAnonymous: false };

  it("shows the alias for an anonymous manager to a signed-out viewer", () => {
    assert.match(displayUsername(anon), ALIAS_PATTERN);
    assert.match(displayUsername(anon, undefined), ALIAS_PATTERN);
  });

  it("shows the alias for an anonymous manager to another regular user", () => {
    assert.match(displayUsername(anon, { id: "user-bob", role: "USER" }), ALIAS_PATTERN);
  });

  it("shows the alias for an anonymous manager to a moderator", () => {
    assert.match(displayUsername(anon, { id: "user-mod", role: "MODERATOR" }), ALIAS_PATTERN);
  });

  it("shows the real username to the anonymous manager themselves", () => {
    assert.equal(displayUsername(anon, { id: "user-alice", role: "USER" }), "alice");
  });

  it("shows the real username to a platform admin", () => {
    assert.equal(displayUsername(anon, { id: "user-admin", role: "ADMIN" }), "alice");
  });

  it("shows the real username for a non-anonymous manager to everyone", () => {
    assert.equal(displayUsername(pub), "bob");
    assert.equal(displayUsername(pub, { id: "user-carol", role: "USER" }), "bob");
    assert.equal(displayUsername(pub, { id: "user-admin", role: "ADMIN" }), "bob");
  });

  it("treats a missing flag as not anonymous", () => {
    assert.equal(displayUsername({ id: "u-9", username: "carol" }), "carol");
    assert.equal(displayUsername({ id: "u-9", username: "carol", isAnonymous: null }), "carol");
  });

  it("shows the same alias as managerAliasForUserId (stable across serializers)", () => {
    assert.equal(displayUsername(anon), managerAliasForUserId("user-alice"));
  });
});

describe("normalizeViewer", () => {
  it("passes a viewer object through unchanged", () => {
    assert.deepEqual(normalizeViewer({ id: "u-1", role: "ADMIN" }), { id: "u-1", role: "ADMIN" });
  });

  it("wraps a bare user id so legacy callers still prove 'self'", () => {
    assert.deepEqual(normalizeViewer("u-1"), { id: "u-1" });
  });

  it("maps missing viewers to undefined", () => {
    assert.equal(normalizeViewer(undefined), undefined);
    assert.equal(normalizeViewer(null), undefined);
  });
});
