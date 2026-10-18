import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { ApolloServer } from "@apollo/server";
import { buildSchema, parse } from "graphql";
import { typeDefs } from "../graphql/schema.js";
import {
  analyzeOperation,
  getQueryComplexityConfig,
} from "../graphql/complexity/queryComplexity.js";
import {
  ComplexityRateGovernor,
  MemoryTokenBucketStore,
  RedisTokenBucketStore,
} from "../graphql/complexity/complexityRateGovernor.js";
import {
  COMPLEXITY_ERROR_CODES,
  createQueryComplexityPlugin,
  evaluateOperation,
  resolveGraphqlClientKey,
  SubscriptionComplexityGuard,
} from "../graphql/complexity/complexityGuard.js";

const schema = buildSchema(typeDefs);
const config = getQueryComplexityConfig({
  maxDepth: 8,
  maxComplexity: 3000,
  defaultListSize: 10,
  maxListSize: 100,
});

function analyze(query: string, variables?: Record<string, unknown>, overrides = {}) {
  return analyzeOperation({
    schema,
    document: parse(query),
    variables,
    config: { ...config, ...overrides },
  });
}

// ---------------------------------------------------------------------------
// Depth analysis
// ---------------------------------------------------------------------------

test("depth: counts nested selection levels", () => {
  const result = analyze(`{ player(id: "1") { displayName team { name } } }`);
  assert.equal(result.depth, 3);
  assert.deepEqual(result.violations, []);
});

test("depth: rejects a recursive user -> league -> creator cycle beyond maxDepth", () => {
  const result = analyze(`{
    user(id: "1") { createdLeagues { creator { createdLeagues { creator {
      createdLeagues { creator { createdLeagues { creator { username } } } }
    } } } } }
  }`);
  assert.equal(result.depth, 10);
  assert.ok(result.violations.some((v) => v.code === "QUERY_TOO_DEEP"));
});

test("depth: recursion hidden inside nested fragments is still measured", () => {
  const result = analyze(`
    query { user(id: "1") { ...A } }
    fragment A on User { createdLeagues { creator { ...B } } }
    fragment B on User { createdLeagues { creator { ...C } } }
    fragment C on User { createdLeagues { creator { ...D } } }
    fragment D on User { createdLeagues { creator { username } } }
  `);
  assert.equal(result.depth, 10);
  assert.ok(result.violations.some((v) => v.code === "QUERY_TOO_DEEP"));
});

test("depth: cyclic fragment spreads terminate instead of looping forever", () => {
  // Validation rejects fragment cycles, but subscriptions can be analysed
  // before validation; the walker must still terminate.
  const result = analyze(`
    query { user(id: "1") { ...Loop } }
    fragment Loop on User { createdLeagues { creator { ...Loop } } }
  `);
  assert.equal(result.depth, 3);
});

test("depth: introspection fields are ignored by default", () => {
  const result = analyze(`{ __schema { types { name fields { name type { name ofType { name ofType { name ofType { name } } } } } } } }`);
  assert.equal(result.depth, 0);
  assert.equal(result.complexity, 0);
});

// ---------------------------------------------------------------------------
// Complexity analysis
// ---------------------------------------------------------------------------

test("complexity: pagination argument multiplies child cost", () => {
  // players(limit: 100): 1 + 100 * (team object = 1) = 101
  assert.equal(analyze(`{ players(limit: 100) { displayName team { name } } }`).complexity, 101);
  // players(limit: 5): 1 + 5 * 1 = 6
  assert.equal(analyze(`{ players(limit: 5) { displayName team { name } } }`).complexity, 6);
});

test("complexity: pagination argument supplied through a variable", () => {
  const query = `query($n: Int) { players(limit: $n) { team { name } } }`;
  assert.equal(analyze(query, { n: 20 }).complexity, 21);
});

test("complexity: operation variable default is used when no value is supplied", () => {
  const query = `query($n: Int = 30) { players(limit: $n) { team { name } } }`;
  assert.equal(analyze(query).complexity, 31);
});

test("complexity: schema argument default applies when the argument is omitted", () => {
  // Query.players(limit: Int = 100)
  assert.equal(analyze(`{ players { team { name } } }`).complexity, 101);
});

