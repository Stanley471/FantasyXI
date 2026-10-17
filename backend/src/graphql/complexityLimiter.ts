export interface FieldComplexityConfig {
  baseCost: number;
  isList?: boolean;
  defaultListMultiplier?: number;
}

export interface ComplexityLimiterOptions {
  maxDepth?: number;
  maxComplexity?: number;
  defaultFieldCost?: number;
  defaultListLimit?: number;
  fieldConfigs?: Record<string, FieldComplexityConfig>;
  /** Maximum complexity points a user/IP can consume per refill window */
  bucketCapacity?: number;
  /** Complexity points refilled per second */
  refillRatePerSecond?: number;
  /** Maximum concurrent active WebSocket subscriptions per user/IP */
  maxSubscriptionsPerClient?: number;
}

export interface ComplexityAnalysisResult {
  allowed: boolean;
  operationType: "query" | "mutation" | "subscription";
  depth: number;
  totalComplexity: number;
  remainingBudget?: number;
  rejectionReason?: string;
  rejectionCode?:
    | "MAX_DEPTH_EXCEEDED"
    | "MAX_COMPLEXITY_EXCEEDED"
    | "RATE_LIMIT_EXCEEDED"
    | "SUBSCRIPTION_LIMIT_EXCEEDED"
    | "SYNTAX_ERROR";
}

interface ParsedSelectionNode {
  kind: "field" | "fragmentSpread" | "inlineFragment";
  name: string;
  args: Record<string, number | string>;
  children: ParsedSelectionNode[];
}

interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_FIELD_CONFIGS: Record<string, FieldComplexityConfig> = {
  leagues: { baseCost: 2, isList: true, defaultListMultiplier: 20 },
  members: { baseCost: 2, isList: true, defaultListMultiplier: 25 },
  players: { baseCost: 2, isList: true, defaultListMultiplier: 15 },
  gameweekScores: { baseCost: 2, isList: true, defaultListMultiplier: 10 },
  transactions: { baseCost: 3, isList: true, defaultListMultiplier: 20 },
  liveLeaderboardUpdated: { baseCost: 5, isList: true, defaultListMultiplier: 10 },
  squad: { baseCost: 2 },
  team: { baseCost: 1 },
  user: { baseCost: 1 },
};

export class GraphqlComplexityLimiter {
  private readonly maxDepth: number;
  private readonly maxComplexity: number;
  private readonly defaultFieldCost: number;
  private readonly defaultListLimit: number;
  private readonly fieldConfigs: Record<string, FieldComplexityConfig>;
  private readonly bucketCapacity: number;
  private readonly refillRatePerSecond: number;
  private readonly maxSubscriptionsPerClient: number;

  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly activeSubscriptions = new Map<string, Set<string>>();

  constructor(options: ComplexityLimiterOptions = {}) {
    this.maxDepth = options.maxDepth ?? 7;
    this.maxComplexity = options.maxComplexity ?? 1000;
    this.defaultFieldCost = options.defaultFieldCost ?? 1;
    this.defaultListLimit = options.defaultListLimit ?? 20;
    this.fieldConfigs = {
      ...DEFAULT_FIELD_CONFIGS,
      ...(options.fieldConfigs ?? {}),
    };
    this.bucketCapacity = options.bucketCapacity ?? 2500;
    this.refillRatePerSecond = options.refillRatePerSecond ?? 100;
    this.maxSubscriptionsPerClient = options.maxSubscriptionsPerClient ?? 5;
  }

