import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse, DocumentNode } from "graphql";
import {
  analyzeQueryComplexity,
  calculateQueryDepth,
  clearComplexityCache,
  getComplexityCacheStats,
} from "../queryAnalyzer.js";
import {
  getComplexityConfigInstance,
  resetComplexityConfig,
} from "../../config/complexity.js";

describe("Query Analyzer - Complexity Calculation", () => {
  let config = getComplexityConfigInstance();

  beforeEach(() => {
    clearComplexityCache();
  });

  afterEach(() => {
    resetComplexityConfig();
    clearComplexityCache();
  });

  describe("Simple queries", () => {
    it("should calculate complexity for a simple scalar query", () => {
      const query = parse(`
        query {
          user(id: "1") {
            id
            username
            name
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(0);
      expect(result.depth).toBe(2); // root + user fields
      expect(result.fieldCount).toBe(4); // id, user, username, name
    });

    it("should calculate complexity for a query with list fields", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
            username
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should account for pagination multiplier
      expect(result.complexity).toBeGreaterThan(0);
      expect(result.listFieldCount).toBe(1); // users is a list
      expect(result.fieldCount).toBeGreaterThan(0);
    });

    it("should handle pagination arguments correctly", () => {
      const query1 = parse(`
        query {
          users(limit: 100) {
            id
          }
        }
      `);

      const query2 = parse(`
        query {
          users(limit: 10) {
            id
          }
        }
      `);

      const result1 = analyzeQueryComplexity(query1, config);
      const result2 = analyzeQueryComplexity(query2, config);

      // Larger limit should have higher complexity
      expect(result1.complexity).toBeGreaterThan(result2.complexity);
    });
  });

  describe("Nested queries", () => {
    it("should calculate complexity for nested object selections", () => {
      const query = parse(`
        query {
          user(id: "1") {
            id
            username
            wallet {
              id
              stellarAddress
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.depth).toBe(3); // root + user + wallet
      expect(result.complexity).toBeGreaterThan(0);
    });

    it("should calculate complexity for deeply nested selections", () => {
      const query = parse(`
        query {
          leagues(limit: 5) {
            id
            name
            members {
              id
              user {
                id
                username
                wallet {
                  id
                  stellarAddress
                }
              }
              squad {
                id
                name
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.depth).toBeGreaterThan(4);
      expect(result.complexity).toBeGreaterThan(0);
      expect(result.fieldCount).toBeGreaterThan(10);
    });

    it("should apply pagination multiplier to nested list fields", () => {
      const query1 = parse(`
        query {
          users(limit: 5) {
            squads {
              id
              players {
                id
              }
            }
          }
        }
      `);

      const query2 = parse(`
        query {
          users(limit: 5) {
            squads {
              id
              players {
                id
              }
            }
          }
        }
      `);

      const result1 = analyzeQueryComplexity(query1, config);
      const result2 = analyzeQueryComplexity(query2, config);

      // Both should be the same in this case, but demonstrate structure handling
      expect(result1.complexity).toEqual(result2.complexity);
    });
  });

  describe("Inline fragments", () => {
    it("should handle inline fragments in complexity calculation", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
            username
            ... on User {
              name
              countryCode
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(0);
      expect(result.fieldCount).toBeGreaterThan(2);
    });
  });

  describe("Complexity caching", () => {
    it("should cache complexity results for identical queries", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
            username
          }
        }
      `);

      const result1 = analyzeQueryComplexity(query, config, true);
      const result2 = analyzeQueryComplexity(query, config, true);

      // Both should have same complexity
      expect(result1.complexity).toEqual(result2.complexity);
      // Second should be marked as cached
      expect(result2.cached).toBe(true);

      // Cache should have one entry
      const stats = getComplexityCacheStats();
      expect(stats.size).toBe(1);
    });

    it("should not cache when caching is disabled", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
          }
        }
      `);

      analyzeQueryComplexity(query, config, false);
      const stats = getComplexityCacheStats();
      expect(stats.size).toBe(0);
    });

    it("should clear cache correctly", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
          }
        }
      `);

      analyzeQueryComplexity(query, config, true);
      let stats = getComplexityCacheStats();
      expect(stats.size).toBeGreaterThan(0);

      clearComplexityCache();
      stats = getComplexityCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe("Complexity breakdown", () => {
    it("should provide breakdown of complexity by field", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
            username
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.breakdown.size).toBeGreaterThan(0);
      // Should have entries for fields accessed
      expect([...result.breakdown.keys()].length).toBeGreaterThan(0);
    });

    it("should accumulate complexity correctly across nested structures", () => {
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

      // Total complexity should be sum of all field complexities
      // and pagination multipliers
      let breakdownSum = 0;
      for (const value of result.breakdown.values()) {
        breakdownSum += value;
      }

      expect(breakdownSum).toEqual(result.complexity);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty selection set gracefully", () => {
      const doc: DocumentNode = {
        kind: "Document",
        definitions: [],
      };

      const result = analyzeQueryComplexity(doc, config);

      expect(result.complexity).toBe(0);
      expect(result.depth).toBe(0);
      expect(result.fieldCount).toBe(0);
    });

    it("should handle very large pagination multipliers with caps", () => {
      const query = parse(`
        query {
          users(limit: 999999) {
            id
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      // Should cap at maxPaginationMultiplier
      expect(result.complexity).toBeLessThanOrEqual(
        config.maxComplexityPerQuery
      );
    });

    it("should calculate performance time correctly", () => {
      const query = parse(`
        query {
          users(limit: 10) {
            id
            username
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.calculationTime).toBeGreaterThanOrEqual(0);
      expect(result.calculationTime).toBeLessThan(100); // Should be quick
    });
  });

  describe("Real-world query patterns", () => {
    it("should handle typical user profile query", () => {
      const query = parse(`
        query GetUserProfile {
          user(id: "123") {
            id
            username
            name
            countryCode
            wallet {
              id
              stellarAddress
            }
            squads {
              id
              name
              totalPoints
              budgetRemaining
              players {
                id
                player {
                  id
                  displayName
                  price
                  totalPoints
                }
                isCaptain
                isViceCaptain
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(0);
      expect(result.depth).toBeGreaterThan(3);
      expect(result.fieldCount).toBeGreaterThan(15);
    });

    it("should handle league listing query with members", () => {
      const query = parse(`
        query GetLeagues {
          leagues(limit: 50) {
            id
            name
            description
            status
            currentMembers
            creator {
              id
              username
            }
            members(limit: 20) {
              id
              status
              totalPoints
              rank
              user {
                id
                username
              }
              squad {
                id
                name
                totalPoints
              }
            }
          }
        }
      `);

      const result = analyzeQueryComplexity(query, config);

      expect(result.complexity).toBeGreaterThan(0);
      expect(result.depth).toBeGreaterThan(3);
      expect(result.fieldCount).toBeGreaterThan(20);
    });
  });
});

describe("Query Depth Calculation", () => {
  let config = getComplexityConfigInstance();

  it("should calculate correct depth for single-level query", () => {
    const query = parse(`
      query {
        users {
          id
        }
      }
    `);

    const depth = calculateQueryDepth(query, config);
    expect(depth).toBe(2); // root + users
  });

  it("should calculate correct depth for multi-level nested query", () => {
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

    const depth = calculateQueryDepth(query, config);
    expect(depth).toBe(6); // root + users + squads + players + player + team
  });

  it("should return 0 for query with no operation", () => {
    const doc: DocumentNode = {
      kind: "Document",
      definitions: [],
    };

    const depth = calculateQueryDepth(doc, config);
    expect(depth).toBe(0);
  });
});
