import assert from "node:assert/strict";
import test from "node:test";
import { createResolvers } from "../graphql/resolvers.js";

test("GraphQL league resolver requests nested members, users, and squads together", async () => {
  let query: Record<string, unknown> | undefined;
  const league = {
    id: "league-1",
    name: "Premier League",
    members: [{ id: "member-1", user: { id: "user-1" }, squad: { id: "squad-1" } }],
  };
  const database = {
    league: {
      findUnique: async (args: Record<string, unknown>) => {
        query = args;
        return league;
      },
    },
  };

  const result = await createResolvers(database as never).Query.league(null, { id: "league-1" });

  assert.deepEqual(result, league);
  assert.deepEqual(query, {
    where: { id: "league-1" },
    include: { creator: true, members: { include: { user: true, squad: true } } },
  });
});
