import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";

/**
 * Rate Limiting and DDoS Mitigation Middleware for FantasyXI API.
 *
 * Strict limiter for sensitive authentication endpoints (login, register).
 * Prevents brute force password attacks.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "5", 10), // Max 5 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    message: "Too many authentication requests from this IP. Please try again after 15 minutes.",
  },
});

/**
 * General rate limiter for generic public API routes (issue #139).
 * Protects platform resources and the external FPL API polling paths from
 * high-frequency automated scraping / abuse: max 100 requests per minute,
 * per IP. Mounted globally in server.ts ahead of every route, so every
 * public-facing endpoint returns HTTP 429 once the limit is exceeded.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: parseInt(process.env.API_RATE_LIMIT_MAX || "100", 10), // Max 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    message: "Too many API requests from this IP. Please try again in a minute.",
  },
});