test("complexity: pagination is clamped to maxListSize", () => {
  assert.equal(analyze(`{ players(limit: 1000000) { team { name } } }`).complexity, 101);
});

test("complexity: unbounded nested lists fall back to defaultListSize", () => {
  // league: 1 + members(list, default 10) * (1 + user 1 + squad 1)
  const result = analyze(`{ league(id: "1") { members { user { username } squad { name } } } }`);
  assert.equal(result.complexity, 1 + (1 + 10 * 2));
});

test("complexity: nested list multipliers compound and are rejected", () => {
  const result = analyze(`{
    users(limit: 100) { squads { players { player { team { name } } } } }
  }`);
  // 1 + 100 * (1 + 10 * (1 + 10 * (1 + 1)))
  assert.equal(result.complexity, 1 + 100 * (1 + 10 * (1 + 10 * 2)));
  assert.ok(result.violations.some((v) => v.code === "QUERY_TOO_COMPLEX"));
});

test("complexity: aliased duplicate selections are each charged", () => {
  const single = analyze(`{ a: players(limit: 100) { team { name } } }`).complexity;
  const batched = analyze(`{
    a: players(limit: 100) { team { name } }
    b: players(limit: 100) { team { name } }
    c: players(limit: 100) { team { name } }
  }`).complexity;
  assert.equal(batched, single * 3);
});

test("complexity: @skip / @include remove selections from the cost", () => {
  const query = `query($skip: Boolean!) {
    players(limit: 100) @skip(if: $skip) { team { name } }
    league(id: "1") @include(if: false) { name }
  }`;
  assert.equal(analyze(query, { skip: true }).complexity, 0);
  assert.equal(analyze(query, { skip: false }).complexity, 101);
});

test("complexity: per-field weight overrides are applied", () => {
  const result = analyze(`{ players(limit: 10) { team { name } } }`, undefined, {
    fieldWeights: { "Query.players": 50, "Player.team": 3 },
  });
  assert.equal(result.complexity, 50 + 10 * 3);
});

// ---------------------------------------------------------------------------
// Token bucket governor
// ---------------------------------------------------------------------------

test("governor: spends complexity tokens and refills over time", async () => {
  let now = 0;
  const governor = new ComplexityRateGovernor({
    capacity: 100,
    refillPerSecond: 10,
    store: new MemoryTokenBucketStore(),
    now: () => now,
  });

  assert.equal((await governor.consume("ip:1", 60)).allowed, true);
  const denied = await governor.consume("ip:1", 60);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 2000); // need 20 more tokens at 10/s

  now += 2000;
  assert.equal((await governor.consume("ip:1", 60)).allowed, true);
});

test("governor: buckets are isolated per client", async () => {
  const governor = new ComplexityRateGovernor({ capacity: 50, refillPerSecond: 1, now: () => 0 });
  assert.equal((await governor.consume("user:a", 50)).allowed, true);
  assert.equal((await governor.consume("user:a", 1)).allowed, false);
  assert.equal((await governor.consume("user:b", 50)).allowed, true);
});

test("governor: a cost above capacity can never be satisfied", async () => {
  const governor = new ComplexityRateGovernor({ capacity: 10, refillPerSecond: 1 });
  const decision = await governor.consume("ip:1", 11);
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryAfterMs, Number.POSITIVE_INFINITY);
});

