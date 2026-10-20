export type CallerTier = "anonymous" | "authenticated" | "webhook";

export type RouteGroupName =
  | "players"
  | "fixtures"
  | "leagues"
  | "leaderboard"
  | "live"
  | "teams"
  | "gameweeks"
  | "analytics"
  | "webhooks"
  | "default";

export type FallbackBehavior = "conservative" | "fail-open";

export interface TierThresholds {
  anonymous: number;
  authenticated: number;
  webhook: number;
}

export interface RouteGroupRateLimitConfig {
  group: RouteGroupName;
  windowMs: number;
  limits: TierThresholds;
  message?: string;
}

export interface RateLimitGatewayConfig {
  enabled: boolean;
  keyPrefix: string;
  fallbackBehavior: FallbackBehavior;
  /**
   * Multiplier applied to route limits when Redis is unreachable and
   * fallbackBehavior is "conservative" (e.g., 0.5 = 50% of normal limit).
   */
  conservativeFallbackRatio: number;
  routeGroups: Record<RouteGroupName, RouteGroupRateLimitConfig>;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function loadRateLimitGatewayConfig(
  overrides?: Partial<RateLimitGatewayConfig>
): RateLimitGatewayConfig {
  const fallbackEnv = (process.env.RATE_LIMIT_FALLBACK_MODE || "conservative").toLowerCase();
  const fallbackBehavior: FallbackBehavior =
    fallbackEnv === "fail-open" ? "fail-open" : "conservative";

  const defaultRouteGroups: Record<RouteGroupName, RouteGroupRateLimitConfig> = {
    players: {
      group: "players",
      windowMs: envPositiveInt("RATE_LIMIT_PLAYERS_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_PLAYERS_ANONYMOUS_MAX", 60),
        authenticated: envPositiveInt("RATE_LIMIT_PLAYERS_AUTHENTICATED_MAX", 180),
        webhook: envPositiveInt("RATE_LIMIT_PLAYERS_WEBHOOK_MAX", 300),
      },
      message: "Too many player stats requests. Please slow down.",
    },
    fixtures: {
      group: "fixtures",
      windowMs: envPositiveInt("RATE_LIMIT_FIXTURES_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_FIXTURES_ANONYMOUS_MAX", 60),
        authenticated: envPositiveInt("RATE_LIMIT_FIXTURES_AUTHENTICATED_MAX", 180),
        webhook: envPositiveInt("RATE_LIMIT_FIXTURES_WEBHOOK_MAX", 300),
      },
      message: "Too many fixture data requests. Please slow down.",
    },
    leagues: {
      group: "leagues",
      windowMs: envPositiveInt("RATE_LIMIT_LEAGUES_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_LEAGUES_ANONYMOUS_MAX", 45),
        authenticated: envPositiveInt("RATE_LIMIT_LEAGUES_AUTHENTICATED_MAX", 150),
        webhook: envPositiveInt("RATE_LIMIT_LEAGUES_WEBHOOK_MAX", 240),
      },
      message: "Too many league standings requests. Please slow down.",
    },
    leaderboard: {
      group: "leaderboard",
      windowMs: envPositiveInt("RATE_LIMIT_LEADERBOARD_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_LEADERBOARD_ANONYMOUS_MAX", 45),
        authenticated: envPositiveInt("RATE_LIMIT_LEADERBOARD_AUTHENTICATED_MAX", 150),
        webhook: envPositiveInt("RATE_LIMIT_LEADERBOARD_WEBHOOK_MAX", 240),
      },
      message: "Too many leaderboard requests. Please slow down.",
    },
    live: {
      group: "live",
      windowMs: envPositiveInt("RATE_LIMIT_LIVE_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_LIVE_ANONYMOUS_MAX", 40),
        authenticated: envPositiveInt("RATE_LIMIT_LIVE_AUTHENTICATED_MAX", 160),
        webhook: envPositiveInt("RATE_LIMIT_LIVE_WEBHOOK_MAX", 300),
      },
      message: "Too many live matchday requests. Please slow down.",
    },
    teams: {
      group: "teams",
      windowMs: envPositiveInt("RATE_LIMIT_TEAMS_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_TEAMS_ANONYMOUS_MAX", 60),
        authenticated: envPositiveInt("RATE_LIMIT_TEAMS_AUTHENTICATED_MAX", 180),
        webhook: envPositiveInt("RATE_LIMIT_TEAMS_WEBHOOK_MAX", 240),
      },
      message: "Too many team data requests. Please slow down.",
    },
    gameweeks: {
      group: "gameweeks",
      windowMs: envPositiveInt("RATE_LIMIT_GAMEWEEKS_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_GAMEWEEKS_ANONYMOUS_MAX", 60),
        authenticated: envPositiveInt("RATE_LIMIT_GAMEWEEKS_AUTHENTICATED_MAX", 180),
        webhook: envPositiveInt("RATE_LIMIT_GAMEWEEKS_WEBHOOK_MAX", 240),
      },
      message: "Too many gameweek requests. Please slow down.",
    },
    analytics: {
      group: "analytics",
      windowMs: envPositiveInt("RATE_LIMIT_ANALYTICS_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_ANALYTICS_ANONYMOUS_MAX", 30),
        authenticated: envPositiveInt("RATE_LIMIT_ANALYTICS_AUTHENTICATED_MAX", 120),
        webhook: envPositiveInt("RATE_LIMIT_ANALYTICS_WEBHOOK_MAX", 200),
      },
      message: "Too many analytics requests. Please slow down.",
    },
    webhooks: {
      group: "webhooks",
      windowMs: envPositiveInt("RATE_LIMIT_WEBHOOKS_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_WEBHOOKS_ANONYMOUS_MAX", 30),
        authenticated: envPositiveInt("RATE_LIMIT_WEBHOOKS_AUTHENTICATED_MAX", 120),
        webhook: envPositiveInt("RATE_LIMIT_WEBHOOKS_WEBHOOK_MAX", 300),
      },
      message: "Too many webhook requests. Please slow down.",
    },
    default: {
      group: "default",
      windowMs: envPositiveInt("RATE_LIMIT_DEFAULT_WINDOW_MS", 60_000),
      limits: {
        anonymous: envPositiveInt("RATE_LIMIT_DEFAULT_ANONYMOUS_MAX", 100),
        authenticated: envPositiveInt("RATE_LIMIT_DEFAULT_AUTHENTICATED_MAX", 200),
        webhook: envPositiveInt("RATE_LIMIT_DEFAULT_WEBHOOK_MAX", 300),
      },
      message: "Too many API requests from this client. Please try again later.",
    },
  };

  return {
    enabled: process.env.SLIDING_RATE_LIMIT_ENABLED !== "false",
    keyPrefix: process.env.RATE_LIMIT_REDIS_PREFIX || "rl:sw",
    fallbackBehavior,
    conservativeFallbackRatio: envRatio("RATE_LIMIT_CONSERVATIVE_RATIO", 0.5),
    ...overrides,
    routeGroups: {
      ...defaultRouteGroups,
      ...(overrides?.routeGroups || {}),
    },
  };
}

/**
 * Resolves the route group name from an incoming request path or baseUrl.
 */
export function resolveRouteGroup(pathOrUrl: string): RouteGroupName {
  const withoutQuery = pathOrUrl.split("?")[0] || "";
  const normalized = withoutQuery.toLowerCase().replace(/^\/api(\/v\d+)?/, "");
  const segment = normalized.split("/").filter(Boolean)[0] || "";

  switch (segment) {
    case "players":
      return "players";
    case "fixtures":
      return "fixtures";
    case "leagues":
      return "leagues";
    case "leaderboard":
      return "leaderboard";
    case "live":
      return "live";
    case "teams":
      return "teams";
    case "gameweeks":
      return "gameweeks";
    case "analytics":
      return "analytics";
    case "webhooks":
      return "webhooks";
    default:
      return "default";
  }
}
