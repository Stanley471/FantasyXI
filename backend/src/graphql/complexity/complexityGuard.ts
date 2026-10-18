import type { Request } from "express";
import { ApolloServerPlugin, HeaderMap } from "@apollo/server";
import { DocumentNode, GraphQLError, GraphQLSchema, OperationTypeNode } from "graphql";
import { verifyAccessToken } from "../../config/jwt.js";
import {
  analyzeOperation,
  getQueryComplexityConfig,
  OperationNotFoundError,
  QueryComplexityConfig,
  QueryComplexityResult,
} from "./queryComplexity.js";
import { ComplexityRateGovernor } from "./complexityRateGovernor.js";

/**
 * Transport-agnostic enforcement of the complexity/depth limits and the
 * complexity token bucket (issue #265).
 *
 * `evaluateOperation` is the single decision point. The Apollo plugin calls it
 * for HTTP queries and mutations in `didResolveOperation` (after parsing and
 * validation, before execution). `SubscriptionComplexityGuard` calls it from a
 * WebSocket transport's subscribe hook (e.g. graphql-ws `onSubscribe`) and also
 * caps the total cost of a client's concurrently active subscriptions, since a
 * subscription keeps costing server resources for as long as it is open.
 */

export const COMPLEXITY_ERROR_CODES = {
  TOO_DEEP: "QUERY_TOO_DEEP",
  TOO_COMPLEX: "QUERY_TOO_COMPLEX",
  RATE_LIMITED: "COMPLEXITY_RATE_LIMITED",
  SUBSCRIPTION_QUOTA: "SUBSCRIPTION_COMPLEXITY_QUOTA_EXCEEDED",
} as const;

export interface ComplexityGuardOptions {
  config?: QueryComplexityConfig;
  governor?: ComplexityRateGovernor;
}

export type OperationDecision =
  | { allowed: true; analysis: QueryComplexityResult; remainingBudget: number | null }
  | { allowed: false; error: GraphQLError; analysis: QueryComplexityResult | null };

function rejection(
  message: string,
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers?: HeaderMap
): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code,
      ...extra,
      http: headers ? { status, headers } : { status },
    },
  });
}

export async function evaluateOperation(
  params: {
    schema: GraphQLSchema;
    document: DocumentNode;
    operationName?: string | null;
    variables?: Record<string, unknown> | null;
    clientKey: string;
  },
  options: ComplexityGuardOptions = {}
): Promise<OperationDecision> {
  const config = options.config ?? getQueryComplexityConfig();

  let analysis: QueryComplexityResult;
  try {
    analysis = analyzeOperation({ ...params, config });
  } catch (err) {
    if (err instanceof OperationNotFoundError) {
      return {
        allowed: false,
        analysis: null,
        error: rejection(err.message, "BAD_REQUEST", 400),
      };
    }
    throw err;
  }

  const depthViolation = analysis.violations.find((v) => v.code === "QUERY_TOO_DEEP");
  if (depthViolation) {
    return {
      allowed: false,
      analysis,
      error: rejection(
        `Query depth ${depthViolation.actual} exceeds the maximum allowed depth of ${depthViolation.limit}`,
        COMPLEXITY_ERROR_CODES.TOO_DEEP,
        400,
        { depth: depthViolation.actual, maxDepth: depthViolation.limit }
      ),
    };
  }

  const complexityViolation = analysis.violations.find((v) => v.code === "QUERY_TOO_COMPLEX");
  if (complexityViolation) {
    return {
      allowed: false,
      analysis,
      error: rejection(
        `Query complexity ${complexityViolation.actual} exceeds the maximum allowed complexity of ${complexityViolation.limit}`,
        COMPLEXITY_ERROR_CODES.TOO_COMPLEX,
        400,
        { complexity: complexityViolation.actual, maxComplexity: complexityViolation.limit }
      ),
    };
  }

  if (!options.governor) {
    return { allowed: true, analysis, remainingBudget: null };
  }

  const decision = await options.governor.consume(params.clientKey, analysis.complexity);
  if (!decision.allowed) {
    const retryAfterSeconds = Number.isFinite(decision.retryAfterMs)
      ? Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      : null;
    const headers = new HeaderMap();
    if (retryAfterSeconds !== null) headers.set("retry-after", String(retryAfterSeconds));
    return {
      allowed: false,
      analysis,
      error: rejection(
        "Query complexity budget exhausted. Slow down or request fewer fields.",
        COMPLEXITY_ERROR_CODES.RATE_LIMITED,
        429,
        { complexity: analysis.complexity, retryAfterSeconds },
        headers
      ),
    };
  }

  return { allowed: true, analysis, remainingBudget: decision.remaining };
}

