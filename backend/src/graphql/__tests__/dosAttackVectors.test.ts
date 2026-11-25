/**
 * DoS Attack Vector Test Suite — Issue #437
 *
 * Verifies that the GraphQL complexity analyser and depth validator correctly
 * identify and reject known denial-of-service attack patterns before they
 * reach resolver code.
 *
 * All tests are self-contained: no database, no Redis, no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parse } from "graphql";
import { analyzeQueryComplexity, clearComplexityCache } from "../queryAnalyzer.js";
import { validateQueryDepth } from "../depthValidator.js";
import {
  getComplexityConfigInstance,
  resetComplexityConfig,
} from "../../config/complexity.js";

describe("DoS Attack Vectors", () => {
  let config = getComplexityConfigInstance();

  beforeEach(() => {
    resetComplexityConfig();
    clearComplexityCache();
    config = getComplexityConfigInstance();
  });

  // ---------------------------------------------------------------------------
  // Attack 1 — Recursive depth bomb
  // ---------------------------------------------------------------------------
  describe("Recursive depth bomb", () => {
    it("rejects a deeply nested query that exceeds maxDepth", () => {
      // users(1) → squads(2) → players(3) → player(4) → team(5) → id = depth 6.
      // With strictConfig.maxDepth=7 this passes; drop maxDepth to 5 to force rejection.
      const shallowConfig = { ...config, maxDepth: 5, maxComplexityPerQuery: 1000 };

      const query = parse(`
        query {
          users {
            squads {
              players {
                player {
                  team {
                    id
                  }
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, shallowConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(shallowConfig.maxDepth);
      expect(result.error).toBeDefined();
      expect(result.error?.extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    });

    it("accepts the same query when maxDepth is high enough", () => {
      // With the default maxDepth (10) the query above is well within bounds.
      const query = parse(`
        query {
          users {
            squads {
              players {
                player {
                  team {
                    id
                  }
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      // depth = 6, default maxDepth = 10 → should pass
      expect(result.valid).toBe(true);
      expect(result.depth).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 2 — Introspection depth attack
  // ---------------------------------------------------------------------------
  describe("Introspection depth attack", () => {
    it("rejects deeply chained introspection with maxDepth=7", () => {
      // __schema(1) types(2) fields(3) type(4) ofType(5) ofType(6) ofType(7) kind = depth 7
      // Adding one extra ofType pushes it to 8, which exceeds maxDepth=7.
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };

      const query = parse(`
        query {
          __schema {
            types {
              fields {
                type {
                  ofType {
                    ofType {
                      ofType {
                        kind
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, strictConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(strictConfig.maxDepth);
      expect(result.error?.extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    });

    it("accepts introspection at exactly maxDepth", () => {
      // __schema(1) types(2) fields(3) type(4) ofType(5) ofType(6) kind = depth 7 ≤ 7
      const strictConfig = { ...config, maxDepth: 7 };

      const query = parse(`
        query {
          __schema {
            types {
              fields {
                type {
                  ofType {
                    ofType {
                      kind
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, strictConfig);

      expect(result.valid).toBe(true);
      expect(result.depth).toBeLessThanOrEqual(strictConfig.maxDepth);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 3 — Circular reference simulation
  // ---------------------------------------------------------------------------
  describe("Circular reference simulation", () => {
    it("detects and rejects 20 levels of the same repeated field name", () => {
      // Manually nest the `users` field 20 levels deep.
      // With any sensible maxDepth ≤ 15 this should be rejected.
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };

      let query = "query { ";
      for (let i = 0; i < 20; i++) query += "users { ";
      query += "id ";
      for (let i = 0; i < 20; i++) query += "} ";
      query += "}";

      const result = validateQueryDepth(parse(query), strictConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(strictConfig.maxDepth);
      expect(result.error?.extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    });

    it("reports the deepest path so the attack vector is identifiable", () => {
      const strictConfig = { ...config, maxDepth: 3 };

      const query = parse(`
        query {
          users {
            squads {
              players {
                id
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, strictConfig);

      expect(result.valid).toBe(false);
      expect(result.deepestPath).toContain("users");
      expect(result.deepestPath.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 4 — N+1 amplification via pagination
  // ---------------------------------------------------------------------------
  describe("N+1 amplification via pagination", () => {
    it("produces complexity > 10 000 for deeply nested 1000×1000 pagination", () => {
      // users(limit:1000) → squads → players(limit:1000) → id
      // Expected complexity ≫ 10 000 due to cascading pagination multipliers.
      const query = parse(`
        query {
          users(limit: 1000) {
            squads {
              players(limit: 1000) {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(10_000);
    });

    it("grows complexity proportionally to the product of pagination args", () => {
      const small = parse(`
        query {
          users(limit: 10) {
            players(limit: 10) {
              id
            }
          }
        }
      `);

      const large = parse(`
        query {
          users(limit: 100) {
            players(limit: 100) {
              id
            }
          }
        }
      `);

      const rSmall = analyzeQueryComplexity(small, config);
      const rLarge = analyzeQueryComplexity(large, config);

      // 100×100 nesting must be more expensive than 10×10 nesting
      expect(rLarge.complexity).toBeGreaterThan(rSmall.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 5 — Alias explosion
  // ---------------------------------------------------------------------------
  describe("Alias explosion", () => {
    it("counts 200 aliased expensive fields and produces high complexity", () => {
      // 200 aliases of league(id:"X") { members { id } } in a single query.
      let aliasQuery = "query { ";
      for (let i = 0; i < 200; i++) {
        aliasQuery += `league${i}: league(id: "${i}") { members { id } } `;
      }
      aliasQuery += "}";

      const result = analyzeQueryComplexity(parse(aliasQuery), config);

      // Every alias introduces at least 2 fields (the alias itself + members/id descendants)
      expect(result.fieldCount).toBeGreaterThanOrEqual(200);
      // 200 × (league weight + members weight) must yield substantial complexity
      expect(result.complexity).toBeGreaterThan(500);
    });

    it("complexity scales linearly with alias count", () => {
      const build = (n: number) => {
        let q = "query { ";
        for (let i = 0; i < n; i++) q += `league${i}: league(id: "${i}") { id } `;
        q += "}";
        return parse(q);
      };

      const r10 = analyzeQueryComplexity(build(10), config);
      const r100 = analyzeQueryComplexity(build(100), config);

      // 100 aliases must be more expensive than 10
      expect(r100.complexity).toBeGreaterThan(r10.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 6 — Batch alias multiplication (league × members)
  // ---------------------------------------------------------------------------
  describe("Batch alias multiplication", () => {
    it("produces high complexity for 50 league aliases each fetching members", () => {
      let batchQuery = "query { ";
      for (let i = 0; i < 50; i++) {
        batchQuery += `l${i}: league(id: "${i}") { members { user { id } } } `;
      }
      batchQuery += "}";

      const result = analyzeQueryComplexity(parse(batchQuery), config);

      // 50 × (league + members + user subtree) must be non-trivial
      expect(result.complexity).toBeGreaterThan(100);
      // All 50 league aliases are distinct fields
      expect(result.fieldCount).toBeGreaterThanOrEqual(50);
    });

    it("is more expensive than a single league query", () => {
      const single = parse(`
        query {
          league(id: "1") {
            members {
              user {
                id
              }
            }
          }
        }
      `);

      let batchQuery = "query { ";
      for (let i = 0; i < 50; i++) {
        batchQuery += `l${i}: league(id: "${i}") { members { user { id } } } `;
      }
      batchQuery += "}";

      const rSingle = analyzeQueryComplexity(single, config);
      const rBatch = analyzeQueryComplexity(parse(batchQuery), config);

      expect(rBatch.complexity).toBeGreaterThan(rSingle.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 7 — Deeply nested inline fragments
  // ---------------------------------------------------------------------------
  describe("Deeply nested inline fragments", () => {
    it("accumulates significant complexity for 5-level nested fragments on list fields", () => {
      const query = parse(`
        query {
          leagues(limit: 50) {
            ... on League {
              members(limit: 50) {
                ... on LeagueMember {
                  user {
                    ... on User {
                      squads(limit: 10) {
                        ... on Squad {
                          players(limit: 10) {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // 50 leagues × 50 members × players nesting — complexity must be substantial
      expect(result.complexity).toBeGreaterThan(10_000);
    });

    it("measures depth correctly through inline fragment wrappers", () => {
      const query = parse(`
        query {
          leagues(limit: 5) {
            ... on League {
              members(limit: 5) {
                ... on LeagueMember {
                  user {
                    id
                  }
                }
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // leagues(1) → members(2) → user(3) → id = depth 4
      expect(result.depth).toBeGreaterThanOrEqual(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 8 — Field weight accumulation
  // ---------------------------------------------------------------------------
  describe("Field weight accumulation", () => {
    it("high-weight fields (members, squads, players, createdLeagues) cost more than scalars", () => {
      const scalarOnly = parse(`
        query {
          user(id: "1") {
            id
            username
            name
          }
        }
      `);

      const heavyFields = parse(`
        query {
          league(id: "1") {
            members {
              user {
                squads {
                  players {
                    id
                  }
                }
              }
            }
          }
        }
      `);

      const rScalar = analyzeQueryComplexity(scalarOnly, config);
      const rHeavy = analyzeQueryComplexity(heavyFields, config);

      expect(rHeavy.complexity).toBeGreaterThan(rScalar.complexity);
    });

    it("complexity breakdown sum equals total complexity", () => {
      const query = parse(`
        query {
          leagues(limit: 2) {
            id
            members {
              id
              user {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      let breakdownSum = 0;
      for (const value of result.breakdown.values()) {
        breakdownSum += value;
      }

      expect(breakdownSum).toEqual(result.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 9 — Pagination multiplier cap
  // ---------------------------------------------------------------------------
  describe("Pagination multiplier cap", () => {
    it("caps an absurdly large `first` argument so complexity does not overflow", () => {
      // first: 999999 must be capped at maxPaginationMultiplier (default 1000).
      const query = parse(`
        query {
          users(first: 999999) {
            id
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Complexity must be finite and bounded — not proportional to 999999.
      // With maxPaginationMultiplier=1000 and listFieldWeight=5:
      // users cost = 5×1000 = 5000; child id = 1×1000 = 1000; total = 6000.
      expect(result.complexity).toBeGreaterThan(0);
      expect(Number.isFinite(result.complexity)).toBe(true);
      // A reasonable upper bound: at most maxPaginationMultiplier × (listFieldWeight + 1) × depth
      const upperBound = config.maxPaginationMultiplier * config.listFieldWeight * 10;
      expect(result.complexity).toBeLessThanOrEqual(upperBound);
    });

    it("produces the same complexity for first:999999 and first:999999999", () => {
      const q1 = parse("query { users(first: 999999) { id } }");
      const q2 = parse("query { users(first: 999999999) { id } }");

      const r1 = analyzeQueryComplexity(q1, config);
      const r2 = analyzeQueryComplexity(q2, config);

      // Both should be capped at the same multiplier ceiling
      expect(r1.complexity).toEqual(r2.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 10 — Zero / negative pagination arguments
  // ---------------------------------------------------------------------------
  describe("Zero and negative pagination arguments", () => {
    it("does not crash with first:0 and returns a sane non-negative complexity", () => {
      const query = parse("query { users(first: 0) { id } }");

      const result = analyzeQueryComplexity(query, config);

      // Must complete without throwing
      expect(result.complexity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.complexity)).toBe(true);
    });

    it("does not crash with first:-1 and returns a sane non-negative complexity", () => {
      const query = parse("query { users(first: -1) { id } }");

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.complexity)).toBe(true);
    });

    it("treats zero or negative pagination as effectively the default multiplier", () => {
      // A query with no pagination arg at all should produce a comparable complexity
      // to queries with first:0 or first:-1 (both fall back to the default multiplier).
      const noArg = parse("query { users { id } }");
      const zeroArg = parse("query { users(first: 0) { id } }");
      const negArg = parse("query { users(first: -1) { id } }");

      const rNoArg = analyzeQueryComplexity(noArg, config);
      const rZero = analyzeQueryComplexity(zeroArg, config);
      const rNeg = analyzeQueryComplexity(negArg, config);

      // All three should produce identical complexity since the multiplier
      // is clamped to max(value, 1) (or the default) in all degenerate cases.
      expect(rZero.complexity).toEqual(rNoArg.complexity);
      expect(rNeg.complexity).toEqual(rNoArg.complexity);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 11 — Standard query passes (regression guard)
  // ---------------------------------------------------------------------------
  describe("Standard query passes", () => {
    it("accepts a minimal user-profile query and attaches metadata", () => {
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };
      const query = parse(`
        query {
          user(id: "1") {
            id
            username
          }
        }
      `);

      const depthResult = validateQueryDepth(query, strictConfig);
      const complexityResult = analyzeQueryComplexity(query, strictConfig);

      expect(depthResult.valid).toBe(true);
      expect(depthResult.depth).toBeLessThanOrEqual(strictConfig.maxDepth);
      expect(complexityResult.complexity).toBeGreaterThan(0);
      expect(complexityResult.complexity).toBeLessThanOrEqual(strictConfig.maxComplexityPerQuery);
      expect(complexityResult.fieldCount).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 12 — Max depth boundary
  // ---------------------------------------------------------------------------
  describe("Max depth boundary", () => {
    it("accepts a query at exactly maxDepth", () => {
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };
      const md = strictConfig.maxDepth; // 7

      // Build a query with exactly md levels of nesting:
      // query { users { users { users { users { users { users { id } } } } } } }
      //         ↑1       ↑2      ↑3      ↑4      ↑5      ↑6     (depth=7 at leaf)
      let query = "query { ";
      for (let i = 1; i < md; i++) query += "users { ";  // md-1 = 6 opens
      query += "id ";
      for (let i = 1; i < md; i++) query += "} ";
      query += "}";

      const result = validateQueryDepth(parse(query), strictConfig);

      expect(result.depth).toBe(md);
      expect(result.valid).toBe(true);
    });

    it("rejects a query one level beyond maxDepth", () => {
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };
      const md = strictConfig.maxDepth; // 7

      // Build a query with md+1 levels: md opens (depth = md+1 at leaf).
      let query = "query { ";
      for (let i = 1; i <= md; i++) query += "users { ";  // md = 7 opens → depth 8
      query += "id ";
      for (let i = 1; i <= md; i++) query += "} ";
      query += "}";

      const result = validateQueryDepth(parse(query), strictConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(md);
      expect(result.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 13 — Empty / trivial query
  // ---------------------------------------------------------------------------
  describe("Empty and trivial queries", () => {
    it("handles { __typename } without errors", () => {
      const strictConfig = { ...config, maxDepth: 7, maxComplexityPerQuery: 1000 };
      const query = parse("query { __typename }");

      const depthResult = validateQueryDepth(query, strictConfig);
      const complexityResult = analyzeQueryComplexity(query, strictConfig);

      expect(depthResult.valid).toBe(true);
      expect(depthResult.error).toBeUndefined();
      expect(complexityResult.complexity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(complexityResult.complexity)).toBe(true);
    });

    it("handles an empty document gracefully", () => {
      const emptyDoc = { kind: "Document" as const, definitions: [] };

      const depthResult = validateQueryDepth(emptyDoc, config);
      const complexityResult = analyzeQueryComplexity(emptyDoc, config);

      expect(depthResult.valid).toBe(true);
      expect(depthResult.depth).toBe(0);
      expect(complexityResult.complexity).toBe(0);
      expect(complexityResult.fieldCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Attack 14 — Large number of scalar fields (flat query)
  // ---------------------------------------------------------------------------
  describe("Large number of scalar fields", () => {
    it("produces reasonable complexity for 100 scalar fields in a flat query", () => {
      // All 100 selections are `id` on the same user — no nesting, no lists.
      let query = 'query { user(id: "1") { ';
      for (let i = 0; i < 100; i++) query += "id ";
      query += "} }";

      const result = analyzeQueryComplexity(parse(query), config);

      // 100 scalar fields × defaultFieldWeight(1) = 100, plus the `user` field weight.
      // Complexity must be proportional to field count, not explosive.
      expect(result.complexity).toBeGreaterThan(0);
      expect(result.fieldCount).toBe(101); // 100 scalars + 1 `user` field
      // Flat queries must not exceed a generous ceiling even with 100 fields
      expect(result.complexity).toBeLessThan(500);
      expect(Number.isFinite(result.complexity)).toBe(true);
    });

    it("flat query with 100 scalars is cheaper than a paginated list query", () => {
      let flatQuery = 'query { user(id: "1") { ';
      for (let i = 0; i < 100; i++) flatQuery += "id ";
      flatQuery += "} }";

      const paginatedQuery = parse(`
        query {
          users(limit: 100) {
            id
            squads {
              players {
                id
              }
            }
          }
        }
      `);

      const rFlat = analyzeQueryComplexity(parse(flatQuery), config);
      const rPaginated = analyzeQueryComplexity(paginatedQuery, config);

      expect(rPaginated.complexity).toBeGreaterThan(rFlat.complexity);
    });
  });
});
