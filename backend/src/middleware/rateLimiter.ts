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
 * General rate limiter for generic public API routes.
 * Protects platform resources from high-frequency automated scraping / DDoS attacks.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: parseInt(process.env.API_RATE_LIMIT_MAX || "100", 10), // Max 100 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    message: "Too many API requests from this IP. Please try again later.",
  },
});

