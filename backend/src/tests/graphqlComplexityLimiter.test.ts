import test from "node:test";
import assert from "node:assert/strict";
import { GraphqlComplexityLimiter } from "../graphql/complexityLimiter.js";

test("GraphqlComplexityLimiter: rejects deeply nested cyclic queries exceeding maxDepth", () => {
  const limiter = new GraphqlComplexityLimiter({
    maxDepth: 5,
    maxComplexity: 10000,
  });

  const cyclicQuery = `
    query DeepAttack {
      leagues(first: 2) {
        members(first: 2) {
          squad {
            players(first: 2) {
              team {
                players(first: 2) {
                  id
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = limiter.analyzeQuery(cyclicQuery);
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, "MAX_DEPTH_EXCEEDED");
  assert.equal(result.depth, 7);
});

test("GraphqlComplexityLimiter: multiplies list pagination arguments and fragment spreads to enforce maxComplexity", () => {
  const limiter = new GraphqlComplexityLimiter({
    maxDepth: 8,
    maxComplexity: 500,
  });

  // leagues(first: 10) * members(first: 20) = 200 items -> exceeds 500 complexity with child fields
  const expensiveQuery = `
    fragment MemberScoreFields on LeagueMember {
      id
      totalPoints
      rank
    }

    query ExpensiveList($memberLimit: Int) {
      leagues(first: 10) {
        id
        name
        members(first: $memberLimit) {
          ...MemberScoreFields
        }
      }
    }
  `;

  const rejected = limiter.analyzeQuery(expensiveQuery, { memberLimit: 20 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.rejectionCode, "MAX_COMPLEXITY_EXCEEDED");
  assert.ok(rejected.totalComplexity > 500);

  // Reasonable pagination (leagues: 2, members: 5) passes cleanly
  const allowed = limiter.analyzeQuery(expensiveQuery, { memberLimit: 5 });
  // wait: leagues(first: 10) * members(first: 5) = 50 * (id + totalPoints + rank) = 150 + 10*(2 + 1 + 1 + 5*2) = 290 <= 500
  assert.equal(allowed.allowed, true);
  assert.ok(allowed.totalComplexity <= 500);
});

test("GraphqlComplexityLimiter: enforces token-bucket rate budget and WebSocket subscription concurrency limits", () => {
  const limiter = new GraphqlComplexityLimiter({
    maxDepth: 6,
    maxComplexity: 500,
    bucketCapacity: 150,
    refillRatePerSecond: 50,
    maxSubscriptionsPerClient: 2,
  });

  const subQuery = `
    subscription LiveStandings {
      liveLeaderboardUpdated(limit: 5) {
        squadId
        rank
      }
    }
  `;

  // Subscription 1 & 2 succeed
  const sub1 = limiter.enforceOperation({
    clientId: "user-sub-1",
    query: subQuery,
    subscriptionId: "ws-1",
    nowMs: 1_000_000,
  });
  assert.equal(sub1.allowed, true);

  const sub2 = limiter.enforceOperation({
    clientId: "user-sub-1",
    query: subQuery,
    subscriptionId: "ws-2",
    nowMs: 1_000_000,
  });
  assert.equal(sub2.allowed, true);
  assert.equal(limiter.getActiveSubscriptionCount("user-sub-1"), 2);

  // Subscription 3 exceeds maxSubscriptionsPerClient (2)
  const sub3 = limiter.enforceOperation({
    clientId: "user-sub-1",
    query: subQuery,
    subscriptionId: "ws-3",
    nowMs: 1_000_000,
  });
  assert.equal(sub3.allowed, false);
  assert.equal(sub3.rejectionCode, "SUBSCRIPTION_LIMIT_EXCEEDED");

  // Release ws-1 and exhaust token bucket
  limiter.releaseSubscription("user-sub-1", "ws-1");
  assert.equal(limiter.getActiveSubscriptionCount("user-sub-1"), 1);

  const subAfterExhaust = limiter.enforceOperation({
    clientId: "user-sub-1",
    query: `
      query BurstQuery {
        leagues(first: 20) {
          id
          name
          prizePool
        }
      }
    `,
    nowMs: 1_000_000,
  });
  assert.equal(subAfterExhaust.allowed, false);
  assert.equal(subAfterExhaust.rejectionCode, "RATE_LIMIT_EXCEEDED");

  // After 3 seconds (+150 tokens refilled), query succeeds
  const afterRefill = limiter.enforceOperation({
    clientId: "user-sub-1",
    query: `
      query BurstQuery {
        leagues(first: 20) {
          id
          name
          prizePool
        }
      }
    `,
    nowMs: 1_003_000,
  });
  assert.equal(afterRefill.allowed, true);
});
