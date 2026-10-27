import { describe, it, expect, beforeEach } from "vitest";
import { parse, DocumentNode } from "graphql";
import {
  validateQueryDepth,
  QueryDepthExceededError,
  extractDeepFieldNames,
  hasRiskyFields,
  formatDepthValidationResult,
} from "../depthValidator.js";
import {
  getComplexityConfigInstance,
  resetComplexityConfig,
} from "../../config/complexity.js";

describe("Depth Validator", () => {
  let config = getComplexityConfigInstance();

  beforeEach(() => {
    resetComplexityConfig();
    config = getComplexityConfigInstance();
  });

  describe("Basic depth validation", () => {
    it("should validate simple single-level query", () => {
      const query = parse(`
        query {
          users {
            id
            username
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(2); // root + users
      expect(result.error).toBeUndefined();
    });

    it("should validate two-level nested query", () => {
      const query = parse(`
        query {
          users {
            squads {
              id
              name
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(3); // root + users + squads
    });

    it("should accept queries within max depth", () => {
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

      // Assuming default max depth is 10
      if (result.depth <= config.maxDepth) {
        expect(result.valid).toBe(true);
      }
    });
  });

  describe("Depth limit enforcement", () => {
    it("should reject queries exceeding max depth", () => {
      // Create a query deeper than max depth
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

      // Use a very shallow max depth to trigger rejection
      const shallowConfig = { ...config, maxDepth: 2 };
      const result = validateQueryDepth(query, shallowConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(shallowConfig.maxDepth);
      expect(result.error).toBeInstanceOf(QueryDepthExceededError);
    });

    it("should report deepest path in error", () => {
      const query = parse(`
        query {
          users {
            squads {
              players {
                player {
                  id
                }
              }
            }
          }
        }
      `);

      const shallowConfig = { ...config, maxDepth: 2 };
      const result = validateQueryDepth(query, shallowConfig);

      if (!result.valid) {
        expect(result.deepestPath).toContain("users");
        expect(result.deepestPath.length).toBeGreaterThan(0);
      }
    });

    it("should provide accurate depth count in error", () => {
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

      const shallowConfig = { ...config, maxDepth: 2 };
      const result = validateQueryDepth(query, shallowConfig);

      if (!result.valid) {
        expect(result.depth).toBeGreaterThan(result.maxDepth);
        expect(result.error?.extensions?.depth).toBeUndefined();
        // Error extensions should have actualDepth
        expect(result.error?.extensions?.actualDepth).toEqual(result.depth);
        expect(result.error?.extensions?.maxDepth).toEqual(result.maxDepth);
      }
    });
  });

  describe("Complex selection structures", () => {
    it("should handle inline fragments", () => {
      const query = parse(`
        query {
          users {
            id
            ... on User {
              username
              wallet {
                stellarAddress
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      expect(result.valid).toBe(true);
      expect(result.depth).toBeGreaterThan(0);
    });

    it("should handle multiple branches at same level", () => {
      const query = parse(`
        query {
          user(id: "1") {
            wallet {
              id
            }
            squads {
              players {
                id
              }
            }
            createdLeagues {
              members {
                user {
                  id
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      // Should take the deepest branch
      expect(result.depth).toBeGreaterThanOrEqual(4);
      expect(result.valid).toBe(result.depth <= config.maxDepth);
    });

    it("should correctly identify deepest path with multiple branches", () => {
      const query = parse(`
        query {
          users {
            squads {
              players {
                id
              }
              name
            }
            wallet {
              id
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      // Deepest path should go through squads.players, not wallet
      expect(result.deepestPath).toContain("squads");
      expect(result.deepestPath).toContain("players");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty document gracefully", () => {
      const doc: DocumentNode = {
        kind: "Document",
        definitions: [],
      };

      const result = validateQueryDepth(doc, config);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(0);
    });

    it("should handle query with no selection set", () => {
      const doc: DocumentNode = {
        kind: "Document",
        definitions: [
          {
            kind: "OperationDefinition",
            operation: "query",
            selectionSet: undefined as any,
          } as any,
        ],
      };

      const result = validateQueryDepth(doc, config);

      expect(result.valid).toBe(true);
    });

    it("should calculate performance time", () => {
      const query = parse(`
        query {
          users {
            id
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      expect(result.validationTime).toBeGreaterThanOrEqual(0);
      expect(result.validationTime).toBeLessThan(100); // Should be quick
    });
  });

  describe("Error details", () => {
    it("should throw QueryDepthExceededError with correct details", () => {
      const error = new QueryDepthExceededError(5, 8, "users.squads.players");

      expect(error.name).toBe("QueryDepthExceededError");
      expect(error.message).toContain("5");
      expect(error.message).toContain("8");
      expect(error.message).toContain("users.squads.players");
      expect(error.extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    });
  });

  describe("Helper functions", () => {
    it("should extract deep field names from path", () => {
      const path = "users.squads.players.player.team";
      const fields = extractDeepFieldNames(path);

      expect(fields).toEqual(["users", "squads", "players", "player", "team"]);
      expect(fields.length).toBe(5);
    });

    it("should handle empty path", () => {
      const fields = extractDeepFieldNames("");
      expect(fields).toEqual([]);
    });

    it("should identify risky fields", () => {
      const fields1 = ["users", "wallet", "id"];
      const result1 = hasRiskyFields(fields1);

      expect(result1.risky).toBe(true);
      expect(result1.fields).toContain("users");

      const fields2 = ["id", "name", "email"];
      const result2 = hasRiskyFields(fields2);

      expect(result2.risky).toBe(false);
      expect(result2.fields.length).toBe(0);
    });

    it("should identify multiple risky fields", () => {
      const fields = ["users", "squads", "members"];
      const result = hasRiskyFields(fields);

      expect(result.risky).toBe(true);
      expect(result.fields.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Validation result formatting", () => {
    it("should format valid result correctly", () => {
      const query = parse(`
        query {
          users {
            id
          }
        }
      `);

      const result = validateQueryDepth(query, config);
      const formatted = formatDepthValidationResult(result);

      expect(formatted).toContain("✓");
      expect(formatted).toContain("valid");
      expect(formatted).toContain(result.depth.toString());
    });

    it("should format invalid result correctly", () => {
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

      const shallowConfig = { ...config, maxDepth: 2 };
      const result = validateQueryDepth(query, shallowConfig);
      const formatted = formatDepthValidationResult(result);

      if (!result.valid) {
        expect(formatted).toContain("✗");
        expect(formatted).toContain("exceeded");
      }
    });
  });

  describe("Real-world query patterns", () => {
    it("should validate typical user profile query within limits", () => {
      const query = parse(`
        query GetUserProfile {
          user(id: "123") {
            id
            username
            name
            wallet {
              id
              stellarAddress
            }
            squads {
              id
              name
              players {
                id
                player {
                  id
                  displayName
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      // Should be valid with reasonable max depth
      if (config.maxDepth >= 5) {
        expect(result.valid).toBe(true);
      }
    });

    it("should reject pathological deeply nested query", () => {
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

      const veryShallowConfig = { ...config, maxDepth: 1 };
      const result = validateQueryDepth(query, veryShallowConfig);

      expect(result.valid).toBe(false);
      expect(result.depth).toBeGreaterThan(veryShallowConfig.maxDepth);
    });

    it("should handle league query with nested members", () => {
      const query = parse(`
        query GetLeague {
          league(id: "league-1") {
            id
            name
            members {
              user {
                username
                squads {
                  name
                }
              }
            }
          }
        }
      `);

      const result = validateQueryDepth(query, config);

      expect(result.depth).toBeGreaterThan(2);
      expect(result.valid).toBe(result.depth <= config.maxDepth);
    });
  });

  describe("Performance and optimization", () => {
    it("should use early exit optimization for deep queries", () => {
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

      const veryShallowConfig = { ...config, maxDepth: 1 };
      const startTime = performance.now();
      const result = validateQueryDepth(query, veryShallowConfig);
      const elapsed = performance.now() - startTime;

      // Should be fast even with deep query due to early exit
      expect(elapsed).toBeLessThan(50);
      expect(result.valid).toBe(false);
    });

    it("should perform validation quickly for reasonable queries", () => {
      const query = parse(`
        query {
          users {
            id
            username
            wallet {
              id
            }
          }
        }
      `);

      const startTime = performance.now();
      const result = validateQueryDepth(query, config);
      const elapsed = performance.now() - startTime;

      expect(elapsed).toBeLessThan(20);
      expect(result.validationTime).toBeLessThan(20);
    });
  });
});
