import {
  ApolloServerPlugin,
  BaseContext,
  GraphQLRequestContext,
  GraphQLRequestListener,
} from "@apollo/server";
import { GraphQLError } from "graphql";
import {
  getComplexityConfigInstance,
  ComplexityConfig,
} from "../config/complexity.js";
import { analyzeQueryComplexity, calculateQueryDepth } from "./queryAnalyzer.js";
import { validateQueryDepth } from "./depthValidator.js";
import { ComplexityRateGovernor, createRateGovernor } from "./complexityRateGovernor.js";
import { RedisClient } from "../config/redis.js";

/**
 * GraphQL request complexity metadata attached to the operation context.
 */
export interface ComplexityMetadata {
  /** Query complexity score */
  complexity: number;

  /** Query depth */
  depth: number;

  /** Number of fields selected */
  fieldCount: number;

  /** Depth validation result */
  depthValid: boolean;

  /** Rate limit check passed */
  rateLimitPassed: boolean;

  /** Rate limit info */
  rateLimitInfo?: {
    tokens: number;
    maxTokens: number;
    retryAfter?: number;
  };

  /** Time spent validating and checking limits (ms) */
  validationTime: number;
}

/**
 * Apollo Server plugin for GraphQL query complexity checking.
 * Integrates depth validation, complexity calculation, and rate limiting.
 *
 * Hooks:
 * - didResolveOperation: Validate depth and calculate complexity
 * - willSendResponse: Log metrics (optional)
 * - didEncounterErrors: Handle complexity-related errors
 */