test("governor: Redis store passes bucket parameters to one atomic script", async () => {
  const calls: unknown[][] = [];
  const store = new RedisTokenBucketStore({
    eval: async (...args) => {
      calls.push(args);
      return [1, "40"];
    },
  });
  const result = await store.take("user:a", 60, 100, 10, 5000);
  assert.deepEqual(result, { allowed: true, tokens: 40 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 1);
  assert.equal(calls[0][2], "graphql:complexity:user:a");
  assert.deepEqual(calls[0].slice(3), [60, 100, 10, 5000, 10000]);
});

test("governor: Redis failure falls back to in-process buckets instead of failing open", async () => {
  const store = new RedisTokenBucketStore({
    eval: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const governor = new ComplexityRateGovernor({ capacity: 10, refillPerSecond: 1, store, now: () => 0 });
  assert.equal((await governor.consume("ip:1", 10)).allowed, true);
  assert.equal((await governor.consume("ip:1", 1)).allowed, false);
});

// ---------------------------------------------------------------------------
// HTTP enforcement through Apollo Server
// ---------------------------------------------------------------------------

async function createServer(governor?: ComplexityRateGovernor) {
  let resolverCalls = 0;
  const server = new ApolloServer<{ clientKey: string }>({
    typeDefs,
    resolvers: {
      Query: {
        players: () => {
          resolverCalls++;
          return [];
        },
        user: () => {
          resolverCalls++;
          return null;
        },
        users: () => {
          resolverCalls++;
          return [];
        },
      },
    },
    plugins: [createQueryComplexityPlugin({ config, governor })],
  });
  await server.start();
  return { server, calls: () => resolverCalls };
}

function singleResult(response: Awaited<ReturnType<ApolloServer["executeOperation"]>>) {
  assert.equal(response.body.kind, "single");
  return (response.body as { kind: "single"; singleResult: any }).singleResult;
}

test("http: over-deep query is rejected with 400 before any resolver runs", async () => {
  const { server, calls } = await createServer();
  try {
    const response = await server.executeOperation(
      {
        query: `{ user(id: "1") { createdLeagues { creator { createdLeagues { creator {
          createdLeagues { creator { createdLeagues { creator { username } } } } } } } } } }`,
      },
      { contextValue: { clientKey: "ip:test" } }
    );
    assert.equal(response.http.status, 400);
    assert.equal(singleResult(response).errors[0].extensions.code, COMPLEXITY_ERROR_CODES.TOO_DEEP);
    assert.equal(calls(), 0);
  } finally {
    await server.stop();
  }
});

test("http: over-complex query is rejected with 400 before any resolver runs", async () => {
  const { server, calls } = await createServer();
  try {
    const response = await server.executeOperation(
      { query: `{ users(limit: 100) { squads { players { player { team { name } } } } } }` },
      { contextValue: { clientKey: "ip:test" } }
    );
    assert.equal(response.http.status, 400);
    const error = singleResult(response).errors[0];
    assert.equal(error.extensions.code, COMPLEXITY_ERROR_CODES.TOO_COMPLEX);
    assert.equal(error.extensions.maxComplexity, 3000);
    assert.equal(calls(), 0);
  } finally {
    await server.stop();
  }
});

test("http: valid query executes and reports its complexity", async () => {
  const { server, calls } = await createServer();
  try {
    const response = await server.executeOperation(
      { query: `{ players(limit: 10) { displayName team { name } } }` },
      { contextValue: { clientKey: "ip:test" } }
    );
    assert.equal(singleResult(response).errors, undefined);
    assert.equal(response.http.headers.get("x-graphql-complexity"), "11");
    assert.equal(calls(), 1);
  } finally {
    await server.stop();
  }
});

test("http: exhausted complexity budget returns 429 with Retry-After", async () => {
  const governor = new ComplexityRateGovernor({ capacity: 150, refillPerSecond: 10, now: () => 0 });
  const { server, calls } = await createServer(governor);
  try {
    const request = { query: `{ players(limit: 100) { team { name } } }` }; // cost 101
    const first = await server.executeOperation(request, { contextValue: { clientKey: "user:a" } });
    assert.equal(singleResult(first).errors, undefined);

    const second = await server.executeOperation(request, { contextValue: { clientKey: "user:a" } });
    assert.equal(second.http.status, 429);
    assert.equal(singleResult(second).errors[0].extensions.code, COMPLEXITY_ERROR_CODES.RATE_LIMITED);
    assert.equal(second.http.headers.get("retry-after"), "6"); // 52 tokens short at 10/s
    assert.equal(calls(), 1);

    // A different client still has its own budget
    const other = await server.executeOperation(request, { contextValue: { clientKey: "user:b" } });
    assert.equal(singleResult(other).errors, undefined);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Subscriptions (WebSocket transport admission)
// ---------------------------------------------------------------------------

const subscriptionSchema = buildSchema(`
  type Player { id: ID! name: String! team: Team! }
  type Team { id: ID! name: String! players(first: Int): [Player!]! }
  type Query { ping: String }
  type Subscription {
    playerUpdated(id: ID!): Player!
    teamUpdates(first: Int): [Team!]!
  }
`);

test("subscriptions: over-deep subscription is rejected", async () => {
  const guard = new SubscriptionComplexityGuard({ config });
  const error = await guard.onSubscribe({
    clientKey: "user:a",
    subscriptionId: "1",
    schema: subscriptionSchema,
    document: parse(`subscription { playerUpdated(id: "1") { team { players { team { players {
      team { players { team { players { name } } } } } } } } } }`),
  });
  assert.equal(error?.extensions.code, COMPLEXITY_ERROR_CODES.TOO_DEEP);
  assert.equal(guard.activeComplexity("user:a"), 0);
});

test("subscriptions: active complexity quota rejects new subscriptions until others complete", async () => {
  const guard = new SubscriptionComplexityGuard({ config, maxActiveComplexity: 250 });
  const document = parse(`subscription { teamUpdates(first: 100) { name } }`); // 1 + 100 * 0 = 1
  const heavy = parse(`subscription { teamUpdates(first: 100) { players(first: 1) { name } } }`); // 1 + 100 * 1 = 101

  assert.equal(await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "s1", schema: subscriptionSchema, document: heavy }), null);
  assert.equal(await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "s2", schema: subscriptionSchema, document: heavy }), null);
  assert.equal(guard.activeComplexity("user:a"), 202);

  const rejected = await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "s3", schema: subscriptionSchema, document: heavy });
  assert.equal(rejected?.extensions.code, COMPLEXITY_ERROR_CODES.SUBSCRIPTION_QUOTA);

  // Cheap subscriptions still fit, and other clients are unaffected
  assert.equal(await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "s4", schema: subscriptionSchema, document }), null);
  assert.equal(await guard.onSubscribe({ clientKey: "user:b", subscriptionId: "s1", schema: subscriptionSchema, document: heavy }), null);

  guard.onComplete("user:a", "s1");
  assert.equal(await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "s3", schema: subscriptionSchema, document: heavy }), null);

  guard.onDisconnect("user:a");
  assert.equal(guard.activeComplexity("user:a"), 0);
});