  /**
   * Analyzes a GraphQL document string (supporting queries, mutations, subscriptions,
   * arguments, inline fragments, and named fragment definitions), computing both
   * maximum AST nesting depth and pagination-multiplied complexity cost.
   */
  public analyzeQuery(
    query: string,
    variables: Record<string, unknown> = {}
  ): ComplexityAnalysisResult {
    let parsed: {
      operationType: "query" | "mutation" | "subscription";
      rootSelections: ParsedSelectionNode[];
      fragments: Map<string, ParsedSelectionNode[]>;
    };

    try {
      parsed = this.parseGraphqlDocument(query, variables);
    } catch (err) {
      return {
        allowed: false,
        operationType: "query",
        depth: 0,
        totalComplexity: 0,
        rejectionReason:
          err instanceof Error ? err.message : "Invalid GraphQL query syntax",
        rejectionCode: "SYNTAX_ERROR",
      };
    }

    const visitedFragments = new Set<string>();
    const { maxDepth, complexity } = this.evaluateSelections(
      parsed.rootSelections,
      parsed.fragments,
      1,
      1,
      visitedFragments
    );

    if (maxDepth > this.maxDepth) {
      return {
        allowed: false,
        operationType: parsed.operationType,
        depth: maxDepth,
        totalComplexity: complexity,
        rejectionReason: `Query depth ${maxDepth} exceeds maximum allowed depth of ${this.maxDepth}`,
        rejectionCode: "MAX_DEPTH_EXCEEDED",
      };
    }

    if (complexity > this.maxComplexity) {
      return {
        allowed: false,
        operationType: parsed.operationType,
        depth: maxDepth,
        totalComplexity: complexity,
        rejectionReason: `Query complexity ${complexity} exceeds maximum allowed complexity of ${this.maxComplexity}`,
        rejectionCode: "MAX_COMPLEXITY_EXCEEDED",
      };
    }

    return {
      allowed: true,
      operationType: parsed.operationType,
      depth: maxDepth,
      totalComplexity: complexity,
    };
  }

  /**
   * Validates a GraphQL operation and deducts its complexity cost from the client's
   * token bucket (and registers active WebSocket subscriptions when applicable).
   */
  public enforceOperation(params: {
    clientId: string;
    query: string;
    variables?: Record<string, unknown>;
    subscriptionId?: string;
    nowMs?: number;
  }): ComplexityAnalysisResult {
    const nowMs = params.nowMs ?? Date.now();
    const analysis = this.analyzeQuery(params.query, params.variables ?? {});
    if (!analysis.allowed) {
      return analysis;
    }

    if (analysis.operationType === "subscription") {
      const clientSubs =
        this.activeSubscriptions.get(params.clientId) ?? new Set<string>();
      const subId = params.subscriptionId ?? `sub-${nowMs}-${clientSubs.size + 1}`;
      if (
        !clientSubs.has(subId) &&
        clientSubs.size >= this.maxSubscriptionsPerClient
      ) {
        return {
          ...analysis,
          allowed: false,
          rejectionReason: `Client ${params.clientId} exceeded max concurrent subscriptions (${this.maxSubscriptionsPerClient})`,
          rejectionCode: "SUBSCRIPTION_LIMIT_EXCEEDED",
        };
      }
    }

    // Refill and check token bucket
    const bucket = this.getOrRefillBucket(params.clientId, nowMs);
    if (bucket.tokens < analysis.totalComplexity) {
      return {
        ...analysis,
        allowed: false,
        remainingBudget: Math.floor(bucket.tokens),
        rejectionReason: `Complexity rate limit exceeded for ${params.clientId}: required ${analysis.totalComplexity}, available ${Math.floor(bucket.tokens)}`,
        rejectionCode: "RATE_LIMIT_EXCEEDED",
      };
    }

    bucket.tokens -= analysis.totalComplexity;

    if (analysis.operationType === "subscription") {
      let clientSubs = this.activeSubscriptions.get(params.clientId);
      if (!clientSubs) {
        clientSubs = new Set<string>();
        this.activeSubscriptions.set(params.clientId, clientSubs);
      }
      clientSubs.add(
        params.subscriptionId ?? `sub-${nowMs}-${clientSubs.size + 1}`
      );
    }

    return {
      ...analysis,
      remainingBudget: Math.floor(bucket.tokens),
    };
  }

  public releaseSubscription(clientId: string, subscriptionId: string): void {
    const subs = this.activeSubscriptions.get(clientId);
    if (subs) {
      subs.delete(subscriptionId);
      if (subs.size === 0) {
        this.activeSubscriptions.delete(clientId);
      }
    }
  }

  public getActiveSubscriptionCount(clientId: string): number {
    return this.activeSubscriptions.get(clientId)?.size ?? 0;
  }

  private getOrRefillBucket(clientId: string, nowMs: number): TokenBucketState {
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = {
        tokens: this.bucketCapacity,
        lastRefillMs: nowMs,
      };
      this.buckets.set(clientId, bucket);
      return bucket;
    }