export function createComplexityPlugin(
  redis: RedisClient | null,
  config?: Partial<ComplexityConfig>
): ApolloServerPlugin<BaseContext> {
  const finalConfig = config ? { ...getComplexityConfigInstance(), ...config } : getComplexityConfigInstance();
  const rateGovernor = createRateGovernor(redis, finalConfig);

  return {
    async didResolveOperation(
      requestContext: GraphQLRequestContext<BaseContext>
    ): Promise<void | GraphQLRequestListener<BaseContext>> {
      // Skip if complexity checking is disabled
      if (!finalConfig.enabled) {
        return;
      }

      const { document, operationName, request } = requestContext;
      if (!document) return;
      const startTime = performance.now();

      // Only validate for queries and subscriptions, not mutations
      // (mutations have different characteristics and shouldn't be rate limited in the same way)
      const operation = document.definitions.find((def) => def.kind === "OperationDefinition") as any;
      if (!operation || (operation.operation !== "query" && operation.operation !== "subscription")) {
        return;
      }

      try {
        // Step 1: Validate query depth
        const depthResult = validateQueryDepth(document, finalConfig);
        if (!depthResult.valid) {
          (requestContext as any).errors = (requestContext as any).errors || [];
          ((requestContext as any).errors as GraphQLError[]).push(depthResult.error!);

          if (finalConfig.debugLogging) {
            console.log(
              `[Complexity] Depth validation failed for ${operationName || "anonymous"}: ${depthResult.deepestPath}`
            );
          }

          return;
        }

        // Step 2: Calculate complexity
        const complexityResult = analyzeQueryComplexity(document, finalConfig, finalConfig.enableAstCache);

        // Check if complexity calculation took too long
        if (complexityResult.calculationTime > finalConfig.calculationTimeoutMs) {
          const error = new GraphQLError(
            `Query complexity calculation exceeded timeout (${finalConfig.calculationTimeoutMs}ms). Query may be too complex.`,
            {
              extensions: {
                code: "QUERY_COMPLEXITY_CALCULATION_TIMEOUT",
                timeoutMs: finalConfig.calculationTimeoutMs,
                actualTime: complexityResult.calculationTime,
              },
            }
          );
          (requestContext as any).errors = (requestContext as any).errors || [];
          ((requestContext as any).errors as GraphQLError[]).push(error);
          return;
        }

        // Check if complexity exceeds max per query
        if (complexityResult.complexity > finalConfig.maxComplexityPerQuery) {
          const error = new GraphQLError(
            `Query complexity exceeds maximum allowed (max: ${finalConfig.maxComplexityPerQuery}, actual: ${complexityResult.complexity})`,
            {
              extensions: {
                code: "QUERY_COMPLEXITY_EXCEEDED",
                maxComplexity: finalConfig.maxComplexityPerQuery,
                actualComplexity: complexityResult.complexity,
              },
            }
          );
          (requestContext as any).errors = (requestContext as any).errors || [];
          ((requestContext as any).errors as GraphQLError[]).push(error);

          if (finalConfig.debugLogging) {
            console.log(
              `[Complexity] Query complexity exceeded for ${operationName || "anonymous"}: ${complexityResult.complexity}/${finalConfig.maxComplexityPerQuery}`
            );
          }

          return;
        }

        // Step 3: Check rate limits (per-user if authenticated, per-IP otherwise)
        let identifier: string;
        let limitType: "user" | "ip" = "ip";

        // Try to get user from context (requires passing userId in context)
        const userId = (requestContext.contextValue as any)?.userId;
        if (userId) {
          identifier = userId;
          limitType = "user";
        } else {
          // Fall back to IP address
          // Apollo Server provides the request in contextValue
          const ip =
            (request.http?.headers.get("x-forwarded-for") as string)?.split(",")[0] ||
            (request.http?.headers.get("x-real-ip") as string) ||
            "unknown";
          identifier = ip;
        }

        const rateLimitCheck = await rateGovernor.checkRateLimit(
          identifier,
          complexityResult.complexity,
          limitType
        );

        if (!rateLimitCheck.allowed) {
          (requestContext as any).errors = (requestContext as any).errors || [];
          ((requestContext as any).errors as GraphQLError[]).push(rateLimitCheck.error!);

          if (finalConfig.debugLogging) {
            console.log(
              `[Complexity] Rate limit exceeded for ${limitType} ${identifier}: ` +
                `needed ${rateLimitCheck.tokensNeeded}, have ${rateLimitCheck.currentTokens}`
            );
          }

          // Add retry-after header if we can
          if (rateLimitCheck.retryAfter && requestContext.response) {
            (requestContext.response as any).headers = (requestContext.response as any).headers || new Map();
            (requestContext.response as any).headers.set("retry-after", Math.ceil(rateLimitCheck.retryAfter).toString());
          }

          return;
        }

        // Store complexity metadata in context for later use
        const complexityMetadata: ComplexityMetadata = {
          complexity: complexityResult.complexity,
          depth: complexityResult.depth,
          fieldCount: complexityResult.fieldCount,
          depthValid: depthResult.valid,
          rateLimitPassed: true,
          rateLimitInfo: {
            tokens: rateLimitCheck.currentTokens,
            maxTokens: rateLimitCheck.maxTokens,
          },
          validationTime: performance.now() - startTime,
        };

        // Attach to context value for access in resolvers
        if (!requestContext.contextValue) {
          (requestContext as any).contextValue = {};
        }
        (requestContext.contextValue as any).complexityMetadata = complexityMetadata;

        if (finalConfig.debugLogging) {
          console.log(
            `[Complexity] Query accepted: complexity=${complexityResult.complexity}, ` +
              `depth=${complexityResult.depth}, fields=${complexityResult.fieldCount}, ` +
              `validationTime=${complexityMetadata.validationTime.toFixed(2)}ms`
          );
        }
      } catch (error) {
        console.error("[Complexity] Unexpected error during complexity validation:", error);

        // If something goes wrong, don't block the query (fail open)
        // but log the error for investigation
        if (finalConfig.debugLogging) {
          console.error("[Complexity] Error details:", error);
        }
      }
    },

    async didEncounterErrors(
      requestContext: GraphQLRequestContext<BaseContext>
    ): Promise<void> {
      // Log complexity-related errors with additional context
      if (requestContext.errors) {
        const complexityErrors = requestContext.errors.filter(
          (err) => {
            const code = typeof err.extensions?.code === "string" ? err.extensions.code : "";
            return Boolean(
              code &&
                (code.includes("COMPLEXITY") ||
                  code.includes("DEPTH") ||
                  code.includes("RATE_LIMIT"))
            );
          }
        );

        if (complexityErrors.length > 0 && finalConfig.debugLogging) {
          console.log(
            `[Complexity] ${complexityErrors.length} complexity-related errors encountered`,
            complexityErrors.map((err) => ({
              code: err.extensions?.code,
              message: err.message,
            }))
          );
        }
      }
    },
  } as unknown as ApolloServerPlugin<BaseContext>;
}

/**
 * Extract complexity metadata from context.
 * Useful in resolvers to understand query characteristics.
 */
export function getComplexityMetadata(context: any): ComplexityMetadata | undefined {
  return context?.complexityMetadata;
}

/**
 * Format complexity metadata for logging.
 */
export function formatComplexityMetadata(metadata: ComplexityMetadata): string {
  return (
    `Complexity: ${metadata.complexity}, Depth: ${metadata.depth}, ` +
    `Fields: ${metadata.fieldCount}, Validation: ${metadata.validationTime.toFixed(2)}ms`
  );
}
