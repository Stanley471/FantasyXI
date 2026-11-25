import assert from "node:assert/strict";
import test from "node:test";
import { createResolvers, type GraphQLContext } from "../graphql/resolvers.js";
import { Role } from "../config/permissions.js";

const context = (id: string, role: Role = Role.USER) => ({ principal: { id, role }, loaders: { users: { load: async () => ({ id }) } } }) as unknown as GraphQLContext;
test("GraphQL root and nested resolvers deny cross-user access and anonymous private data", async () => {
  const resolvers = createResolvers({ user: { findMany: () => assert.fail("must not query other accounts") } } as never);
  assert.throws(() => resolvers.Query.users(null, {}, context("alice")), /Access denied/);
  assert.throws(() => resolvers.Query.user(null, { id: "bob" }, context("alice")), /Access denied/);
  const row = { id: "bob", wallet: { stellarAddress: "synthetic" }, squads: [], createdLeagues: [] };
  for (const field of ["wallet", "squads", "createdLeagues"] as const) {
    assert.throws(() => resolvers.User[field](row, {}, context("alice")), /Access denied/);
    assert.doesNotThrow(() => resolvers.User[field](row, {}, context("bob")));
    assert.doesNotThrow(() => resolvers.User[field](row, {}, context("staff", Role.ADMIN)));
  }
  assert.throws(() => resolvers.Squad.players({ userId: "bob", players: [] }, {}, context("alice")), /Access denied/);
});

test("private league direct lookup requires membership, creator or current staff authorization", async () => {
  const league = { isPrivate: true, creatorId: "creator", members: [{ userId: "member" }] };
  const resolvers = createResolvers({ league: { findUnique: async () => league } } as never);
  await assert.rejects(() => resolvers.Query.league(null, { id: "private" }, context("outsider")), /Access denied/);
  for (const userId of ["creator", "member"]) assert.equal(await resolvers.Query.league(null, { id: "private" }, context(userId)), league);
  assert.equal(await resolvers.Query.league(null, { id: "private" }, context("staff", Role.ADMIN)), league);
});
