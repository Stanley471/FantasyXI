import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";

function configuredLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRateLimiter(max: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, message },
  });
}

/**
 * Rate Limiting and DDoS Mitigation Middleware for FantasyXI API.
 *
 * Strict limiter for sensitive authentication endpoints (login, register).
 * Prevents brute force password attacks.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: configuredLimit("AUTH_RATE_LIMIT_MAX", 5), // Max 5 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    message: "Too many authentication requests from this IP. Please try again after 15 minutes.",
  },
});

/**
 * General rate limiter for generic public API routes.
 * Protects platform resources from high-frequency automated scraping / DDoS attacks.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: configuredLimit("API_RATE_LIMIT_MAX", 100), // Max 100 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    message: "Too many API requests from this IP. Please try again later.",
  },
});

/** Additional protection for requests that have passed authentication. */
export const authenticatedRateLimiter = createRateLimiter(
  configuredLimit("AUTHENTICATED_RATE_LIMIT_MAX", 60),
  "Too many authenticated API requests from this IP. Please try again later."
);

/** Lower limit for authenticated mutations that are more expensive or stateful. */
export const mutationRateLimiter = createRateLimiter(
  configuredLimit("MUTATION_RATE_LIMIT_MAX", 30),
  "Too many mutation requests from this IP. Please try again later."
);

