import dotenv from "dotenv";

dotenv.config();

/**
 * Field complexity weights used in complexity calculation.
 * Each field type has an associated cost based on its typical resolution cost.
 */
export interface FieldWeights {
  [fieldName: string]: number;
}

/**
 * GraphQL complexity configuration for query analysis and rate limiting.
 * Provides sensible defaults that can be overridden via environment variables.
 */
export interface ComplexityConfig {
  /** Enable/disable complexity checking entirely */
  enabled: boolean;

  /** Maximum allowed query depth (nesting level) */
  maxDepth: number;

  /** Maximum complexity score per query */
  maxComplexityPerQuery: number;

  /** Base complexity score for simple scalar fields */
  defaultFieldWeight: number;

  /** Complexity multiplier for list fields */
  listFieldWeight: number;

  /** Complexity multiplier for object fields */
  objectFieldWeight: number;

  /** Default pagination multiplier when no limit is specified */
  defaultPaginationMultiplier: number;

  /** Maximum pagination multiplier (cap on first/last/limit arguments) */
  maxPaginationMultiplier: number;

  /** Per-user rate limit: max complexity points per minute */
  complexityRateLimitPerMinute: number;

  /** Per-IP rate limit: max complexity points per minute */
  ipRateLimitPerMinute: number;

  /** Burst allowance multiplier (e.g., 1.5 = 150% of rate limit) */
  burstMultiplier: number;

  /** Maximum time (ms) allowed for complexity calculation before rejecting query */
  calculationTimeoutMs: number;

  /** Field-specific complexity weights (overrides defaults) */
  fieldWeights: FieldWeights;

  /** Enable detailed logging for complexity analysis */
  debugLogging: boolean;

  /** Use Redis for distributed rate limiting (falls back to in-memory if disabled) */
  useRedis: boolean;

  /** TTL in seconds for complexity rate limit tokens in Redis */
  redisTokenTTL: number;

  /** Enable caching of AST complexity calculations */
  enableAstCache: boolean;

  /** Maximum number of cached AST analyses to keep in memory */
  astCacheMaxSize: number;
}

/**
 * Get complexity configuration from environment variables and defaults.
 */
export function getComplexityConfig(): ComplexityConfig {
  const enabled = process.env.GQL_COMPLEXITY_ENABLED !== "false";
  const maxDepth = parseInt(process.env.GQL_MAX_DEPTH || "10", 10);
  const maxComplexityPerQuery = parseInt(process.env.GQL_MAX_COMPLEXITY || "5000", 10);
  const defaultFieldWeight = parseInt(process.env.GQL_DEFAULT_FIELD_WEIGHT || "1", 10);
  const listFieldWeight = parseInt(process.env.GQL_LIST_FIELD_WEIGHT || "5", 10);
  const objectFieldWeight = parseInt(process.env.GQL_OBJECT_FIELD_WEIGHT || "2", 10);
  const defaultPaginationMultiplier = parseInt(
    process.env.GQL_DEFAULT_PAGINATION_MULTIPLIER || "1",
    10
  );
  const maxPaginationMultiplier = parseInt(
    process.env.GQL_MAX_PAGINATION_MULTIPLIER || "1000",
    10
  );
  const complexityRateLimitPerMinute = parseInt(
    process.env.GQL_COMPLEXITY_RATE_LIMIT || "10000",
    10
  );
  const ipRateLimitPerMinute = parseInt(process.env.GQL_IP_RATE_LIMIT || "50000", 10);
  const burstMultiplier = parseFloat(process.env.GQL_BURST_MULTIPLIER || "1.5");
  const calculationTimeoutMs = parseInt(
    process.env.GQL_COMPLEXITY_CALCULATION_TIMEOUT_MS || "50",
    10
  );
  const debugLogging = process.env.GQL_COMPLEXITY_DEBUG === "true";
  const useRedis = process.env.GQL_COMPLEXITY_USE_REDIS !== "false";
  const redisTokenTTL = parseInt(process.env.GQL_COMPLEXITY_REDIS_TTL || "60", 10);
  const enableAstCache = process.env.GQL_COMPLEXITY_ENABLE_AST_CACHE !== "false";
  const astCacheMaxSize = parseInt(process.env.GQL_COMPLEXITY_AST_CACHE_SIZE || "1000", 10);

  return {
    enabled,
    maxDepth,
    maxComplexityPerQuery,
    defaultFieldWeight,
    listFieldWeight,
    objectFieldWeight,
    defaultPaginationMultiplier,
    maxPaginationMultiplier,
    complexityRateLimitPerMinute,
    ipRateLimitPerMinute,
    burstMultiplier,
    calculationTimeoutMs,
    fieldWeights: getFieldWeights(),
    debugLogging,
    useRedis,
    redisTokenTTL,
    enableAstCache,
    astCacheMaxSize,
  };
}

