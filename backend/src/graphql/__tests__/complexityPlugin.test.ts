import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parse } from "graphql";
import { createComplexityPlugin } from "../complexityPlugin.js";
import {
  getComplexityConfigInstance,
  resetComplexityConfig,
} from "../../config/complexity.js";
import { clearComplexityCache } from "../queryAnalyzer.js";

describe("Complexity Plugin - Apollo Server Integration", () => {
  let config = getComplexityConfigInstance();
  let plugin: any;

  beforeEach(() => {
    clearComplexityCache();
    resetComplexityConfig();
    config = getComplexityConfigInstance();
    plugin = createComplexityPlugin(null, { enabled: true, debugLogging: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Plugin initialization", () => {
    it("should create a valid Apollo plugin", () => {
      expect(plugin).toBeDefined();
      expect(plugin.didResolveOperation).toBeDefined();
      expect(plugin.didEncounterErrors).toBeDefined();
    });

    it("should accept custom config", () => {
      const customConfig = {
        maxDepth: 5,
        maxComplexityPerQuery: 1000,
      };
      const customPlugin = createComplexityPlugin(null, customConfig);

      expect(customPlugin).toBeDefined();
    });
  });

  describe("Query validation flow", () => {
    it("should accept valid simple query", async () => {
      const document = parse(`
        query {
          users(limit: 10) {
            id
            username
          }
        }
      `);

      const context: any = {
        errors: [],
      };

      const requestContext = {
        document,
        operationName: "GetUsers",
        request: { http: { headers: new Map() } },
        contextValue: context,
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      // Should not have errors
      expect(requestContext.errors).toBeUndefined();
      // Should have attached complexity metadata
      expect(requestContext.contextValue?.complexityMetadata).toBeDefined();
    });

    it("should reject query exceeding max depth", async () => {
      const document = parse(`
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

      const shallowConfig = { maxDepth: 2, enabled: true, debugLogging: false };
      const customPlugin = createComplexityPlugin(null, shallowConfig);

      const requestContext = {
        document,
        operationName: "DeepQuery",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await customPlugin.didResolveOperation(requestContext);

      // Should have errors due to depth
      expect(requestContext.errors).toBeDefined();
      if (requestContext.errors && requestContext.errors.length > 0) {
        expect(requestContext.errors[0].extensions?.code).toMatch(
          /DEPTH_EXCEEDED|QUERY_DEPTH_EXCEEDED/
        );
      }
    });

    it("should reject query exceeding max complexity", async () => {
      const document = parse(`
        query {
          users(limit: 1000) {
            id
            squads {
              id
              players {
                id
              }
            }
          }
        }
      `);

      const lowComplexityConfig = {
        maxComplexityPerQuery: 50,
        enabled: true,
        debugLogging: false,
      };
      const customPlugin = createComplexityPlugin(null, lowComplexityConfig);

      const requestContext = {
        document,
        operationName: "ComplexQuery",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await customPlugin.didResolveOperation(requestContext);

      // Should have errors due to complexity
      expect(requestContext.errors).toBeDefined();
      if (requestContext.errors && requestContext.errors.length > 0) {
        const hasComplexityError = requestContext.errors.some(
          (err: any) =>
            err.extensions?.code === "QUERY_COMPLEXITY_EXCEEDED" ||
            err.message.includes("complexity")
        );
        expect(hasComplexityError).toBe(true);
      }
    });
  });

  describe("Complexity metadata attachment", () => {
    it("should attach complexity metadata to context", async () => {
      const document = parse(`
        query {
          users(limit: 10) {
            id
            username
            squads {
              name
            }
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "GetUsersWithSquads",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      const metadata = requestContext.contextValue?.complexityMetadata;
      expect(metadata).toBeDefined();
      expect(metadata.complexity).toBeGreaterThan(0);
      expect(metadata.depth).toBeGreaterThan(0);
      expect(metadata.fieldCount).toBeGreaterThan(0);
      expect(metadata.depthValid).toBe(true);
      expect(metadata.rateLimitPassed).toBe(true);
      expect(metadata.validationTime).toBeGreaterThanOrEqual(0);
    });

    it("should include rate limit info in metadata", async () => {
      const document = parse(`
        query {
          users(limit: 5) {
            id
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "RateLimitTest",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      const metadata = requestContext.contextValue?.complexityMetadata;
      expect(metadata?.rateLimitInfo).toBeDefined();
      expect(metadata?.rateLimitInfo?.tokens).toBeGreaterThanOrEqual(0);
      expect(metadata?.rateLimitInfo?.maxTokens).toBeGreaterThan(0);
    });
  });

  describe("Request context handling", () => {
    it("should handle requests without contextValue", async () => {
      const document = parse(`
        query {
          users(limit: 5) {
            id
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "NoContext",
        request: { http: { headers: new Map() } },
        contextValue: undefined,
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      // Should create contextValue if needed
      expect(requestContext.contextValue).toBeDefined();
    });

    it("should extract IP from headers", async () => {
      const document = parse(`
        query {
          users(limit: 5) {
            id
          }
        }
      `);

      const headers = new Map();
      headers.set("x-forwarded-for", "192.168.1.1, 10.0.0.1");

      const requestContext = {
        document,
        operationName: "IPTest",
        request: { http: { headers } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      // Should successfully process with IP extraction
      expect(requestContext.contextValue?.complexityMetadata).toBeDefined();
    });

    it("should use userId for rate limiting when available", async () => {
      const document = parse(`
        query {
          users(limit: 5) {
            id
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "UserIDTest",
        request: { http: { headers: new Map() } },
        contextValue: { userId: "user-123" },
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      // Should use user-based rate limiting
      expect(requestContext.contextValue?.complexityMetadata).toBeDefined();
    });
  });

  describe("Plugin disabling", () => {
    it("should skip validation when disabled", async () => {
      const disabledPlugin = createComplexityPlugin(null, { enabled: false });

      const document = parse(`
        query {
          users(limit: 1000) {
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

      const requestContext = {
        document,
        operationName: "DisabledTest",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await disabledPlugin.didResolveOperation(requestContext);

      // Should not have validation errors
      expect(requestContext.errors).toBeUndefined();
      expect(requestContext.contextValue?.complexityMetadata).toBeUndefined();
    });
  });

  describe("Error handling", () => {
    it("should handle errors gracefully", async () => {
      const document = parse(`
        query {
          users(limit: 5) {
            id
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "ErrorTest",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: [new Error("Existing error")],
        response: { headers: new Map() },
      } as any;

      // Should not throw
      await expect(
        plugin.didResolveOperation(requestContext)
      ).resolves.not.toThrow();
    });

    it("should handle didEncounterErrors hook", async () => {
      const requestContext = {
        errors: [
          new Error("Test error with code", {
            extensions: { code: "QUERY_COMPLEXITY_EXCEEDED" },
          } as any),
        ],
      } as any;

      // Should not throw
      await expect(
        plugin.didEncounterErrors(requestContext)
      ).resolves.not.toThrow();
    });
  });

  describe("Mutation handling", () => {
    it("should skip validation for mutations", async () => {
      const document = parse(`
        mutation {
          createUser(name: "John") {
            id
            username
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "CreateUser",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      // Should skip validation for mutations
      // (based on current implementation which only validates queries and subscriptions)
    });
  });

  describe("Real-world scenarios", () => {
    it("should handle user profile query", async () => {
      const document = parse(`
        query GetUserProfile($userId: ID!) {
          user(id: $userId) {
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
                  price
                }
              }
            }
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "GetUserProfile",
        request: { http: { headers: new Map() } },
        contextValue: { userId: "user-123" },
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      const metadata = requestContext.contextValue?.complexityMetadata;
      expect(metadata).toBeDefined();
      expect(metadata?.depthValid).toBe(true);
      expect(metadata?.rateLimitPassed).toBe(true);
    });

    it("should handle league query with members", async () => {
      const document = parse(`
        query GetLeague($leagueId: ID!) {
          league(id: $leagueId) {
            id
            name
            description
            members(limit: 50) {
              id
              status
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

      const requestContext = {
        document,
        operationName: "GetLeague",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      await plugin.didResolveOperation(requestContext);

      expect(requestContext.contextValue?.complexityMetadata).toBeDefined();
    });
  });

  describe("Performance", () => {
    it("should validate query in under 100ms", async () => {
      const document = parse(`
        query {
          users(limit: 10) {
            id
            username
            wallet {
              id
            }
            squads {
              name
              players {
                id
              }
            }
          }
        }
      `);

      const requestContext = {
        document,
        operationName: "PerformanceTest",
        request: { http: { headers: new Map() } },
        contextValue: {},
        errors: undefined,
        response: { headers: new Map() },
      } as any;

      const startTime = performance.now();
      await plugin.didResolveOperation(requestContext);
      const elapsed = performance.now() - startTime;

      expect(elapsed).toBeLessThan(100);
      expect(requestContext.contextValue?.complexityMetadata?.validationTime).toBeLessThan(50);
    });

    it("should handle multiple sequential queries efficiently", async () => {
      const document = parse(`
        query {
          users(limit: 10) {
            id
          }
        }
      `);

      const startTime = performance.now();

      for (let i = 0; i < 10; i++) {
        const requestContext = {
          document,
          operationName: "Query" + i,
          request: { http: { headers: new Map() } },
          contextValue: {},
          errors: undefined,
          response: { headers: new Map() },
        } as any;

        await plugin.didResolveOperation(requestContext);
      }

      const elapsed = performance.now() - startTime;

      // Should benefit from caching
      expect(elapsed).toBeLessThan(200);
    });
  });
});