test("subscriptions: complexity spending is shared with the HTTP token bucket", async () => {
  const governor = new ComplexityRateGovernor({ capacity: 150, refillPerSecond: 1, now: () => 0 });
  const guard = new SubscriptionComplexityGuard({ config, governor });
  const heavy = parse(`subscription { teamUpdates(first: 100) { players(first: 1) { name } } }`);
  assert.equal(await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "1", schema: subscriptionSchema, document: heavy }), null);
  const rejected = await guard.onSubscribe({ clientKey: "user:a", subscriptionId: "2", schema: subscriptionSchema, document: heavy });
  assert.equal(rejected?.extensions.code, COMPLEXITY_ERROR_CODES.RATE_LIMITED);
});

test("evaluateOperation: ambiguous multi-operation document is a 400", async () => {
  const decision = await evaluateOperation(
    { schema, document: parse(`query A { ping: players { id } } query B { players { id } }`), clientKey: "ip:1" },
    { config }
  );
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal((decision.error.extensions.http as { status: number }).status, 400);
});

// ---------------------------------------------------------------------------
// Client identity and overhead
// ---------------------------------------------------------------------------

test("client key: falls back to IP when the bearer token is missing or invalid", () => {
  assert.equal(resolveGraphqlClientKey({ headers: {}, ip: "203.0.113.7" }), "ip:203.0.113.7");
  assert.equal(
    resolveGraphqlClientKey({ headers: { authorization: "Bearer not-a-jwt" }, ip: "203.0.113.7" }),
    "ip:203.0.113.7"
  );
});

test("overhead: analysing a typical optimized query stays well under 2ms", () => {
  const document = parse(`
    query LeagueView($id: ID!) {
      league(id: $id) {
        id name status scoringType currentMembers
        creator { id username }
        members { id rank totalPoints user { id username } squad { id name totalPoints } }
      }
    }
  `);
  // Warm up the JIT, then measure the steady-state average
  for (let i = 0; i < 200; i++) analyzeOperation({ schema, document, variables: { id: "1" }, config });
  const iterations = 2000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    analyzeOperation({ schema, document, variables: { id: "1" }, config });
  }
  const averageMs = (performance.now() - start) / iterations;
  assert.ok(averageMs < 2, `average analysis time ${averageMs.toFixed(4)}ms exceeds 2ms`);
});