/**
 * Get field-specific complexity weights from environment or use defaults.
 * Format: GQL_FIELD_WEIGHT_<TYPENAME_FIELDNAME>=<weight>
 * Example: GQL_FIELD_WEIGHT_QUERY_USERS=10
 */
function getFieldWeights(): FieldWeights {
  const fieldWeights: FieldWeights = {
    // Query root fields
    "Query.users": 3,
    "Query.user": 1,
    "Query.players": 3,
    "Query.player": 1,
    "Query.leagues": 4,
    "Query.league": 2,

    // User type fields
    "User.id": 0,
    "User.username": 0,
    "User.name": 0,
    "User.countryCode": 0,
    "User.wallet": 1,
    "User.squads": 5,
    "User.createdLeagues": 5,

    // Wallet type fields
    "Wallet.id": 0,
    "Wallet.stellarAddress": 0,

    // Team type fields
    "Team.id": 0,
    "Team.name": 0,
    "Team.shortName": 0,

    // Player type fields
    "Player.id": 0,
    "Player.fplId": 0,
    "Player.displayName": 0,
    "Player.position": 0,
    "Player.price": 0,
    "Player.totalPoints": 0,
    "Player.team": 2,

    // Squad type fields
    "Squad.id": 0,
    "Squad.name": 0,
    "Squad.totalPoints": 0,
    "Squad.budgetRemaining": 0,
    "Squad.players": 8,

    // SquadPlayer type fields
    "SquadPlayer.id": 0,
    "SquadPlayer.player": 2,
    "SquadPlayer.isCaptain": 0,
    "SquadPlayer.isViceCaptain": 0,
    "SquadPlayer.isStarter": 0,
    "SquadPlayer.positionOrder": 0,

    // League type fields
    "League.id": 0,
    "League.name": 0,
    "League.description": 0,
    "League.status": 0,
    "League.scoringType": 0,
    "League.currentMembers": 0,
    "League.members": 10,
    "League.creator": 2,

    // LeagueMember type fields
    "LeagueMember.id": 0,
    "LeagueMember.status": 0,
    "LeagueMember.totalPoints": 0,
    "LeagueMember.rank": 0,
    "LeagueMember.user": 2,
    "LeagueMember.squad": 5,
  };

  // Override with environment variables
  const envVars = process.env;
  for (const [key, value] of Object.entries(envVars)) {
    if (key.startsWith("GQL_FIELD_WEIGHT_")) {
      const fieldPath = key.replace("GQL_FIELD_WEIGHT_", "");
      const weight = parseInt(value ?? "", 10);
      if (!isNaN(weight)) {
        fieldWeights[fieldPath] = weight;
      }
    }
  }

  return fieldWeights;
}

/**
 * Get the complexity weight for a field given its typename and field name.
 * Falls back to default weights based on field type.
 */
export function getFieldWeight(
  typename: string | undefined,
  fieldName: string,
  isListField: boolean,
  config: ComplexityConfig
): number {
  // First check for field-specific weight
  const fieldPath = typename ? `${typename}.${fieldName}` : fieldName;
  if (config.fieldWeights[fieldPath] !== undefined) {
    return config.fieldWeights[fieldPath];
  }

  // Fallback to defaults
  if (isListField) {
    return config.listFieldWeight;
  }

  return config.defaultFieldWeight;
}

/**
 * Parse pagination multiplier from query arguments.
 * Looks for common pagination args: first, last, limit, take.
 */
export function getPaginationMultiplier(
  args: Record<string, unknown> | undefined,
  config: ComplexityConfig
): number {
  if (!args) {
    return config.defaultPaginationMultiplier;
  }

  // Check for common pagination arguments
  const pagination = args.first || args.last || args.limit || args.take;

  if (typeof pagination === "number") {
    return Math.min(Math.max(pagination, 1), config.maxPaginationMultiplier);
  }

  return config.defaultPaginationMultiplier;
}

// Export singleton instance
let configInstance: ComplexityConfig | null = null;

/**
 * Get or create the singleton complexity configuration instance.
 */
export function getComplexityConfigInstance(): ComplexityConfig {
  if (!configInstance) {
    configInstance = getComplexityConfig();
  }
  return configInstance;
}

/**
 * Reset the singleton configuration (useful for testing).
 */
export function resetComplexityConfig(): void {
  configInstance = null;
}
