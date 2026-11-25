import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createResolvers } from "../graphql/resolvers.js";
import { managerAliasForUserId } from "../services/privacy/displayName.js";

const ALICE_ALIAS = managerAliasForUserId("user-alice");

describe("GraphQL User name masking (issue #511)", () => {
  const resolvers = createResolvers({} as never);
  const anonUser = { id: "user-alice", username: "alice", name: "Alice Example", isAnonymous: true };
  const publicUser = { id: "user-bob", username: "bob", name: "Bob Example", isAnonymous: false };

  it("aliases an anonymous username for signed-out viewers", () => {
    assert.equal(resolvers.User.username(anonUser, {}, undefined), ALICE_ALIAS);
    assert.equal(resolvers.User.username(anonUser, {}, { loaders: {} as never }), ALICE_ALIAS);
  });

  it("aliases an anonymous username for other users and moderators", () => {
    assert.equal(
      resolvers.User.username(anonUser, {}, { loaders: {} as never, viewer: { id: "user-bob", role: "USER" } }),
      ALICE_ALIAS
    );
    assert.equal(
      resolvers.User.username(anonUser, {}, { loaders: {} as never, viewer: { id: "user-mod", role: "MODERATOR" } }),
      ALICE_ALIAS
    );
  });

  it("shows the real username to the owner and to platform admins", () => {
    assert.equal(
      resolvers.User.username(anonUser, {}, { loaders: {} as never, viewer: { id: "user-alice", role: "USER" } }),
      "alice"
    );
    assert.equal(
      resolvers.User.username(anonUser, {}, { loaders: {} as never, viewer: { id: "user-admin", role: "ADMIN" } }),
      "alice"
    );
  });

  it("leaves a non-anonymous username untouched", () => {
    assert.equal(resolvers.User.username(publicUser, {}, undefined), "bob");
  });

  it("hides the real name from everyone but the owner and platform admins", () => {
    assert.equal(resolvers.User.name(anonUser, {}, undefined), null);
    assert.equal(
      resolvers.User.name(anonUser, {}, { loaders: {} as never, viewer: { id: "user-bob", role: "USER" } }),
      null
    );
    // Even a non-anonymous manager's real name is not public.
    assert.equal(
      resolvers.User.name(publicUser, {}, { loaders: {} as never, viewer: { id: "user-carol", role: "USER" } }),
      null
    );
    assert.equal(
      resolvers.User.name(anonUser, {}, { loaders: {} as never, viewer: { id: "user-alice", role: "USER" } }),
      "Alice Example"
    );
    assert.equal(
      resolvers.User.name(publicUser, {}, { loaders: {} as never, viewer: { id: "user-admin", role: "ADMIN" } }),
      "Bob Example"
    );
    assert.equal(resolvers.User.name({ id: "u-9", name: null }, {}, undefined), null);
  });
});
