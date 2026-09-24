import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Request, Response } from "express";

/**
 * Standard 429 Error Response Formatter
 */
const createRateLimitHandler = (message: string) => (req: Request, res: Response) => {
  res.status(429).json({
    success: false,
    message,
    retryAfter: res.getHeader("Retry-After") || 60,
  });
};

/**
 * Rate Limiting and Abuse Prevention Middleware for FantasyXI API.
 *
 * 1. Auth Limiter: Protects authentication & registration endpoints from brute force.
 */
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "5", 10), // Max 5 login/register attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many authentication requests from this IP. Please try again after 15 minutes."),
});

/**
 * 2. Financial / Settlement / Payment Limiter:
 * Protects blockchain settlement and payment routes from transaction flooding and replay abuse.
 */
export const financialRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes window
  max: parseInt(process.env.FINANCIAL_RATE_LIMIT_MAX || "20", 10), // 20 financial operations per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many financial requests. Please wait before submitting additional transactions."),
});

/**
 * 3. Sync & Ingestion Limiter:
 * Protects heavy background sync and daemon polling trigger endpoints.
 */
export const syncRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.SYNC_RATE_LIMIT_MAX || "10", 10), // 10 sync triggers per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many sync requests. Rate limit reached."),
});

/**
 * 4. Squad & Transfer Limiter:
 * Prevents rapid transfer spam and race conditions during deadline periods.
 */
export const squadRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: parseInt(process.env.SQUAD_RATE_LIMIT_MAX || "30", 10), // 30 squad operations per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many squad modification requests. Please slow down."),
});

/**
 * 5. General API Limiter:
 * General fallback rate limiter for generic public API routes.
 */
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: parseInt(process.env.API_RATE_LIMIT_MAX || "100", 10), // Max 100 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  handler: createRateLimitHandler("Too many API requests from this IP. Please try again later."),
});