    const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(
        this.bucketCapacity,
        bucket.tokens + elapsedSec * this.refillRatePerSecond
      );
      bucket.lastRefillMs = nowMs;
    }

    return bucket;
  }

  private evaluateSelections(
    selections: ParsedSelectionNode[],
    fragments: Map<string, ParsedSelectionNode[]>,
    currentDepth: number,
    parentMultiplier: number,
    visitedFragments: Set<string>
  ): { maxDepth: number; complexity: number } {
    let maxObservedDepth = 0;
    let totalComplexity = 0;

    for (const node of selections) {
      if (node.kind === "fragmentSpread") {
        if (visitedFragments.has(node.name)) {
          continue;
        }
        const fragNodes = fragments.get(node.name);
        if (fragNodes) {
          const nextVisited = new Set(visitedFragments);
          nextVisited.add(node.name);
          const sub = this.evaluateSelections(
            fragNodes,
            fragments,
            currentDepth,
            parentMultiplier,
            nextVisited
          );
          if (sub.maxDepth > maxObservedDepth) maxObservedDepth = sub.maxDepth;
          totalComplexity += sub.complexity;
        }
        continue;
      }

      if (node.kind === "inlineFragment") {
        const sub = this.evaluateSelections(
          node.children,
          fragments,
          currentDepth,
          parentMultiplier,
          visitedFragments
        );
        if (sub.maxDepth > maxObservedDepth) maxObservedDepth = sub.maxDepth;
        totalComplexity += sub.complexity;
        continue;
      }

      // Standard field node
      const config = this.fieldConfigs[node.name];
      const baseCost = config?.baseCost ?? this.defaultFieldCost;
      const explicitLimit =
        typeof node.args.first === "number"
          ? node.args.first
          : typeof node.args.limit === "number"
          ? node.args.limit
          : typeof node.args.take === "number"
          ? node.args.take
          : undefined;

      const listFactor =
        explicitLimit !== undefined
          ? Math.max(1, explicitLimit)
          : config?.isList
          ? config.defaultListMultiplier ?? this.defaultListLimit
          : 1;

      const effectiveMultiplier = parentMultiplier * listFactor;
      const fieldOwnCost = baseCost * effectiveMultiplier;
      totalComplexity += fieldOwnCost;

      if (currentDepth > maxObservedDepth) {
        maxObservedDepth = currentDepth;
      }

      if (node.children.length > 0) {
        const childEval = this.evaluateSelections(
          node.children,
          fragments,
          currentDepth + 1,
          effectiveMultiplier,
          visitedFragments
        );
        if (childEval.maxDepth > maxObservedDepth) {
          maxObservedDepth = childEval.maxDepth;
        }
        totalComplexity += childEval.complexity;
      }
    }

    return { maxDepth: maxObservedDepth, complexity: totalComplexity };
  }

  private parseGraphqlDocument(
    source: string,
    variables: Record<string, unknown>
  ): {
    operationType: "query" | "mutation" | "subscription";
    rootSelections: ParsedSelectionNode[];
    fragments: Map<string, ParsedSelectionNode[]>;
  } {
    const cleaned = source.replace(/#[^\n]*/g, "").trim();
    if (!cleaned) {
      throw new Error("Empty GraphQL document");
    }

    const fragments = new Map<string, ParsedSelectionNode[]>();
    let operationType: "query" | "mutation" | "subscription" = "query";
    let rootSelections: ParsedSelectionNode[] = [];

    // Tokenize braces, parens, identifiers, spreads
    let pos = 0;
    const len = cleaned.length;

    const skipWs = () => {
      while (pos < len && /[\s,]/.test(cleaned[pos])) pos++;
    };

    const readIdent = (): string => {
      skipWs();
      const start = pos;
      while (pos < len && /[A-Za-z0-9_$.]/.test(cleaned[pos])) pos++;
      return cleaned.slice(start, pos);
    };

    const parseArgs = (): Record<string, number | string> => {
      const args: Record<string, number | string> = {};
      skipWs();
      if (cleaned[pos] !== "(") return args;
      pos++; // skip '('
      while (pos < len && cleaned[pos] !== ")") {
        skipWs();
        if (cleaned[pos] === ")") break;
        const argName = readIdent();
        skipWs();
        if (cleaned[pos] === ":") pos++;
        skipWs();
        let rawVal = "";
        if (cleaned[pos] === '"') {
          pos++;
          const start = pos;
          while (pos < len && cleaned[pos] !== '"') pos++;
          rawVal = cleaned.slice(start, pos);
          if (cleaned[pos] === '"') pos++;
          args[argName] = rawVal;
        } else {
          rawVal = readIdent();
          if (rawVal.startsWith("$")) {
            const varName = rawVal.slice(1);
            const resolved = variables[varName];
            if (typeof resolved === "number" || typeof resolved === "string") {
              args[argName] = resolved;
            }
          } else {
            const num = Number(rawVal);
            args[argName] = Number.isFinite(num) && rawVal !== "" ? num : rawVal;
          }
        }
        skipWs();
      }
      if (cleaned[pos] === ")") pos++;
      return args;
    };

    const skipBalancedParens = () => {
      skipWs();
      if (cleaned[pos] !== "(") return;
      let depth = 0;
      while (pos < len) {
        if (cleaned[pos] === "(") depth++;
        else if (cleaned[pos] === ")") {
          depth--;
          if (depth === 0) {
            pos++;
            return;
          }
        }
        pos++;
      }
    };

    const parseSelectionBlock = (): ParsedSelectionNode[] => {
      skipWs();
      if (cleaned[pos] !== "{") {
        throw new Error(`Expected '{' at position ${pos}`);
      }
      pos++; // skip '{'
      const nodes: ParsedSelectionNode[] = [];

      while (pos < len) {
        skipWs();
        if (pos >= len) {
          throw new Error("Unclosed '{' in GraphQL selection set");
        }
        if (cleaned[pos] === "}") {
          pos++;
          return nodes;
        }

        if (cleaned.startsWith("...", pos)) {
          pos += 3;
          skipWs();
          const token = readIdent();
          if (token === "on") {
            const typeCondition = readIdent();
            const children = parseSelectionBlock();
            nodes.push({
              kind: "inlineFragment",
              name: typeCondition,
              args: {},
              children,
            });
          } else {
            nodes.push({
              kind: "fragmentSpread",
              name: token,
              args: {},
              children: [],
            });
          }
          continue;
        }

        let fieldOrAlias = readIdent();
        if (!fieldOrAlias) {
          throw new Error(`Unexpected token '${cleaned[pos]}' at position ${pos}`);
        }
        skipWs();
        // Handle alias: actualField
        if (cleaned[pos] === ":") {
          pos++;
          fieldOrAlias = readIdent();
        }

        const args = parseArgs();
        skipWs();
        // Skip optional directives (@include / @skip)
        while (cleaned[pos] === "@") {
          pos++;
          readIdent();
          skipBalancedParens();
          skipWs();
        }

        let children: ParsedSelectionNode[] = [];
        if (cleaned[pos] === "{") {
          children = parseSelectionBlock();
        }

        nodes.push({
          kind: "field",
          name: fieldOrAlias,
          args,
          children,
        });
      }

      throw new Error("Unclosed GraphQL selection block");
    };

    while (pos < len) {
      skipWs();
      if (pos >= len) break;

      if (cleaned[pos] === "{") {
        rootSelections = parseSelectionBlock();
        continue;
      }

      const keyword = readIdent();
      if (
        keyword === "query" ||
        keyword === "mutation" ||
        keyword === "subscription"
      ) {
        operationType = keyword;
        skipWs();
        if (cleaned[pos] !== "{" && cleaned[pos] !== "(") {
          readIdent(); // operation name
        }
        skipBalancedParens(); // variable definitions
        rootSelections = parseSelectionBlock();
      } else if (keyword === "fragment") {
        const fragName = readIdent();
        const onKw = readIdent(); // 'on'
        if (onKw === "on") {
          readIdent(); // TypeName
        }
        const fragSelections = parseSelectionBlock();
        fragments.set(fragName, fragSelections);
      } else {
        throw new Error(`Unexpected top-level keyword: ${keyword}`);
      }
    }

    return { operationType, rootSelections, fragments };
  }
}

export const graphqlComplexityLimiter = new GraphqlComplexityLimiter();
