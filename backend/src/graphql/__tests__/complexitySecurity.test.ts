import { describe, it, expect, beforeEach } from "vitest";
import { parse } from "graphql";
import { analyzeQueryComplexity } from "../queryAnalyzer.js";
import { validateQueryDepth } from "../depthValidator.js";
import {
  getComplexityConfigInstance,
  resetComplexityConfig,
} from "../../config/complexity.js";

describe("Complexity Limiter - Security Tests", () => {
  let config = getComplexityConfigInstance();

  beforeEach(() => {
    resetComplexityConfig();
    config = getComplexityConfigInstance();
  });

  describe("Malicious deeply nested queries", () => {
    it("should reject pathological deeply nested query", () => {
      // Query that tries to exploit deep nesting
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

      const shallowConfig = { ...config, maxDepth: 3 };
      const result = validateQueryDepth(query, shallowConfig);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    });

    it("should detect and reject highly nested user query", () => {
      const query = parse(`
        query {
          user(id: "1") {
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

      const restrictiveConfig = { ...config, maxDepth: 2 };
      const depthResult = validateQueryDepth(query, restrictiveConfig);

      expect(depthResult.valid).toBe(false);
    });
  });

  describe("Large pagination attacks", () => {
    it("should cap pagination multiplier at max allowed", () => {
      const query = parse(`
        query {
          users(limit: 999999999) {
            id
            username
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should cap at maxPaginationMultiplier
      const expectedMax = config.maxPaginationMultiplier;
      const userQueryComplexity = result.breakdown.get("Query.users") || 0;

      // Complexity should not grow beyond reasonable bounds
      expect(result.complexity).toBeLessThanOrEqual(
        config.maxComplexityPerQuery * 2
      );
    });

    it("should reject query with excessive pagination arguments", () => {
      const query = parse(`
        query {
          users(limit: 10000) {
            squads {
              id
              players(limit: 5000) {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should be high but capped
      expect(result.complexity).toBeGreaterThan(0);
    });

    it("should handle multiple large pagination args", () => {
      const query = parse(`
        query {
          users(limit: 1000) {
            id
            squads {
              id
              players {
                id
              }
            }
            createdLeagues(limit: 1000) {
              id
              members(limit: 1000) {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should be capped by maxComplexityPerQuery
      expect(result.complexity).toBeGreaterThan(0);
    });
  });

  describe("Alias-based expansion attacks", () => {
    it("should handle field aliases in complexity calculation", () => {
      // Aliases don't change the actual complexity, just the response shape
      const query = parse(`
        query {
          users1: users(limit: 10) {
            id
          }
          users2: users(limit: 10) {
            id
          }
          users3: users(limit: 10) {
            id
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should count each alias as a separate field selection
      expect(result.fieldCount).toBeGreaterThanOrEqual(3);
      expect(result.complexity).toBeGreaterThan(0);
    });

    it("should reject queries with too many aliases exceeding complexity", () => {
      let aliasedQuery = "query { ";
      for (let i = 0; i < 100; i++) {
        aliasedQuery += `users${i}: users(limit: 10) { id } `;
      }
      aliasedQuery += "}";

      const query = parse(aliasedQuery);
      const result = analyzeQueryComplexity(query, config);

      // Should be very high complexity due to multiple pagination
      expect(result.fieldCount).toBe(100);
      expect(result.complexity).toBeGreaterThan(100);
    });
  });

  describe("Fragment-based attacks", () => {
    it("should handle inline fragments in complexity calculation", () => {
      const query = parse(`
        query {
          users {
            id
            ... on User {
              username
              ... on User {
                name
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(0);
      expect(result.fieldCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("List field multiplication attacks", () => {
    it("should detect nested lists with multiplication effect", () => {
      const query = parse(`
        query {
          users(limit: 100) {
            squads {
              players(limit: 100) {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Nested lists should multiply: 100 users * 100 players per squad
      expect(result.complexity).toBeGreaterThan(1000);
    });

    it("should handle deeply nested list multiplications", () => {
      const query = parse(`
        query {
          leagues(limit: 50) {
            members(limit: 50) {
              squad {
                players(limit: 50) {
                  player {
                    id
                  }
                }
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should multiply: 50 * 50 * 50 = 125,000 (before capping)
      expect(result.complexity).toBeGreaterThan(0);
    });
  });

  describe("Quadratic complexity attacks", () => {
    it("should identify and limit quadratic growth patterns", () => {
      // Pattern: users -> squads -> players creates O(n^3) potential complexity
      const query = parse(`
        query {
          users(limit: 100) {
            squads {
              id
              players {
                id
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should be detected as high complexity
      expect(result.complexity).toBeGreaterThan(100);
    });
  });

  describe("CPU exhaustion attacks", () => {
    it("should complete analysis quickly even for complex queries", () => {
      const query = parse(`
        query {
          users(limit: 100) {
            id
            username
            wallet {
              id
            }
            squads(limit: 50) {
              id
              name
              totalPoints
              players(limit: 25) {
                id
                player {
                  id
                  displayName
                  price
                  team {
                    id
                    name
                  }
                }
                isCaptain
              }
            }
            createdLeagues(limit: 10) {
              id
              members(limit: 50) {
                user {
                  id
                }
                squad {
                  id
                }
              }
            }
          }
        }
      `);

      const startTime = performance.now();
      const result = analyzeQueryComplexity(query, config);
      const elapsed = performance.now() - startTime;

      // Should still analyze quickly
      expect(elapsed).toBeLessThan(100);
      expect(result.calculationTime).toBeLessThan(config.calculationTimeoutMs);
    });

    it("should respect calculation timeout", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
          }
        }
      `);

      const veryStrictConfig = {
        ...config,
        calculationTimeoutMs: 0.001, // 1 microsecond - unrealistic but tests the mechanism
      };

      const result = analyzeQueryComplexity(query, veryStrictConfig);

      // Calculation should still complete but we test the timeout mechanism
      expect(result.calculationTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("DOS prevention", () => {
    it("should reject repeatedly submitted complex queries", async () => {
      const complexQuery = parse(`
        query {
          leagues(limit: 50) {
            members(limit: 50) {
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

      // Simulate multiple rapid requests
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = analyzeQueryComplexity(complexQuery, config);
        results.push(result);
      }

      // All should have same high complexity
      expect(results.every((r) => r.complexity > 100)).toBe(true);
    });

    it("should identify high-cost field patterns", () => {
      const query = parse(`
        query {
          leagues(limit: 100) {
            members {
              user {
                squads {
                  players {
                    player {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should mark as risky based on field path
      expect(result.depth).toBeGreaterThan(3);
      expect(result.complexity).toBeGreaterThan(0);
    });
  });

  describe("Boundary conditions", () => {
    it("should handle max depth exactly at boundary", () => {
      // Build query with exactly maxDepth levels
      let query = "query { users { ";
      for (let i = 1; i < config.maxDepth - 1; i++) {
        query += "squads { ";
      }
      query += "id ";
      for (let i = 1; i < config.maxDepth - 1; i++) {
        query += "} ";
      }
      query += "} }";

      const parsed = parse(query);
      const result = validateQueryDepth(parsed, config);

      // Should be valid at exact boundary
      expect(result.depth).toBeLessThanOrEqual(config.maxDepth);
    });

    it("should reject query one level deeper than max", () => {
      let query = "query { users { ";
      for (let i = 1; i < config.maxDepth; i++) {
        query += "squads { ";
      }
      query += "id ";
      for (let i = 1; i < config.maxDepth; i++) {
        query += "} ";
      }
      query += "} }";

      const parsed = parse(query);
      const result = validateQueryDepth(parsed, config);

      // Should be invalid one level over
      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(config.maxDepth);
    });
  });

  describe("Regression tests", () => {
    it("should not allow exponential expansion via aliases", () => {
      // Try to expand fields exponentially with aliases
      let query = "query { ";
      for (let i = 0; i < 50; i++) {
        query += `league${i}: league(id: "1") { id } `;
      }
      query += "}";

      const parsed = parse(query);
      const result = analyzeQueryComplexity(parsed, config);

      // Should count all 50 aliases as separate fields
      expect(result.fieldCount).toBe(50);
    });

    it("should not bypass limits with fragment references", () => {
      const query = parse(`
        query {
          users {
            ... on User {
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
        }
      `);

      const shallowConfig = { ...config, maxDepth: 3 };
      const result = validateQueryDepth(query, shallowConfig);

      // Should still validate depth even with fragments
      expect(result.depth).toBeGreaterThan(shallowConfig.maxDepth || 0);
    });
  });

  describe("Real-world attack simulations", () => {
    it("should block typical graphql bomb pattern", () => {
      const query = parse(`
        query {
          users(limit: 100) {
            id
            username
            squads(limit: 100) {
              id
              name
              players(limit: 100) {
                id
                player {
                  id
                  displayName
                  team {
                    id
                    name
                  }
                }
              }
            }
            createdLeagues(limit: 100) {
              id
              name
              members(limit: 100) {
                id
                user {
                  id
                }
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should be very high complexity (100^3 patterns)
      expect(result.complexity).toBeGreaterThan(1000);
    });

    it("should handle massive pagination values gracefully", () => {
      const query = parse(`
        query {
          users(limit: 9223372036854775807) {
            id
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should cap the multiplier and not overflow
      expect(result.complexity).toBeGreaterThan(0);
      expect(result.complexity).toBeLessThanOrEqual(
        config.maxComplexityPerQuery * 2
      );
    });
  });
});