/** Context fields the plugin reads; the server sets `clientKey` per request. */
export interface ComplexityContext {
  clientKey?: string;
}

/**
 * Apollo Server plugin rejecting over-limit operations before execution.
 * Over-depth / over-complexity operations get HTTP 400; an exhausted budget
 * gets HTTP 429 with Retry-After.
 */
export function createQueryComplexityPlugin<TContext extends ComplexityContext>(
  options: ComplexityGuardOptions = {}
): ApolloServerPlugin<TContext> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation(requestContext) {
          if (!requestContext.document) return;
          const decision = await evaluateOperation(
            {
              schema: requestContext.schema,
              document: requestContext.document,
              operationName: requestContext.operationName ?? requestContext.request.operationName,
              variables: requestContext.request.variables,
              clientKey: requestContext.contextValue.clientKey ?? "anonymous",
            },
            options
          );
          if (!decision.allowed) throw decision.error;
          if (decision.analysis) {
            requestContext.response.http.headers.set(
              "x-graphql-complexity",
              String(decision.analysis.complexity)
            );
          }
        },
      };
    },
  };
}

export interface SubscriptionGuardOptions extends ComplexityGuardOptions {
  /** Maximum summed complexity of one client's open subscriptions. */
  maxActiveComplexity?: number;
}

/**
 * Admission control for GraphQL subscriptions. Wire `onSubscribe` /
 * `onComplete` into the WebSocket transport's lifecycle hooks: a non-null
 * result from `onSubscribe` must reject (or terminate) the subscription.
 */
export class SubscriptionComplexityGuard {
  private readonly active = new Map<string, Map<string, number>>();
  public readonly maxActiveComplexity: number;

  constructor(private readonly options: SubscriptionGuardOptions = {}) {
    const fromEnv = Number.parseInt(process.env.GRAPHQL_MAX_ACTIVE_SUBSCRIPTION_COMPLEXITY || "", 10);
    this.maxActiveComplexity =
      options.maxActiveComplexity ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 2000);
  }

  public activeComplexity(clientKey: string): number {
    let total = 0;
    for (const cost of this.active.get(clientKey)?.values() ?? []) total += cost;
    return total;
  }

  public async onSubscribe(params: {
    clientKey: string;
    subscriptionId: string;
    schema: GraphQLSchema;
    document: DocumentNode;
    operationName?: string | null;
    variables?: Record<string, unknown> | null;
  }): Promise<GraphQLError | null> {
    const decision = await evaluateOperation(params, this.options);
    if (!decision.allowed) return decision.error;

    const cost = decision.analysis.complexity;
    if (decision.analysis.operationType !== OperationTypeNode.SUBSCRIPTION) return null;

    const projected = this.activeComplexity(params.clientKey) + cost;
    if (projected > this.maxActiveComplexity) {
      return rejection(
        `Active subscription complexity ${projected} would exceed the quota of ${this.maxActiveComplexity}`,
        COMPLEXITY_ERROR_CODES.SUBSCRIPTION_QUOTA,
        429,
        { complexity: cost, activeComplexity: projected - cost, quota: this.maxActiveComplexity }
      );
    }

    const subscriptions = this.active.get(params.clientKey) ?? new Map<string, number>();
    subscriptions.set(params.subscriptionId, cost);
    this.active.set(params.clientKey, subscriptions);
    return null;
  }

  /** Releases a finished subscription's share of the client's quota. */
  public onComplete(clientKey: string, subscriptionId: string): void {
    const subscriptions = this.active.get(clientKey);
    if (!subscriptions) return;
    subscriptions.delete(subscriptionId);
    if (subscriptions.size === 0) this.active.delete(clientKey);
  }

  /** Releases everything a client held, e.g. when its socket closes. */
  public onDisconnect(clientKey: string): void {
    this.active.delete(clientKey);
  }
}

/**
 * Budget identity for a request: the authenticated user when a valid bearer
 * token is present (so users behind one NAT do not share a budget), else the
 * client IP. An invalid token falls back to the IP rather than failing here;
 * resolvers still enforce authentication on their own.
 */
export function resolveGraphqlClientKey(req: Pick<Request, "headers" | "ip">): string {
  const header = req.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try {
      const payload = verifyAccessToken(header.slice("Bearer ".length).trim());
      if (payload.userId) return `user:${payload.userId}`;
    } catch {
      // Fall through to the IP-based key
    }
  }
  return `ip:${req.ip ?? "unknown"}`;
}
