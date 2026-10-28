export interface RateLimitTierConfig {
  limit: number;
  windowMs: number;
  ipLimit?: number;
}

export interface RateLimitRouteGroup {
  name: string;
  prefixes: string[];
  tiers: {
    anonymous: RateLimitTierConfig;
    authenticated: RateLimitTierConfig;
    webhook: RateLimitTierConfig;
  };
}

const defaultTiers = {
  anonymous: { limit: 100, windowMs: 15 * 60 * 1000 },
  authenticated: { limit: 300, ipLimit: 600, windowMs: 15 * 60 * 1000 },
  webhook: { limit: 1200, ipLimit: 2400, windowMs: 15 * 60 * 1000 },
};

export const RATE_LIMIT_ROUTE_GROUPS: RateLimitRouteGroup[] = [
  {
    name: "live",
    prefixes: ["/api/live", "/api/v1/live"],
    tiers: {
      anonymous: { limit: 30, windowMs: 60 * 1000 },
      authenticated: { limit: 120, ipLimit: 240, windowMs: 60 * 1000 },
      webhook: { limit: 300, ipLimit: 600, windowMs: 60 * 1000 },
    },
  },
  {
    name: "players",
    prefixes: ["/api/players", "/api/v1/players"],
    tiers: {
      anonymous: { limit: 60, windowMs: 60 * 1000 },
      authenticated: { limit: 180, ipLimit: 360, windowMs: 60 * 1000 },
      webhook: { limit: 300, ipLimit: 600, windowMs: 60 * 1000 },
    },
  },
  {
    name: "fixtures",
    prefixes: ["/api/fixtures", "/api/v1/fixtures", "/api/gameweeks", "/api/v1/gameweeks"],
    tiers: {
      anonymous: { limit: 60, windowMs: 60 * 1000 },
      authenticated: { limit: 180, ipLimit: 360, windowMs: 60 * 1000 },
      webhook: { limit: 300, ipLimit: 600, windowMs: 60 * 1000 },
    },
  },
  {
    name: "leagues",
    prefixes: ["/api/leagues", "/api/v1/leagues"],
    tiers: {
      anonymous: { limit: 60, windowMs: 60 * 1000 },
      authenticated: { limit: 180, ipLimit: 360, windowMs: 60 * 1000 },
      webhook: { limit: 300, ipLimit: 600, windowMs: 60 * 1000 },
    },
  },
  {
    name: "default",
    prefixes: [],
    tiers: defaultTiers,
  },
];

export function getRateLimitRouteGroup(path: string): RateLimitRouteGroup {
  return (
    RATE_LIMIT_ROUTE_GROUPS.find(
      (group) =>
        group.prefixes.length > 0 &&
        group.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ) ?? RATE_LIMIT_ROUTE_GROUPS[RATE_LIMIT_ROUTE_GROUPS.length - 1]
  );
}

export function getRateLimitTier(
  path: string,
  authenticated: boolean,
  verifiedWebhook = false
): "anonymous" | "authenticated" | "webhook" {
  const webhookPath =
    path === "/api/webhooks" ||
    path.startsWith("/api/webhooks/") ||
    path === "/api/v1/webhooks" ||
    path.startsWith("/api/v1/webhooks/");
  if (webhookPath && verifiedWebhook) {
    return "webhook";
  }
  return authenticated ? "authenticated" : "anonymous";
}
